import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { sendError } from '../errors.js';
import { eventStatus } from '../event.js';
import { guestNameSchema } from '../guestName.js';
import { getQuota } from '../quota.js';
import { guestCreationLimiter } from '../rateLimit.js';
import { loadSessionGuest, setSessionCookie } from '../session.js';

const bodySchema = z.object({
  slug: z.string({ error: 'Link do evento inválido.' }).max(64, 'Link do evento inválido.'),
  name: guestNameSchema,
});

export function guestRoutes({ env, prisma, now }: AppDeps) {
  const router = Router();

  router.post('/api/guests', guestCreationLimiter(env), async (req, res) => {
    const body = bodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      const message = body.error.issues[0]?.message ?? 'Dados inválidos.';
      return sendError(res, 400, 'validation_error', message);
    }
    if (body.data.slug !== env.EVENT_SLUG) {
      return sendError(res, 404, 'event_not_found', 'Evento não encontrado.');
    }

    const at = now();
    const status = eventStatus(env, at);
    if (status !== 'open') {
      const message =
        status === 'not_open' ? 'O envio de fotos ainda não abriu.' : 'O envio de fotos já foi encerrado.';
      return sendError(res, 403, 'upload_closed', message);
    }

    // Recarregar a página ou tocar duas vezes não cria outro convidado.
    const existing = await loadSessionGuest(req, prisma);
    if (existing) {
      const quota = await getQuota(prisma, env, existing.id, at);
      return res.status(200).json({ guestId: existing.id, name: existing.name, quota });
    }

    const guest = await prisma.guest.create({
      data: {
        name: body.data.name,
        ipHash: req.ip ? createHash('sha256').update(req.ip + env.SESSION_SECRET).digest('hex') : null,
        userAgent: req.get('user-agent')?.slice(0, 255) ?? null,
      },
    });
    setSessionCookie(res, env, guest.id);
    const quota = await getQuota(prisma, env, guest.id, at);
    return res.status(201).json({ guestId: guest.id, name: guest.name, quota });
  });

  return router;
}
