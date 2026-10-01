import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import * as fx from './fixtures.js';
import { baseEnv, ORIGIN } from './helpers.js';
import { signIn, T0, type Ctx, uploadOk, useContext } from './photoHelpers.js';
import { listZip } from './zipReader.js';

const setup = useContext();
const AUTH = `Basic ${Buffer.from(`${baseEnv.ADMIN_USER}:${baseEnv.ADMIN_PASSWORD}`).toString('base64')}`;
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

const adminGet = (c: Ctx, url: string) => request(c.app).get(url).set('Authorization', AUTH);
const patch = (c: Ctx, id: string, body: unknown, opts: { origin?: string | null; auth?: string | null } = {}) => {
  const req = request(c.app).patch(`/api/admin/photos/${id}`);
  if (opts.origin !== null) req.set('Origin', opts.origin ?? ORIGIN);
  if (opts.auth !== null) req.set('Authorization', opts.auth ?? AUTH);
  return req.send(body as object);
};
const guestGet = (c: Ctx, url: string, cookie: string) => request(c.app).get(url).set('Cookie', cookie);

/** Convidadas Ana e Bia e uma foto de verdade da Ana. Relógio controlável. */
async function scene() {
  const clock = { now: T0 };
  const c = await setup({ now: () => clock.now });
  const ana = await signIn(c, 'Ana');
  const bia = await signIn(c, 'Bia');
  const sent = await uploadOk(c, await fx.jpeg(), ana.cookie);
  expect(sent.status).toBe(201);
  return { c, clock, ana, bia, id: sent.body.id as string };
}

async function seedRows(c: Ctx, guestId: string, rows: { createdAt: Date; hiddenAt?: Date | null }[]) {
  const data = rows.map((r) => {
    const id = randomUUID();
    return {
      id,
      guestId,
      clientUploadId: randomUUID(),
      filePath: `photos/x/${id}.jpg`,
      thumbPath: `thumbs/${id}.jpg`,
      sizeBytes: 1,
      width: 1,
      height: 1,
      createdAt: r.createdAt,
      hiddenAt: r.hiddenAt ?? null,
      visibilityChangedAt: r.hiddenAt ?? null,
    };
  });
  await c.prisma.photo.createMany({ data });
  return data.map((d) => d.id);
}

describe('autenticação das rotas de fotos do admin', () => {
  it.each([
    ['GET', '/api/admin/photos'],
    ['GET', `/api/admin/photos/${randomUUID()}`],
    ['GET', `/api/admin/photos/${randomUUID()}/thumb`],
  ])('%s %s sem credenciais → 401', async (_m, url) => {
    const c = await setup();
    expect((await request(c.app).get(url)).status).toBe(401);
  });

  it('PATCH sem credenciais → 401 (com Origin válido); credenciais erradas → 401; nada é alterado', async () => {
    const { c, id } = await scene();
    expect((await patch(c, id, { hidden: true }, { auth: null })).status).toBe(401);
    const wrong = `Basic ${Buffer.from('admin:errada').toString('base64')}`;
    expect((await patch(c, id, { hidden: true }, { auth: wrong })).status).toBe(401);
    expect((await c.prisma.photo.findUniqueOrThrow({ where: { id } })).hiddenAt).toBeNull();
  });

  it.each([
    ['ausente', null],
    ['de outro domínio', 'https://evil.example'],
  ])('PATCH com Origin %s → 403 invalid_origin, mesmo com a senha certa (CSRF); nada é alterado', async (_label, origin) => {
    const { c, id } = await scene();
    const res = await patch(c, id, { hidden: true }, { origin });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('invalid_origin');
    expect((await c.prisma.photo.findUniqueOrThrow({ where: { id } })).hiddenAt).toBeNull();
  });
});

