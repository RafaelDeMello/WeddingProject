import { Router, type Response } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { sendError } from '../errors.js';
import {
  decodeCursor,
  deleteOwnPhoto,
  GALLERY_DEFAULT_LIMIT,
  GALLERY_MAX_LIMIT,
  galleryUpdates,
  listGallery,
  resolveDataFile,
} from '../gallery.js';
import { galleryLimiter } from '../rateLimit.js';
import { requireGuest } from '../session.js';

const listQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(GALLERY_MAX_LIMIT).default(GALLERY_DEFAULT_LIMIT),
});

const updatesQuery = z.object({
  // ISO 8601 com offset ou "Z" (é o que o serverTime devolve).
  since: z.iso.datetime({ offset: true }).transform((v) => new Date(v)),
});

const idSchema = z.uuid();

/** Convidados não guardam cópia: a foto pode ser ocultada a qualquer momento, então cache só curto e privado. */
const FILE_CACHE_CONTROL = 'private, max-age=60';

export function galleryRoutes({ env, prisma, now }: AppDeps) {
  const router = Router();
  router.use('/api/gallery', galleryLimiter(env), requireGuest(env, prisma));

  router.get('/api/gallery', async (req, res) => {
    const query = listQuery.safeParse(req.query);
    if (!query.success) return void sendError(res, 400, 'validation_error', 'Parâmetros inválidos.');

    let cursor = null;
    if (query.data.cursor !== undefined) {
      cursor = decodeCursor(query.data.cursor);
      if (!cursor) return void sendError(res, 400, 'invalid_cursor', 'Cursor inválido.');
    }

    const serverTime = now(); // antes da consulta: nada que aconteça durante ela fica fora do próximo "since"
    const page = await listGallery(prisma, req.guest!.id, { limit: query.data.limit, cursor });
    res.json({ ...page, serverTime: serverTime.toISOString() });
  });

  router.get('/api/gallery/updates', async (req, res) => {
    const query = updatesQuery.safeParse(req.query);
    if (!query.success) {
      return void sendError(res, 400, 'validation_error', 'Informe "since" como data ISO 8601.');
    }
    const serverTime = now();
    res.json(await galleryUpdates(prisma, req.guest!.id, query.data.since, serverTime));
  });

  /** Foto visível → arquivo; oculta, inexistente ou sem arquivo → 404 (nunca revela qual dos três). */
  async function sendPhotoFile(kind: 'photo' | 'thumb', rawId: string, res: Response) {
    const notFound = () => void sendError(res, 404, 'not_found', 'Foto não encontrada.');
    const id = idSchema.safeParse(rawId);
    if (!id.success) return notFound();

    // Sempre consulta o banco, inclusive em requisições condicionais (304): ocultar vale na hora.
    const photo = await prisma.photo.findFirst({
      where: { id: id.data, hiddenAt: null },
      select: { filePath: true, thumbPath: true },
    });
    if (!photo) return notFound();

    const file = resolveDataFile(env.DATA_DIR, kind === 'thumb' ? photo.thumbPath : photo.filePath);
    if (!file) return notFound();

    res.setHeader('Cache-Control', FILE_CACHE_CONTROL);
    res.vary('Cookie');
    res.sendFile(file, { dotfiles: 'deny', cacheControl: false }, (err) => {
      if (err && !res.headersSent) {
        res.removeHeader('Cache-Control'); // o 404 não pode ficar em cache
        notFound();
      }
    });
  }

  /**
   * Apagar a própria foto. Foto de outro convidado, inexistente ou id inválido: o mesmo 404, para não
   * revelar que a foto existe. Vale também depois do fim da janela de upload (enquanto a sessão existir).
   */
  router.delete('/api/gallery/photos/:id', async (req, res) => {
    const id = idSchema.safeParse(req.params.id);
    const deleted = id.success && (await deleteOwnPhoto(prisma, req.guest!.id, id.data, now()));
    if (!deleted) return void sendError(res, 404, 'not_found', 'Foto não encontrada.');
    res.status(204).end();
  });

  router.get('/api/gallery/photos/:id/thumb', (req, res) => sendPhotoFile('thumb', req.params.id, res));
  router.get('/api/gallery/photos/:id', (req, res) => sendPhotoFile('photo', req.params.id, res));

  return router;
}
