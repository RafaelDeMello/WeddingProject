import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inject } from 'vitest';
import { createApp } from '../src/app.js';
import { createPrisma, initDb, sqliteUrl } from '../src/db.js';
import { parseEnv } from '../src/env.js';
import { createLogger } from '../src/logger.js';

export const baseEnv: Record<string, string> = {
  NODE_ENV: 'test',
  PORT: '3000',
  TZ: 'America/Sao_Paulo',
  PUBLIC_BASE_URL: 'https://weddingrafessa.example.com',
  EVENT_SLUG: 'teste1',
  EVENT_NAME: 'Casamento de Teste',
  UPLOAD_OPENS_AT: '2026-01-01T00:00:00-03:00',
  UPLOAD_CLOSES_AT: '2099-12-31T23:59:59-03:00',
  GUEST_WINDOW_MINUTES: '10',
  GUEST_MAX_PER_WINDOW: '10',
  GUEST_MAX_TOTAL: '150',
  IP_MAX_UPLOADS_PER_WINDOW: '200',
  MAX_UPLOAD_BYTES: '8388608',
  MIN_FREE_DISK_MB: '0',
  SESSION_SECRET: 'a'.repeat(64),
  ADMIN_USER: 'admin',
  ADMIN_PASSWORD: 'senha-de-teste-123',
  DATA_DIR: '/tmp/unused',
  DATABASE_URL: 'file:/tmp/unused.db',
};

export const ORIGIN = baseEnv.PUBLIC_BASE_URL!;

/** Banco SQLite isolado (cópia do modelo já migrado) + app pronto para Supertest. */
export async function createTestContext(overrides: Record<string, string> = {}, opts: { now?: () => Date } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'weddingrafessa-test-'));
  const dbFile = path.join(dir, 'app.db');
  copyFileSync(inject('templateDb'), dbFile);

  const env = parseEnv({
    ...baseEnv,
    DATA_DIR: path.join(dir, 'data'),
    DATABASE_URL: sqliteUrl(dbFile),
    ...overrides,
  });
  const prisma = createPrisma(env.DATABASE_URL);
  const journalMode = await initDb(prisma);
  const app = createApp({ env, prisma, logger: createLogger('test'), now: opts.now });

  const cleanup = async () => {
    await prisma.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  };
  return { app, env, prisma, journalMode, cleanup };
}