describe('GET /api/admin/photos', () => {
  it('lista TODAS (ocultas incluídas), mais recentes primeiro, com hidden, nome, contagens e URLs do admin', async () => {
    const c = await setup();
    const ana = await c.prisma.guest.create({ data: { name: 'Ana <b>Lúcia</b>' } });
    const [old, hidden, recent] = await seedRows(c, ana.id, [
      { createdAt: at(-30) },
      { createdAt: at(-20), hiddenAt: at(-1) },
      { createdAt: at(-10) },
    ]);
    const res = await adminGet(c, '/api/admin/photos');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([recent, hidden, old]);
    expect(res.body.items[1]).toEqual({
      id: hidden,
      guestName: 'Ana <b>Lúcia</b>', // devolvido como veio; quem exibe usa textContent
      createdAt: at(-20).toISOString(),
      hidden: true,
      thumbUrl: `/api/admin/photos/${hidden}/thumb`,
      photoUrl: `/api/admin/photos/${hidden}`,
    });
    expect(res.body.items.map((i: { hidden: boolean }) => i.hidden)).toEqual([false, true, false]);
    expect(res.body.nextCursor).toBeNull();
    expect(res.body.counts).toEqual({ total: 3, hidden: 1 });
  });

  it('paginação com 130 fotos (limit=60 → 60, 60, 10) sem repetir nem pular; contagem em todas as páginas', async () => {
    const c = await setup();
    const ana = await c.prisma.guest.create({ data: { name: 'Ana' } });
    const order = await seedRows(c, ana.id, Array.from({ length: 130 }, (_, i) => ({ createdAt: new Date(at(-300).getTime() + i * 1000), hiddenAt: i % 7 === 0 ? at(-1) : null })));
    const seen: string[] = [];
    const sizes: number[] = [];
    let cursor: string | null = null;
    do {
      const res = await adminGet(c, `/api/admin/photos?limit=60${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.status).toBe(200);
      expect(res.body.counts.total).toBe(130);
      sizes.push(res.body.items.length);
      seen.push(...res.body.items.map((i: { id: string }) => i.id));
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(sizes).toEqual([60, 60, 10]);
    expect(seen).toEqual([...order].reverse());
  });

  it('limite padrão 60, máximo 100; inválidos → 400; cursor inválido → 400 invalid_cursor', async () => {
    const c = await setup();
    const ana = await c.prisma.guest.create({ data: { name: 'Ana' } });
    await seedRows(c, ana.id, Array.from({ length: 120 }, (_, i) => ({ createdAt: new Date(at(-300).getTime() + i * 1000) })));
    expect((await adminGet(c, '/api/admin/photos')).body.items).toHaveLength(60);
    expect((await adminGet(c, '/api/admin/photos?limit=100')).body.items).toHaveLength(100);
    for (const bad of ['0', '101', 'abc', '1.5', '-1']) {
      expect((await adminGet(c, `/api/admin/photos?limit=${bad}`)).status, bad).toBe(400);
    }
    const res = await adminGet(c, '/api/admin/photos?cursor=lixo');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_cursor');
  });

  it('banco vazio → items [] e contagens zeradas', async () => {
    const c = await setup();
    const res = await adminGet(c, '/api/admin/photos');
    expect(res.body).toEqual({ items: [], nextCursor: null, counts: { total: 0, hidden: 0 } });
  });
});

describe('arquivos pelo admin (inclusive de fotos ocultas)', () => {
  it('foto e miniatura saem com os bytes do disco, também as ocultas, sem cache', async () => {
    const { c, id } = await scene();
    await c.prisma.photo.update({ where: { id }, data: { hiddenAt: at(1), visibilityChangedAt: at(1) } });
    const photo = await c.prisma.photo.findUniqueOrThrow({ where: { id } });
    for (const [url, rel] of [
      [`/api/admin/photos/${id}`, photo.filePath],
      [`/api/admin/photos/${id}/thumb`, photo.thumbPath],
    ] as const) {
      const res = await adminGet(c, url)
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (d: Buffer) => chunks.push(d));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        });
      expect(res.status, url).toBe(200);
      expect(res.headers['content-type']).toBe('image/jpeg');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(Buffer.compare(res.body as Buffer, readFileSync(path.join(c.env.DATA_DIR, rel)))).toBe(0);
    }
  });

  it.each([
    ['uuid inexistente', randomUUID()],
    ['id que não é uuid', 'nao-e-uuid'],
  ])('%s → 404', async (_label, id) => {
    const c = await setup();
    expect((await adminGet(c, `/api/admin/photos/${id}`)).status).toBe(404);
    expect((await adminGet(c, `/api/admin/photos/${id}/thumb`)).status).toBe(404);
  });

  it('arquivo ausente do disco → 404; caminho do banco fora de DATA_DIR nunca é servido', async () => {
    const { c, id } = await scene();
    const photo = await c.prisma.photo.findUniqueOrThrow({ where: { id } });
    rmSync(path.join(c.env.DATA_DIR, photo.thumbPath));
    expect((await adminGet(c, `/api/admin/photos/${id}/thumb`)).status).toBe(404);

    writeFileSync(path.join(c.env.DATA_DIR, '..', 'segredo.txt'), 'SEGREDO');
    await c.prisma.photo.update({ where: { id }, data: { filePath: '../segredo.txt' } });
    const res = await adminGet(c, `/api/admin/photos/${id}`);
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('SEGREDO');
  });
});

describe('PATCH /api/admin/photos/:id — ocultar e reexibir', () => {
  it('ocultar → 200 { id, hidden: true }; grava hiddenAt e visibilityChangedAt (mesmo instante); some da galeria dos convidados', async () => {
    const { c, clock, ana, bia, id } = await scene();
    clock.now = at(5);
    const res = await patch(c, id, { hidden: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id, hidden: true });
    expect(res.headers['cache-control']).toBe('no-store');

    const photo = await c.prisma.photo.findUniqueOrThrow({ where: { id } });
    expect(photo.hiddenAt).toEqual(at(5));
    expect(photo.visibilityChangedAt).toEqual(at(5));

    for (const cookie of [ana.cookie, bia.cookie]) {
      expect((await guestGet(c, '/api/gallery', cookie)).body.items).toEqual([]);
      expect((await guestGet(c, `/api/gallery/photos/${id}`, cookie)).status).toBe(404);
      expect((await guestGet(c, `/api/gallery/photos/${id}/thumb`, cookie)).status).toBe(404);
      const up = await guestGet(c, `/api/gallery/updates?since=${encodeURIComponent(T0.toISOString())}`, cookie);
      expect(up.body.removedIds).toEqual([id]);
      expect(up.body.added).toEqual([]);
    }
    // O admin continua vendo a foto, marcada como oculta.
    const list = await adminGet(c, '/api/admin/photos');
    expect(list.body.items[0]).toMatchObject({ id, hidden: true });
    expect(list.body.counts).toEqual({ total: 1, hidden: 1 });
  });

  it('reexibir → 200 { hidden: false }; hiddenAt nulo, visibilityChangedAt = agora; volta para os convidados em added', async () => {
    const { c, clock, bia, id } = await scene();
    clock.now = at(5);
    await patch(c, id, { hidden: true });
    clock.now = at(9);
    const res = await patch(c, id, { hidden: false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id, hidden: false });

    const photo = await c.prisma.photo.findUniqueOrThrow({ where: { id } });
    expect(photo.hiddenAt).toBeNull();
    expect(photo.visibilityChangedAt).toEqual(at(9));

    expect((await guestGet(c, '/api/gallery', bia.cookie)).body.items.map((i: { id: string }) => i.id)).toEqual([id]);
    expect((await guestGet(c, `/api/gallery/photos/${id}`, bia.cookie)).status).toBe(200);
    const up = await guestGet(c, `/api/gallery/updates?since=${encodeURIComponent(at(6).toISOString())}`, bia.cookie);
    expect(up.body.added.map((i: { id: string }) => i.id)).toEqual([id]);
    expect(up.body.removedIds).toEqual([]);
  });

  it('REEXIBIR foto apagada pelo dono (DELETE) traz a foto de volta — comportamento aceito, o front já trata', async () => {
    const { c, clock, ana, bia, id } = await scene();
    clock.now = at(3);
    expect((await request(c.app).delete(`/api/gallery/photos/${id}`).set('Origin', ORIGIN).set('Cookie', ana.cookie)).status).toBe(204);
    expect((await guestGet(c, '/api/gallery', bia.cookie)).body.items).toEqual([]);

    clock.now = at(8);
    expect((await patch(c, id, { hidden: false })).status).toBe(200);
    expect((await guestGet(c, '/api/gallery', bia.cookie)).body.items.map((i: { id: string }) => i.id)).toEqual([id]);
    const up = await guestGet(c, `/api/gallery/updates?since=${encodeURIComponent(at(4).toISOString())}`, ana.cookie);
    expect(up.body.added.map((i: { id: string }) => i.id)).toEqual([id]);
  });

  it('idempotente: ocultar duas vezes e reexibir foto visível não mudam os timestamps do primeiro efeito', async () => {
    const { c, clock, id } = await scene();
    // Reexibir uma foto que já está visível: 200 e nada gravado.
    clock.now = at(2);
    expect((await patch(c, id, { hidden: false })).status).toBe(200);
    expect((await c.prisma.photo.findUniqueOrThrow({ where: { id } })).visibilityChangedAt).toBeNull();

    clock.now = at(5);
    await patch(c, id, { hidden: true });
    clock.now = at(9);
    const again = await patch(c, id, { hidden: true });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ id, hidden: true });
    const photo = await c.prisma.photo.findUniqueOrThrow({ where: { id } });
    expect(photo.hiddenAt).toEqual(at(5));
    expect(photo.visibilityChangedAt).toEqual(at(5));
  });

  it('vários PATCH simultâneos → todos 200 e uma única mudança', async () => {
    const { c, clock, id } = await scene();
    clock.now = at(5);
    const results = await Promise.all(Array.from({ length: 6 }, () => patch(c, id, { hidden: true })));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    const photo = await c.prisma.photo.findUniqueOrThrow({ where: { id } });
    expect(photo.hiddenAt).toEqual(at(5));
    expect(photo.visibilityChangedAt).toEqual(at(5));
  });

  it.each([
    ['sem o campo', {}],
    ['hidden como texto', { hidden: 'true' }],
    ['hidden como número', { hidden: 1 }],
    ['hidden nulo', { hidden: null }],
    ['campo extra', { hidden: true, guestId: 'x' }],
    ['array', [true]],
  ])('corpo inválido (%s) → 400 validation_error e nada muda', async (_label, body) => {
    const { c, id } = await scene();
    const res = await patch(c, id, body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
    expect((await c.prisma.photo.findUniqueOrThrow({ where: { id } })).hiddenAt).toBeNull();
  });

  it('JSON malformado → 400 invalid_json; foto inexistente ou id inválido → 404', async () => {
    const { c, id } = await scene();
    const bad = await request(c.app)
      .patch(`/api/admin/photos/${id}`)
      .set('Origin', ORIGIN)
      .set('Authorization', AUTH)
      .set('Content-Type', 'application/json')
      .send('{x');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_json');
    expect((await patch(c, randomUUID(), { hidden: true })).status).toBe(404);
    expect((await patch(c, 'nao-e-uuid', { hidden: true })).status).toBe(404);
  });

  it('ocultar e reexibir não mudam a cota do convidado (as ocultas contam)', async () => {
    const { c, ana, id } = await scene();
    const me = async () => (await guestGet(c, '/api/me', ana.cookie)).body.quota;
    const before = await me();
    await patch(c, id, { hidden: true });
    expect(await me()).toEqual(before);
    await patch(c, id, { hidden: false });
    expect(await me()).toEqual(before);
  });

  it('o ZIP passa a trazer a foto ocultada em _ocultas/ e a reexibida de volta na pasta normal', async () => {
    const { c, id } = await scene();
    const zipNames = async () => {
      const res = await adminGet(c, '/api/admin/export.zip')
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (d: Buffer) => chunks.push(d));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        });
      return listZip(res.body as Buffer).map((e) => e.name);
    };
    expect((await zipNames())[0]).not.toMatch(/^_ocultas\//);
    await patch(c, id, { hidden: true });
    expect((await zipNames())[0]).toMatch(new RegExp(`^_ocultas/ana-[0-9a-f]{8}/.*${id}\\.jpg$`));
    await patch(c, id, { hidden: false });
    expect((await zipNames())[0]).not.toMatch(/^_ocultas\//);
    expect(existsSync(path.join(c.env.DATA_DIR, (await c.prisma.photo.findUniqueOrThrow({ where: { id } })).filePath))).toBe(true);
  });
});
