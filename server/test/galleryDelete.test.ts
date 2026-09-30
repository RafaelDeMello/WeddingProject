import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import * as fx from './fixtures.js';
import { ORIGIN } from './helpers.js';
import { signIn, T0, type Ctx, uploadOk, useContext } from './photoHelpers.js';

const setup = useContext();

const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

const del = (c: Ctx, id: string, cookie?: string, origin: string | null = ORIGIN) => {
  const req = request(c.app).delete(`/api/gallery/photos/${id}`);
  if (origin !== null) req.set('Origin', origin);
  if (cookie) req.set('Cookie', cookie);
  return req;
};
const get = (c: Ctx, url: string, cookie: string) => request(c.app).get(url).set('Cookie', cookie);
const updates = (c: Ctx, cookie: string, since: Date) =>
  get(c, `/api/gallery/updates?since=${encodeURIComponent(since.toISOString())}`, cookie);

/** Convidadas Ana e Bia, e uma foto da Ana enviada de verdade. O relógio é controlável. */
async function scene(env: Record<string, string> = {}) {
  const clock = { now: T0 };
  const c = await setup({ env, now: () => clock.now });
  const ana = await signIn(c, 'Ana');
  const bia = await signIn(c, 'Bia');
  const sent = await uploadOk(c, await fx.jpeg(), ana.cookie);
  expect(sent.status).toBe(201);
  const id = sent.body.id as string;
  return { c, clock, ana, bia, id };
}

describe('DELETE /api/gallery/photos/:id — o dono apaga a própria foto', () => {
  it('204 sem corpo; some de /gallery, de /updates (em removedIds) e dos arquivos, para todos', async () => {
    const { c, clock, ana, bia, id } = await scene();
    const since = T0; // a foto foi criada em T0 (já estava na galeria de quem consultou antes)

    clock.now = at(5);
    const res = await del(c, id, ana.cookie);
    expect(res.status).toBe(204);
    expect(res.text).toBe('');

    for (const cookie of [ana.cookie, bia.cookie]) {
      expect((await get(c, '/api/gallery', cookie)).body.items).toEqual([]);
      const up = await updates(c, cookie, since);
      expect(up.body.removedIds).toEqual([id]);
      expect(up.body.added).toEqual([]);
      for (const url of [`/api/gallery/photos/${id}`, `/api/gallery/photos/${id}/thumb`]) {
        const file = await get(c, url, cookie);
        expect(file.status, url).toBe(404);
        expect(file.body.error.code).toBe('not_found');
      }
    }
  });

  it('grava hiddenAt e visibilityChangedAt com o mesmo instante; o arquivo continua no disco', async () => {
    const { c, clock, ana, id } = await scene();
    clock.now = at(7);
    await del(c, id, ana.cookie);

    const photo = await c.prisma.photo.findUniqueOrThrow({ where: { id } });
    expect(photo.hiddenAt).toEqual(at(7));
    expect(photo.visibilityChangedAt).toEqual(at(7));
    expect(existsSync(path.join(c.env.DATA_DIR, photo.filePath))).toBe(true);
    expect(existsSync(path.join(c.env.DATA_DIR, photo.thumbPath))).toBe(true);
  });

  it('o efeito é o do "ocultar" do admin: reexibida, a foto volta em added', async () => {
    const { c, clock, ana, bia, id } = await scene();
    clock.now = at(5);
    await del(c, id, ana.cookie);
    await c.prisma.photo.update({ where: { id }, data: { hiddenAt: null, visibilityChangedAt: at(6) } });

    const up = await updates(c, bia.cookie, at(5));
    expect(up.body.added.map((i: { id: string }) => i.id)).toEqual([id]);
    expect(up.body.removedIds).toEqual([]);
  });
});

describe('DELETE — quem pode apagar', () => {
  it('foto de OUTRO convidado → 404 not_found e a foto continua visível', async () => {
    const { c, bia, id } = await scene();
    const res = await del(c, id, bia.cookie);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');

    const photo = await c.prisma.photo.findUniqueOrThrow({ where: { id } });
    expect(photo.hiddenAt).toBeNull();
    expect(photo.visibilityChangedAt).toBeNull();
    expect((await get(c, '/api/gallery', bia.cookie)).body.items).toHaveLength(1);
  });

  it('não revela a existência: outro convidado, id inexistente e id inválido dão a MESMA resposta', async () => {
    const { c, ana, bia, id } = await scene();
    const other = await del(c, id, bia.cookie);
    const missing = await del(c, randomUUID(), ana.cookie);
    const invalid = await del(c, 'nao-e-uuid', ana.cookie);
    for (const r of [other, missing, invalid]) expect(r.status).toBe(404);
    expect(missing.body).toEqual(other.body);
    expect(invalid.body).toEqual(other.body);
    expect(missing.headers['content-type']).toBe(other.headers['content-type']);
  });

  it('foto de outro convidado que já está oculta também é 404 (nada a revelar)', async () => {
    const { c, ana, bia, id } = await scene();
    await del(c, id, ana.cookie);
    expect((await del(c, id, bia.cookie)).status).toBe(404);
  });

  it('sem sessão → 401 (com Origin válido); cookie adulterado ou de convidado removido → 401', async () => {
    const { c, ana, id } = await scene();
    const none = await del(c, id);
    expect(none.status).toBe(401);
    expect(none.body.error.code).toBe('unauthorized');
    expect((await del(c, id, ana.cookie.slice(0, -3) + 'AAA')).status).toBe(401);
    await c.prisma.photo.deleteMany();
    await c.prisma.guest.delete({ where: { id: (await c.prisma.guest.findFirstOrThrow({ where: { name: 'Ana' } })).id } });
    expect((await del(c, id, ana.cookie)).status).toBe(401);
  });

  it.each([
    ['ausente', null],
    ['de outro domínio', 'https://evil.example'],
    ['http em vez de https', 'http://weddingrafessa.example.com'],
  ])('Origin %s → 403 invalid_origin, mesmo com sessão do dono; nada é apagado', async (_label, origin) => {
    const { c, ana, id } = await scene();
    const res = await del(c, id, ana.cookie, origin);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('invalid_origin');
    expect((await c.prisma.photo.findUniqueOrThrow({ where: { id } })).hiddenAt).toBeNull();
  });
});

