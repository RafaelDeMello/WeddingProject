import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

export const BUSY_TIMEOUT_MS = 5000;

export function createPrisma(databaseUrl: string): PrismaClient {
  return new PrismaClient({ datasourceUrl: databaseUrl });
}

/** Ativa WAL (persistente no arquivo) e busy_timeout. Retorna o journal_mode resultante. */
export async function initDb(prisma: PrismaClient): Promise<string> {
  const rows = await prisma.$queryRawUnsafe<{ journal_mode: string }[]>('PRAGMA journal_mode=WAL;');
  await prisma.$queryRawUnsafe(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS};`);
  return rows[0]?.journal_mode ?? 'unknown';
}

export const dataPaths = (dataDir: string) => ({
  db: path.join(dataDir, 'db'),
  photos: path.join(dataDir, 'photos'),
  thumbs: path.join(dataDir, 'thumbs'),
  tmp: path.join(dataDir, 'tmp'),
});

export async function ensureDataDirs(dataDir: string): Promise<void> {
  for (const dir of Object.values(dataPaths(dataDir))) {
    await mkdir(dir, { recursive: true });
  }
}

/** URL do Prisma para um arquivo SQLite (barras normais, também no Windows). */
export function sqliteUrl(file: string): string {
  return `file:${file.split(path.sep).join('/')}`;
}
