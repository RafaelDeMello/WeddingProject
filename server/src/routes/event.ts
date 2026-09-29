import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { eventInfo } from '../event.js';

export function eventRoutes({ env, now }: AppDeps) {
  const router = Router();
  router.get('/api/event', (_req, res) => {
    res.json(eventInfo(env, now()));
  });
  return router;
}
