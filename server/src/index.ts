import { createApp } from './app.js';
import { createPrisma, ensureDataDirs, initDb } from './db.js';
import { EnvError, parseEnv } from './env.js';
import { createLogger } from './logger.js';
import { cleanTmp } from './storage.js';

async function main() {
  let env;
  try {
    env = parseEnv(process.env);
  } catch (err) {
    if (err instanceof EnvError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger(env.NODE_ENV);
  await ensureDataDirs(env.DATA_DIR);
  await cleanTmp(env.DATA_DIR);
  const prisma = createPrisma(env.DATABASE_URL);
  const journalMode = await initDb(prisma);
  if (journalMode !== 'wal') logger.warn({ journalMode }, 'SQLite não está em modo WAL');

  const app = createApp({ env, prisma, logger });
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV, journalMode }, 'servidor iniciado');
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'encerrando');
    server.close(() => {
      void prisma.$disconnect().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
