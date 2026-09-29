import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { TestProject } from 'vitest/node';
import { sqliteUrl } from '../src/db.js';

declare module 'vitest' {
  export interface ProvidedContext {
    templateDb: string;
  }
}

// Aplica as migrações uma única vez num banco-modelo; cada teste copia esse arquivo.
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

  return () => rmSync(dir, { recursive: true, force: true });
}
