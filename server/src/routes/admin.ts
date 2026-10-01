import path from 'node:path';
import express, { Router, type Response } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { adminAuth } from '../adminAuth.js';
import {
  ADMIN_DEFAULT_LIMIT,
  ADMIN_MAX_LIMIT,
  adminCounts,
  decodeCursor,
  listAdminPhotos,
  setPhotoHidden,
} from '../adminPhotos.js';
import { sendError, sendRateLimited } from '../errors.js';
import { resolveDataFile } from '../gallery.js';
import { fileStamp, streamPhotosZip } from '../zipExport.js';

/** Quanto o cliente deve esperar antes de tentar outra exportação quando já há uma em andamento. */
const EXPORT_RETRY_SECONDS = 30;

// server/admin-ui fica na mesma profundidade a partir de src/routes e de dist/routes.
const ADMIN_UI_DIR = path.resolve(import.meta.dirname, '../../admin-ui');

const listQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(ADMIN_MAX_LIMIT).default(ADMIN_DEFAULT_LIMIT),
});
const patchBody = z.strictObject({ hidden: z.boolean() });
const idSchema = z.uuid();

export function adminRoutes({ env, prisma, logger, now }: AppDeps) {
  const router = Router();
  // Tudo de /admin e /api/admin passa por aqui: no-store, limite de falhas e Basic Auth.
  router.use(['/admin', '/api/admin'], ...adminAuth(env));

  // --- Página de moderação (arquivos estáticos em server/admin-ui, sem script nem estilo inline) ---
  router.get(['/admin', '/admin/'], (_req, res) => {
    res.sendFile(path.join(ADMIN_UI_DIR, 'index.html'), { cacheControl: false });
  });
  router.use('/admin', express.static(ADMIN_UI_DIR, { index: false, redirect: false, dotfiles: 'ignore', cacheControl: false }));

  // --- Fotos: lista (com as ocultas), arquivos e ocultar/reexibir ---
  router.get('/api/admin/photos', async (req, res) => {
    const query = listQuery.safeParse(req.query);
    if (!query.success) return void sendError(res, 400, 'validation_error', 'Parâmetros inválidos.');
    let cursor = null;
    if (query.data.cursor !== undefined) {
      cursor = decodeCursor(query.data.cursor);
      if (!cursor) return void sendError(res, 400, 'invalid_cursor', 'Cursor inválido.');
    }
    const [page, counts] = await Promise.all([
      listAdminPhotos(prisma, { limit: query.data.limit, cursor }),
      adminCounts(prisma),
    ]);
    res.json({ ...page, counts });
  });

  /** Arquivo de qualquer foto (inclusive oculta). Inexistente, id inválido ou arquivo ausente → 404. */
  async function sendPhotoFile(kind: 'photo' | 'thumb', rawId: string, res: Response) {
    const notFound = () => void sendError(res, 404, 'not_found', 'Foto não encontrada.');
    const id = idSchema.safeParse(rawId);
    if (!id.success) return notFound();
    const photo = await prisma.photo.findUnique({
      where: { id: id.data },
      select: { filePath: true, thumbPath: true },
    });
    if (!photo) return notFound();
    const file = resolveDataFile(env.DATA_DIR, kind === 'thumb' ? photo.thumbPath : photo.filePath);
    if (!file) return notFound();
    // Cache-Control: no-store já foi definido pelo adminAuth; cacheControl:false não o sobrescreve.
    res.sendFile(file, { dotfiles: 'deny', cacheControl: false }, (err) => {
      if (err && !res.headersSent) notFound();
    });
  }
  router.get('/api/admin/photos/:id/thumb', (req, res) => sendPhotoFile('thumb', req.params.id, res));
  router.get('/api/admin/photos/:id', (req, res) => sendPhotoFile('photo', req.params.id, res));

  router.patch('/api/admin/photos/:id', async (req, res) => {
    const id = idSchema.safeParse(req.params.id);
    const body = patchBody.safeParse(req.body ?? {});
    if (!id.success) return void sendError(res, 404, 'not_found', 'Foto não encontrada.');
    if (!body.success) {
      return void sendError(res, 400, 'validation_error', 'Envie { "hidden": true | false }.');
    }
    const found = await setPhotoHidden(prisma, id.data, body.data.hidden, now());
    if (!found) return void sendError(res, 404, 'not_found', 'Foto não encontrada.');
    res.json({ id: id.data, hidden: body.data.hidden });
  });

  // --- Exportação em ZIP ---
  // Uma exportação por vez: ela lê milhares de arquivos numa VPS de 1 CPU, e assim um clique repetido
  // (ou alguém com a senha) não derruba o resto do app.
  let exporting = false;

  router.get('/api/admin/export.zip', async (req, res) => {
    if (exporting) {
      return void sendRateLimited(res, EXPORT_RETRY_SECONDS, 'Já existe uma exportação em andamento.', {
        code: 'export_in_progress',
        appendWait: false,
      });
    }
    exporting = true;

    const controller = new AbortController();
    // 'close' vem ao terminar e também se o cliente desconectar no meio.
    res.once('close', () => controller.abort());

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="weddingrafessa-fotos-${fileStamp(now())}.zip"`);
    const startedAt = Date.now();
    try {
      const summary = await streamPhotosZip({
        prisma,
        dataDir: env.DATA_DIR,
        output: res,
        signal: controller.signal,
        logger: req.log ?? logger,
      });
      (req.log ?? logger).info(
        { ...summary, aborted: controller.signal.aborted, ms: Date.now() - startedAt },
        'exportação do ZIP terminou',
      );
    } catch (err) {
      (req.log ?? logger).error({ err }, 'erro durante a exportação do ZIP');
      if (res.headersSent) {
        res.destroy(err as Error); // já começou a enviar: o download quebra (melhor que um ZIP truncado "válido")
      } else {
        res.removeHeader('Content-Disposition');
        res.type('json');
        sendError(res, 500, 'internal_error', 'Erro interno.');
      }
    } finally {
      exporting = false;
    }
  });

  return router;
}
