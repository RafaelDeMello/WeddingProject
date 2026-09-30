import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { KeyedMutex, Semaphore } from '../concurrency.js';
import { sendError, sendRateLimited } from '../errors.js';
import { closedMessage, eventStatus } from '../event.js';
import {
  assertAllowedImage,
  InvalidImageError,
  processImage,
  UnsupportedMediaError,
} from '../imageProcessing.js';
import { getQuota, quotaBlock, type QuotaBlock } from '../quota.js';
import { photoUploadLimiter } from '../rateLimit.js';
import { requireGuest } from '../session.js';
import { dayFolder, freeDiskMb, PhotoFiles } from '../storage.js';
import { photoUpload } from '../upload.js';

/** Decodificar imagem é o passo caro em memória/CPU (container de 1 CPU): no máximo 2 ao mesmo tempo. */
const MAX_CONCURRENT_PROCESSING = 2;

const bodySchema = z.strictObject({
  // Minúsculas: `ABC…` e `abc…` são o mesmo UUID e não podem virar duas fotos.
  clientUploadId: z.uuid().transform((v) => v.toLowerCase()),
});

type Outcome =
  | { kind: 'created'; id: string; quota: Awaited<ReturnType<typeof getQuota>> }
  | { kind: 'duplicate'; id: string; quota: Awaited<ReturnType<typeof getQuota>> }
  | { kind: 'blocked'; block: QuotaBlock };

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

export function photoRoutes({ env, prisma, now, statfs }: AppDeps) {
  const router = Router();
  const guestLock = new KeyedMutex();
  const processing = new Semaphore(MAX_CONCURRENT_PROCESSING);

  const requireOpenWindow: RequestHandler = (_req, res, next) => {
    const status = eventStatus(env, now());
    if (status !== 'open') return void sendError(res, 403, 'upload_closed', closedMessage(status));
    next();
  };

  const requireDiskSpace: RequestHandler = async (req, res, next) => {
    let freeMb: number;
    try {
      freeMb = await freeDiskMb(statfs, env.DATA_DIR);
    } catch (err) {
      // Falha ao medir não pode derrubar o envio das fotos.
      req.log.warn({ err }, 'não foi possível medir o espaço em disco');
      return next();
    }
    if (freeMb < env.MIN_FREE_DISK_MB) {
      req.log.error({ freeMb, minFreeMb: env.MIN_FREE_DISK_MB }, 'ALERTA: pouco espaço em disco, upload recusado');
      return void sendError(res, 507, 'insufficient_storage', 'O servidor está sem espaço no momento.');
    }
    next();
  };

  const findExisting = (guestId: string, clientUploadId: string) =>
    prisma.photo.findUnique({
      where: { guestId_clientUploadId: { guestId, clientUploadId } },
      select: { id: true },
    });

  router.post(
    '/api/photos',
    photoUploadLimiter(env),
    requireGuest(env, prisma),
    requireOpenWindow,
    requireDiskSpace,
    photoUpload(env),
    async (req, res) => {
      const guest = req.guest!;
      const file = req.file;
      if (!file) return void sendError(res, 400, 'missing_photo', 'Nenhuma foto foi enviada.');

      const body = bodySchema.safeParse({ ...req.body });
      if (!body.success) {
        return void sendError(res, 400, 'validation_error', 'Identificador de envio inválido.');
      }
      const { clientUploadId } = body.data;

      // Retry de um envio que já deu certo: responde sem processar e sem olhar a cota.
      const already = await findExisting(guest.id, clientUploadId);
      if (already) {
        const quota = await getQuota(prisma, env, guest.id, now());
        return void res.status(200).json({ id: already.id, quota });
      }

      // Fail fast: não gasta CPU decodificando a imagem de quem já estourou a cota.
      const early = quotaBlock(await getQuota(prisma, env, guest.id, now()), env, now());
      if (early) return void sendRateLimited(res, early.retryAfterSeconds, early.message, { code: early.code, appendWait: early.code === 'quota_exceeded' });

      let processed;
      try {
        await assertAllowedImage(file.buffer);
        processed = await processing.run(() => processImage(file.buffer));
      } catch (err) {
        if (err instanceof UnsupportedMediaError) {
          return void sendError(res, 415, 'unsupported_media_type', 'Envie uma foto JPEG, PNG ou WebP.');
        }
        if (err instanceof InvalidImageError) {
          req.log.warn({ reason: err.message }, 'imagem recusada');
          return void sendError(res, 422, 'invalid_image', 'Não foi possível ler essa imagem.');
        }
        throw err;
      }

      const files = new PhotoFiles(env.DATA_DIR);
      try {
        const photoId = randomUUID();
        const stored = await files.store(photoId, dayFolder(now()), processed.photo, processed.thumb);

        // Recheca e insere sob o lock do convidado: o Prisma abre transações DEFERRED no SQLite,
        // então sem o lock dois envios simultâneos poderiam contar a mesma cota.
        const outcome = await guestLock.run(guest.id, () =>
          prisma.$transaction(
            async (tx): Promise<Outcome> => {
              const dup = await tx.photo.findUnique({
                where: { guestId_clientUploadId: { guestId: guest.id, clientUploadId } },
                select: { id: true },
              });
              const at = now();
              if (dup) return { kind: 'duplicate', id: dup.id, quota: await getQuota(tx, env, guest.id, at) };

              const block = quotaBlock(await getQuota(tx, env, guest.id, at), env, at);
              if (block) return { kind: 'blocked', block };

              await tx.photo.create({
                data: {
                  id: photoId,
                  guestId: guest.id,
                  clientUploadId,
                  filePath: stored.filePath,
                  thumbPath: stored.thumbPath,
                  sizeBytes: processed.photo.length,
                  width: processed.width,
                  height: processed.height,
                  createdAt: at,
                },
              });
              return { kind: 'created', id: photoId, quota: await getQuota(tx, env, guest.id, at) };
            },
            { maxWait: 10_000, timeout: 10_000 },
          ),
        );

        if (outcome.kind === 'created') {
          files.commit();
          return void res.status(201).json({ id: outcome.id, quota: outcome.quota });
        }

        // Duplicata concorrente ou cota estourada na recheca: os arquivos gravados não valem.
        await files.discard();
        if (outcome.kind === 'duplicate') {
          return void res.status(200).json({ id: outcome.id, quota: outcome.quota });
        }
        const { block } = outcome;
        return void sendRateLimited(res, block.retryAfterSeconds, block.message, {
          code: block.code,
          appendWait: block.code === 'quota_exceeded',
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          await files.discard();
          const dup = await findExisting(guest.id, clientUploadId);
          if (dup) {
            const quota = await getQuota(prisma, env, guest.id, now());
            return void res.status(200).json({ id: dup.id, quota });
          }
        }
        throw err;
      } finally {
        // Qualquer saída sem commit (exceção incluída) não deixa arquivo órfão.
        await files.discard();
      }
    },
  );

  return router;
}
