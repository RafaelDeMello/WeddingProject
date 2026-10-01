import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { TestProject } from 'vitest/node';
import { sqliteUrl } from '../src/db.js';
import { removeTempDir } from './cleanup.js';

declare module 'vitest' {
  export interface ProvidedContext {
    templateDb: string;
    /** Build real do front (vite build) numa pasta temporária. */
    webDist: string;
  }
}

// Aplica as migrações uma única vez num banco-modelo (cada teste copia o arquivo) e compila o front.
export default function setup(project: TestProject) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'weddingrafessa-template-'));
  const dbFile = path.join(dir, 'template.db');
  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');

  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, DATABASE_URL: sqliteUrl(dbFile) },
    stdio: 'pipe',
  });
  project.provide('templateDb', dbFile);

  // Build real do front: os testes do SPA/CSP olham exatamente o que iria para a imagem Docker.
  const webDist = path.join(dir, 'web-dist');
  // O pacote não exporta bin/vite.js; o caminho vem do package.json (exportado) do próprio vite.
  const viteCli = path.join(path.dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin/vite.js');
  execFileSync(process.execPath, [viteCli, 'build', '--outDir', webDist, '--emptyOutDir'], {
    cwd: path.resolve(import.meta.dirname, '../../web'),
    stdio: 'pipe',
  });
  project.provide('webDist', webDist);

  return () => removeTempDir(dir);
}
