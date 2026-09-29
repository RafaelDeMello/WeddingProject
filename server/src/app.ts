import express from 'express';
import type { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { Env } from './env.js';
import { errorHandler, notFound } from './errors.js';

export interface AppDeps {
  env: Env;
  prisma: PrismaClient;
  logger: Logger;
}

export function createApp({ logger }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use((req, _res, next) => {
    req.log = logger;
    next();
  });
  app.use(express.json({ limit: '10kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use('/api', notFound);
  app.use(errorHandler);
  return app;
}
