import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

export const BUSY_TIMEOUT_MS = 5000;

/**
 * SQLite tem um único escritor: com uma só conexão, o busy_timeout (por conexão) sempre vale
 * e as transações da cota não disputam o arquivo entre si.
 */
export function withConnectionLimit(databaseUrl: string): string {
  if (/[?&]connection_limit=/.test(databaseUrl)) return databaseUrl;
  return `${databaseUrl}${databaseUrl.includes('?') ? '&' : '?'}connection_limit=1`;
}

export function createPrisma(databaseUrl: string): PrismaClient {
  return new PrismaClient({ datasourceUrl: withConnectionLimit(databaseUrl) });
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
