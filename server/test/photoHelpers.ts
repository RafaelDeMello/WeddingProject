import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterEach, expect } from 'vitest';
import { dataPaths } from '../src/db.js';
import type { StatFs } from '../src/storage.js';
import { createTestContext, ORIGIN } from './helpers.js';

export type Ctx = Awaited<ReturnType<typeof createTestContext>>;

export const WINDOW = {
  UPLOAD_OPENS_AT: '2026-10-03T00:00:00-03:00',
  UPLOAD_CLOSES_AT: '2026-10-06T23:59:59-03:00',
};
export const T0 = new Date('2026-10-04T20:00:00-03:00');


export interface SetupOptions {
  env?: Record<string, string>;
  now?: () => Date;
  statfs?: StatFs;
}

/** Registra o cleanup no afterEach e devolve o `setup` que cria o contexto isolado do teste. */
export function useContext() {
  let ctx: Ctx | undefined;
  afterEach(async () => {
    await ctx?.cleanup();
    ctx = undefined;
  });
  return async (opts: SetupOptions = {}) => {
    ctx = await createTestContext({ ...WINDOW, ...opts.env }, { now: opts.now ?? (() => T0), statfs: opts.statfs });
    return ctx;
  };
}

/** Cria um convidado e devolve o cookie assinado. */
export async function signIn(c: Ctx, name = 'Ana', ip = '203.0.113.10') {
  const res = await request(c.app)
    .post('/api/guests')
    .set('Origin', ORIGIN)
    .set('X-Forwarded-For', ip)
    .send({ slug: c.env.EVENT_SLUG, name });
  expect(res.status).toBe(201);
  return { guestId: res.body.guestId as string, cookie: res.headers['set-cookie']![0]!.split(';')[0]! };
}

export interface UploadOptions {
  cookie?: string;
  id?: string;
  ip?: string;
  origin?: string | null;
  filename?: string;
  contentType?: string;
  field?: string;
}

export function upload(c: Ctx, body: Buffer | null, o: UploadOptions = {}) {
  const req = request(c.app).post('/api/photos');
  if (o.origin !== null) req.set('Origin', o.origin ?? ORIGIN);
  if (o.cookie) req.set('Cookie', o.cookie);
  if (o.ip) req.set('X-Forwarded-For', o.ip);
  if (o.id !== undefined) req.field('clientUploadId', o.id);
  if (body) {
    req.attach(o.field ?? 'photo', body, { filename: o.filename ?? 'foto.jpg', contentType: o.contentType ?? 'image/jpeg' });
  }
  return req;
}

export const uploadOk = (c: Ctx, body: Buffer, cookie: string, id: string = randomUUID(), extra: UploadOptions = {}) =>
  upload(c, body, { cookie, id, ...extra });

export function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name));
}

/** Estado do disco: tmp/ vazio e cada foto/thumb do disco corresponde a um registro (sem órfãos). */
export async function expectDiskConsistent(c: Ctx, expectedPhotos: number) {
  const dirs = dataPaths(c.env.DATA_DIR);
  expect(listFiles(dirs.tmp)).toEqual([]);
  const rows = await c.prisma.photo.findMany();
  expect(rows).toHaveLength(expectedPhotos);
  const onDisk = [...listFiles(dirs.photos), ...listFiles(dirs.thumbs)].map((f) => path.relative(c.env.DATA_DIR, f).split(path.sep).join('/'));
  const expected = rows.flatMap((r) => [r.filePath, r.thumbPath]);
  expect(onDisk.sort()).toEqual(expected.sort());
}

