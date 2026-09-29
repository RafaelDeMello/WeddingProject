import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Com prisma.config.ts o Prisma não carrega .env sozinho. Em dev o .env fica na
// raiz do monorepo; no container as variáveis vêm do compose e o arquivo não existe.
const rootEnv = new URL('../.env', import.meta.url);
if (!process.env.DATABASE_URL && existsSync(rootEnv)) {
  process.loadEnvFile(rootEnv);
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
});
