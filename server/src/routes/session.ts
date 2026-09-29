import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { getQuota } from '../quota.js';
import { clearSessionCookie, requireGuest } from '../session.js';

export function sessionRoutes({ env, prisma, now }: AppDeps) {
  const router = Router();

  router.get('/api/me', requireGuest(env, prisma), async (req, res) => {
    const guest = req.guest!;
    const quota = await getQuota(prisma, env, guest.id, now());
    res.json({ guestId: guest.id, name: guest.name, quota });
  });

  // "Não é você?" — outra pessoa usando o mesmo celular. Idempotente.
  router.post('/api/session/logout', (_req, res) => {
    clearSessionCookie(res, env);
    res.json({ ok: true });
  });

  return router;
}
