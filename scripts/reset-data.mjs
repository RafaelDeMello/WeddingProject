#!/usr/bin/env node
/**
 * reset-data — apaga as fotos e os convidados de TESTE antes do evento.
 *
 * O que faz:  esvazia data/photos, data/thumbs e data/tmp e zera as tabelas Photo e Guest.
 * O que NÃO faz:  não apaga o arquivo do banco, o schema nem as migrações (a API continua subindo).
 *
 * Use com a API PARADA (docker compose stop), num container avulso com o mesmo volume:
 *   docker compose run --rm --no-deps weddingrafessa node /app/scripts/reset-data.mjs
 *
 * Pede confirmação interativa (digitar APAGAR). `--yes` pula a pergunta, mas só fora de produção.
 */
import { existsSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const here = path.dirname(fileURLToPath(import.meta.url));
const CONFIRM_WORD = 'APAGAR';
const DATA_SUBDIRS = ['photos', 'thumbs', 'tmp'];

function fail(message, code = 2) {
  console.error(`Erro: ${message}`);
  process.exit(code);
}

// Em desenvolvimento as variáveis ficam no .env da raiz; no container vêm do compose.
const rootEnv = path.resolve(here, '..', '.env');
if (!process.env.DATABASE_URL && existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const args = new Set(process.argv.slice(2));
const unknown = [...args].filter((a) => a !== '--yes');
if (unknown.length > 0) fail(`argumento desconhecido: ${unknown.join(' ')}\nUso: reset-data.mjs [--yes]`);
const assumeYes = args.has('--yes');

if (!process.env.DATA_DIR) fail('DATA_DIR não definido.');
if (!process.env.DATABASE_URL) fail('DATABASE_URL não definido.');
if (assumeYes && process.env.NODE_ENV === 'production') {
  fail('--yes não é permitido com NODE_ENV=production. Rode sem --yes e digite a confirmação.');
}

// DATA_DIR relativo vale a partir de server/ (como no `npm run dev`).
const dataDir = path.resolve(path.resolve(here, '..', 'server'), process.env.DATA_DIR);
if (path.parse(dataDir).root === dataDir) fail(`DATA_DIR inválido: ${dataDir}`);
if (!DATA_SUBDIRS.concat('db').some((d) => existsSync(path.join(dataDir, d)))) {
  fail(`${dataDir} não parece um diretório de dados do app (sem db/, photos/, thumbs/).`);
}

async function folderStats(dir) {
  let files = 0;
  let bytes = 0;
  if (!existsSync(dir)) return { files, bytes };
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await folderStats(full);
      files += sub.files;
      bytes += sub.bytes;
    } else {
      files += 1;
      bytes += (await stat(full)).size;
    }
  }
  return { files, bytes };
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.once('close', () => resolve(null)); // entrada encerrada sem resposta = não confirmou
    rl.question(question, (answer) => {
      resolve(answer.trim()); // antes do close: o evento 'close' resolveria com null
      rl.close();
    });
  });
}

const prisma = new PrismaClient();
try {
  const [photos, guests] = await Promise.all([prisma.photo.count(), prisma.guest.count()]);
  const folders = {};
  for (const name of DATA_SUBDIRS) folders[name] = await folderStats(path.join(dataDir, name));

  console.log('\n=== reset-data: isto vai APAGAR ===');
  console.log(`Diretório de dados: ${dataDir}`);
  console.log(`Banco: ${photos} foto(s) e ${guests} convidado(s) (as tabelas ficam, vazias)`);
  for (const name of DATA_SUBDIRS) {
    console.log(`  ${name}/: ${folders[name].files} arquivo(s), ${mb(folders[name].bytes)}`);
  }
  console.log('');

  if (!assumeYes) {
    const answer = await ask(`Digite ${CONFIRM_WORD} para confirmar (qualquer outra coisa cancela): `);
    if (answer !== CONFIRM_WORD) {
      console.log('Cancelado. Nada foi apagado.');
      process.exitCode = 1;
    }
  }

  if (process.exitCode !== 1) {
    for (const name of DATA_SUBDIRS) {
      const dir = path.join(dataDir, name);
      if (!existsSync(dir)) continue;
      for (const entry of await readdir(dir)) await rm(path.join(dir, entry), { recursive: true, force: true });
    }
    await prisma.photo.deleteMany(); // antes de Guest (chave estrangeira)
    await prisma.guest.deleteMany();
    await prisma.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE);').catch(() => undefined);
    await prisma.$executeRawUnsafe('VACUUM;').catch(() => undefined);
    console.log('Pronto: fotos, miniaturas, convidados e arquivos temporários apagados.');
  }
} finally {
  await prisma.$disconnect();
}
