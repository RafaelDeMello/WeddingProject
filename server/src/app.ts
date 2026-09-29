import cookieParser from 'cookie-parser';
import express from 'express';
import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { Env } from './env.js';
import { errorHandler, notFound } from './errors.js';
import { httpLogger } from './logger.js';
import { eventRoutes } from './routes/event.js';
import { guestRoutes } from './routes/guests.js';
import { sessionRoutes } from './routes/session.js';
import { originCheck, securityHeaders } from './security.js';

export interface AppDeps {
  env: Env;
  prisma: PrismaClient;
  logger: Logger;
  /** Relógio injetável para os testes de janela de upload. */
  now: () => Date;
}

export function createApp(deps: Omit<AppDeps, 'now'> & { now?: () => Date }) {
  const full: AppDeps = { ...deps, now: deps.now ?? (() => new Date()) };
  const { env, logger } = full;

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(httpLogger(logger));
  app.use(securityHeaders(env));
  app.use(cookieParser(env.SESSION_SECRET));
  app.use('/api', originCheck(env));
  app.use(express.json({ limit: '10kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.use(eventRoutes(full));
  app.use(guestRoutes(full));
  app.use(sessionRoutes(full));

  app.use('/api', notFound);
  app.use(errorHandler);
  return app;
}