describe('DELETE — idempotência e concorrência', () => {
  it('repetir → 204 e os timestamps do primeiro DELETE não mudam', async () => {
    const { c, clock, ana, id } = await scene();
    clock.now = at(5);
    expect((await del(c, id, ana.cookie)).status).toBe(204);
    clock.now = at(9);
    expect((await del(c, id, ana.cookie)).status).toBe(204);

    const photo = await c.prisma.photo.findUniqueOrThrow({ where: { id } });
    expect(photo.hiddenAt).toEqual(at(5));
    expect(photo.visibilityChangedAt).toEqual(at(5));
  });

  it('dono apagando foto que o admin já ocultou → 204 sem alterar o registro', async () => {
    const { c, clock, ana, id } = await scene();
    await c.prisma.photo.update({ where: { id }, data: { hiddenAt: at(2), visibilityChangedAt: at(2) } });
    clock.now = at(8);
    expect((await del(c, id, ana.cookie)).status).toBe(204);
    const photo = await c.prisma.photo.findUniqueOrThrow({ where: { id } });
    expect(photo.hiddenAt).toEqual(at(2));
    expect(photo.visibilityChangedAt).toEqual(at(2));
  });

  it('vários DELETE simultâneos → todos 204 e uma única mudança', async () => {
    const { c, clock, ana, id } = await scene();
    clock.now = at(5);
    const results = await Promise.all(Array.from({ length: 6 }, () => del(c, id, ana.cookie)));
    expect(results.map((r) => r.status)).toEqual([204, 204, 204, 204, 204, 204]);
    const photo = await c.prisma.photo.findUniqueOrThrow({ where: { id } });
    expect(photo.hiddenAt).toEqual(at(5));
    expect(photo.visibilityChangedAt).toEqual(at(5));
  });
});

describe('DELETE — a foto apagada continua contando na cota', () => {
  it('janela e total inalterados depois de apagar (/api/me) e o limite continua valendo', async () => {
    const clock = { now: T0 };
    const c = await setup({ env: { GUEST_MAX_PER_WINDOW: '3', GUEST_MAX_TOTAL: '5' }, now: () => clock.now });
    const { cookie } = await signIn(c, 'Ana');
    const first = await uploadOk(c, await fx.jpeg(), cookie);
    await uploadOk(c, await fx.jpeg(), cookie);

    const me = async () => (await get(c, '/api/me', cookie)).body.quota;
    const before = await me();
    expect(before).toMatchObject({ remainingInWindow: 1, remainingTotal: 3 });

    expect((await del(c, first.body.id, cookie)).status).toBe(204);
    expect(await me()).toEqual(before); // nada devolvido

    expect((await uploadOk(c, await fx.jpeg(), cookie)).status).toBe(201); // 3ª foto (2 visíveis + 1 apagada)
    const blocked = await uploadOk(c, await fx.jpeg(), cookie);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('quota_exceeded');
  });

  it('reenviar o mesmo clientUploadId de uma foto apagada continua idempotente (200, sem nova cota)', async () => {
    const clock = { now: T0 };
    const c = await setup({ now: () => clock.now });
    const { cookie } = await signIn(c, 'Ana');
    const clientUploadId = randomUUID();
    const first = await uploadOk(c, await fx.jpeg(), cookie, clientUploadId);
    await del(c, first.body.id, cookie);

    const again = await uploadOk(c, await fx.jpeg(), cookie, clientUploadId);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect(await c.prisma.photo.count()).toBe(1);
  });
});

describe('DELETE — depois do fim da janela de upload', () => {
  it('com a sessão ainda válida o dono consegue apagar (privacidade)', async () => {
    const { c, clock, ana, id } = await scene();
    clock.now = new Date('2026-10-07T12:00:00-03:00'); // depois de UPLOAD_CLOSES_AT
    const upload = await uploadOk(c, await fx.jpeg(), ana.cookie);
    expect(upload.status).toBe(403); // enviar já não pode...
    expect((await del(c, id, ana.cookie)).status).toBe(204); // ...mas apagar pode
    expect((await c.prisma.photo.findUniqueOrThrow({ where: { id } })).hiddenAt).toEqual(clock.now);
  });
});
