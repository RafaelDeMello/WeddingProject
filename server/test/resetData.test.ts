import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, inject, it } from 'vitest';
import { sqliteUrl } from '../src/db.js';
import { removeTempDir } from './cleanup.js';

const script = path.resolve(import.meta.dirname, '../../scripts/reset-data.mjs');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeTempDir(d);
});

/** Diretório de dados de mentira, com um banco migrado, 2 convidados, 2 fotos e arquivos. */
async function makeData() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'weddingrafessa-reset-'));
  dirs.push(root);
  for (const d of ['db', 'photos/2026-10-03', 'thumbs', 'tmp']) mkdirSync(path.join(root, d), { recursive: true });
  const dbFile = path.join(root, 'db', 'app.db');
  copyFileSync(inject('templateDb'), dbFile);

  const prisma = new PrismaClient({ datasourceUrl: sqliteUrl(dbFile) });
  const a = await prisma.guest.create({ data: { name: 'Ana' } });
  const b = await prisma.guest.create({ data: { name: 'Bia' } });
  for (const [i, g] of [a, b].entries()) {
    await prisma.photo.create({
      data: {
        guestId: g.id,
        clientUploadId: `c${i}`,
        filePath: `photos/2026-10-03/${i}.jpg`,
        thumbPath: `thumbs/${i}.jpg`,
        sizeBytes: 10,
        width: 1,
        height: 1,
      },
    });
    writeFileSync(path.join(root, `photos/2026-10-03/${i}.jpg`), 'x'.repeat(1000));
    writeFileSync(path.join(root, `thumbs/${i}.jpg`), 'x'.repeat(100));
  }
  writeFileSync(path.join(root, 'tmp/sobra.part'), 'x');
  await prisma.$disconnect();
  return { root, dbFile };
}

const counts = async (dbFile: string) => {
  const prisma = new PrismaClient({ datasourceUrl: sqliteUrl(dbFile) });
  try {
    return { guests: await prisma.guest.count(), photos: await prisma.photo.count() };
  } finally {
    await prisma.$disconnect();
  }
};

const filesLeft = (root: string) =>
  ['photos', 'thumbs', 'tmp'].flatMap((d) =>
    readdirSync(path.join(root, d), { recursive: true, withFileTypes: true }).filter((e) => e.isFile()),
  ).length;

function run(root: string, dbFile: string, args: string[], input: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    input,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', DATA_DIR: root, DATABASE_URL: sqliteUrl(dbFile), ...env },
    timeout: 60_000,
  });
}

describe('scripts/reset-data.mjs', () => {
  it('mostra o que vai apagar e, ao digitar APAGAR, zera fotos, miniaturas, tmp e tabelas', async () => {
    const { root, dbFile } = await makeData();
    const res = run(root, dbFile, [], 'APAGAR\n');

    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('2 foto(s) e 2 convidado(s)');
    expect(res.stdout).toMatch(/photos\/: 2 arquivo\(s\)/);
    expect(res.stdout).toContain('Pronto');
    expect(filesLeft(root)).toBe(0);
    expect(await counts(dbFile)).toEqual({ guests: 0, photos: 0 });
    // As pastas e o banco continuam: a API sobe normalmente depois do reset.
    for (const d of ['db', 'photos', 'thumbs', 'tmp']) expect(existsSync(path.join(root, d))).toBe(true);
    expect(existsSync(dbFile)).toBe(true);
  });

  it.each([
    ['resposta errada', 'sim\n'],
    ['minúsculas', 'apagar\n'],
    ['entrada vazia', '\n'],
    ['entrada encerrada sem resposta', ''],
  ])('%s → cancela (código 1) e não apaga nada', async (_label, input) => {
    const { root, dbFile } = await makeData();
    const res = run(root, dbFile, [], input);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('Cancelado');
    expect(filesLeft(root)).toBe(5);
    expect(await counts(dbFile)).toEqual({ guests: 2, photos: 2 });
  });

  it('--yes fora de produção apaga sem perguntar', async () => {
    const { root, dbFile } = await makeData();
    const res = run(root, dbFile, ['--yes'], '');
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).not.toContain('Digite APAGAR');
    expect(filesLeft(root)).toBe(0);
    expect(await counts(dbFile)).toEqual({ guests: 0, photos: 0 });
  });

  it('--yes com NODE_ENV=production é recusado e não apaga nada', async () => {
    const { root, dbFile } = await makeData();
    const res = run(root, dbFile, ['--yes'], '', { NODE_ENV: 'production' });
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/--yes não é permitido.*production/);
    expect(filesLeft(root)).toBe(5);
    expect(await counts(dbFile)).toEqual({ guests: 2, photos: 2 });
  });

  it('em produção sem --yes a confirmação interativa funciona normalmente', async () => {
    const { root, dbFile } = await makeData();
    const res = run(root, dbFile, [], 'APAGAR\n', { NODE_ENV: 'production' });
    expect(res.status, res.stderr).toBe(0);
    expect(filesLeft(root)).toBe(0);
  });

  it('diretório que não parece de dados do app → recusa', async () => {
    const { dbFile } = await makeData();
    const empty = mkdtempSync(path.join(os.tmpdir(), 'weddingrafessa-empty-'));
    dirs.push(empty);
    writeFileSync(path.join(empty, 'importante.txt'), 'não apague');
    const res = run(empty, dbFile, [], 'APAGAR\n');
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('não parece um diretório de dados');
    expect(existsSync(path.join(empty, 'importante.txt'))).toBe(true);
  });

  it('sem DATA_DIR ou com argumento desconhecido → erro', async () => {
    const { root, dbFile } = await makeData();
    expect(run(root, dbFile, [], '', { DATA_DIR: '' }).status).toBe(2);
    expect(run(root, dbFile, ['--tudo'], 'APAGAR\n').status).toBe(2);
    expect(filesLeft(root)).toBe(5);
  });
});
