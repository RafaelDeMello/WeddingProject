import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from '../src/gallery.js';
import * as fx from './fixtures.js';
import { signIn, T0, type Ctx, uploadOk, useContext } from './photoHelpers.js';

const setup = useContext();

/** Instante relativo ao T0 do relógio injetado (minutos; negativo = antes). */
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const sec = (base: Date, seconds: number) => new Date(base.getTime() + seconds * 1000);

interface Row {
  id?: string;
  createdAt: Date;
  hiddenAt?: Date | null;
  visibilityChangedAt?: Date | null;
}

const rowData = (guestId: string, r: Row) => {
  const id = r.id ?? randomUUID();
  return {
    id,
    guestId,
    clientUploadId: randomUUID(),
    filePath: `photos/2026-10-04/${id}.jpg`,
    thumbPath: `thumbs/${id}.jpg`,
    sizeBytes: 1,
    width: 1,
    height: 1,
    createdAt: r.createdAt,
    hiddenAt: r.hiddenAt ?? null,
    visibilityChangedAt: r.visibilityChangedAt ?? null,
  };
};

/** Cria várias fotos de uma vez (sem arquivo no disco) e devolve os ids, na ordem dada. */
async function seed(c: Ctx, guestId: string, rows: Row[]): Promise<string[]> {
  const data = rows.map((r) => rowData(guestId, r));
  await c.prisma.photo.createMany({ data });
  return data.map((d) => d.id);
}

const hide = (c: Ctx, id: string, when: Date) =>
  c.prisma.photo.update({ where: { id }, data: { hiddenAt: when, visibilityChangedAt: when } });
const show = (c: Ctx, id: string, when: Date) =>
  c.prisma.photo.update({ where: { id }, data: { hiddenAt: null, visibilityChangedAt: when } });

const get = (c: Ctx, url: string, cookie: string, headers: Record<string, string> = {}) =>
  request(c.app).get(url).set('Cookie', cookie).set(headers);

const updates = (c: Ctx, cookie: string, since: Date | string) =>
  get(c, `/api/gallery/updates?since=${encodeURIComponent(typeof since === 'string' ? since : since.toISOString())}`, cookie);

const ids = (items: { id: string }[]) => items.map((i) => i.id);

describe('autenticação', () => {
  const someId = randomUUID();
  it.each([
    ['listagem', '/api/gallery'],
    ['listagem com parâmetros', '/api/gallery?limit=5'],
    ['updates', '/api/gallery/updates?since=2026-01-01T00:00:00Z'],
    ['foto', `/api/gallery/photos/${someId}`],
    ['miniatura', `/api/gallery/photos/${someId}/thumb`],
  ])('%s sem sessão → 401 unauthorized', async (_label, url) => {
    const c = await setup();
    const res = await request(c.app).get(url);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('cookie adulterado ou de convidado removido → 401', async () => {
    const c = await setup();
    const { guestId, cookie } = await signIn(c);
    expect((await get(c, '/api/gallery', cookie.slice(0, -3) + 'AAA')).status).toBe(401);
    await c.prisma.guest.delete({ where: { id: guestId } });
    expect((await get(c, '/api/gallery', cookie)).status).toBe(401);
  });
});

describe('GET /api/gallery', () => {
  it('vazia → items [], nextCursor null e serverTime do relógio', async () => {
    const c = await setup();
    const { cookie } = await signIn(c);
    const res = await get(c, '/api/gallery', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], nextCursor: null, serverTime: T0.toISOString() });
  });

  it('item no formato do contrato e mine correto para cada convidado (fotos enviadas de verdade)', async () => {
    const c = await setup();
    const ana = await signIn(c, 'Ana');
    const bia = await signIn(c, 'Bia');
    const sent = await uploadOk(c, await fx.jpeg(), ana.cookie);
    expect(sent.status).toBe(201);
    const id = sent.body.id as string;

    const expected = {
      id,
      guestName: 'Ana',
      createdAt: T0.toISOString(),
      thumbUrl: `/api/gallery/photos/${id}/thumb`,
      photoUrl: `/api/gallery/photos/${id}`,
    };
    const forBia = await get(c, '/api/gallery', bia.cookie);
    expect(forBia.body.items).toEqual([{ ...expected, mine: false }]);
    const forAna = await get(c, '/api/gallery', ana.cookie);
    expect(forAna.body.items).toEqual([{ ...expected, mine: true }]);
    expect(Object.keys(forAna.body.items[0]).sort()).toEqual(
      ['createdAt', 'guestName', 'id', 'mine', 'photoUrl', 'thumbUrl'].sort(),
    );
  });

  it('mais recentes primeiro, sem fotos ocultas', async () => {
    const c = await setup();
    const { guestId, cookie } = await signIn(c);
    const [old, hidden, mid, recent] = await seed(c, guestId, [
      { createdAt: at(-30) },
      { createdAt: at(-20), hiddenAt: at(-1), visibilityChangedAt: at(-1) },
      { createdAt: at(-10) },
      { createdAt: at(-1) },
    ]);
    const res = await get(c, '/api/gallery', cookie);
    expect(ids(res.body.items)).toEqual([recent, mid, old]);
    expect(ids(res.body.items)).not.toContain(hidden);
  });

  it('foto reexibida volta à listagem na posição da data de criação', async () => {
    const c = await setup();
    const { guestId, cookie } = await signIn(c);
    const [a, b, d] = await seed(c, guestId, [{ createdAt: at(-30) }, { createdAt: at(-20) }, { createdAt: at(-10) }]);
    await hide(c, b!, at(-5));
    expect(ids((await get(c, '/api/gallery', cookie)).body.items)).toEqual([d, a]);
    await show(c, b!, at(-4));
    expect(ids((await get(c, '/api/gallery', cookie)).body.items)).toEqual([d, b, a]);
  });

  it('paginação: 75 fotos com limit=30 → 30, 30, 15, sem repetir nem pular', async () => {
    const c = await setup();
    const { guestId, cookie } = await signIn(c);
    const order = await seed(c, guestId, Array.from({ length: 75 }, (_, i) => ({ createdAt: sec(at(-120), i) })));
    const expected = [...order].reverse(); // mais recentes primeiro

    const pages: string[][] = [];
    let cursor: string | null = null;
    do {
      const res = await get(c, `/api/gallery?limit=30${cursor ? `&cursor=${cursor}` : ''}`, cookie);
      expect(res.status).toBe(200);
      pages.push(ids(res.body.items));
      cursor = res.body.nextCursor;
    } while (cursor);

    expect(pages.map((p) => p.length)).toEqual([30, 30, 15]);
    expect(pages.flat()).toEqual(expected);
  });

  it('múltiplo exato do limite: a última página traz nextCursor null (sem página vazia extra)', async () => {
    const c = await setup();
    const { guestId, cookie } = await signIn(c);
    await seed(c, guestId, Array.from({ length: 60 }, (_, i) => ({ createdAt: sec(at(-120), i) })));
    const first = await get(c, '/api/gallery?limit=30', cookie);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await get(c, `/api/gallery?limit=30&cursor=${first.body.nextCursor}`, cookie);
    expect(second.body.items).toHaveLength(30);
    expect(second.body.nextCursor).toBeNull();
  });

  it('fotos com o mesmo createdAt paginam sem perda (desempate por id)', async () => {
    const c = await setup();
    const { guestId, cookie } = await signIn(c);
    const same = await seed(c, guestId, Array.from({ length: 10 }, () => ({ createdAt: at(-5) })));

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await get(c, `/api/gallery?limit=3${cursor ? `&cursor=${cursor}` : ''}`, cookie);
      seen.push(...ids(res.body.items));
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(10);
    expect(new Set(seen)).toEqual(new Set(same));
    expect(seen).toEqual([...same].sort().reverse());
  });

  it('foto ocultada entre uma página e outra não aparece na seguinte', async () => {
    const c = await setup();
    const { guestId, cookie } = await signIn(c);
    const order = await seed(c, guestId, Array.from({ length: 6 }, (_, i) => ({ createdAt: sec(at(-60), i) })));
    const newestFirst = [...order].reverse();
    const first = await get(c, '/api/gallery?limit=3', cookie);
    await hide(c, newestFirst[4]!, at(-1));
    const second = await get(c, `/api/gallery?limit=3&cursor=${first.body.nextCursor}`, cookie);
    expect(ids(second.body.items)).toEqual([newestFirst[3], newestFirst[5]]);
  });

  it('limite padrão é 30 e o máximo é 60', async () => {
    const c = await setup();
    const { guestId, cookie } = await signIn(c);
    await seed(c, guestId, Array.from({ length: 70 }, (_, i) => ({ createdAt: sec(at(-120), i) })));
    expect((await get(c, '/api/gallery', cookie)).body.items).toHaveLength(30);
    expect((await get(c, '/api/gallery?limit=60', cookie)).body.items).toHaveLength(60);
  });

  it.each([['0'], ['61'], ['abc'], ['1.5'], ['-3'], ['']])('limit=%s inválido → 400 validation_error', async (limit) => {
    const c = await setup();
    const { cookie } = await signIn(c);
    const res = await get(c, `/api/gallery?limit=${limit}`, cookie);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it.each([
    ['texto solto', 'abc'],
    ['caracteres inválidos', '***'],
    ['sem id', Buffer.from('1234567890').toString('base64url')],
    ['id que não é uuid', Buffer.from('1234567890.nao-e-uuid').toString('base64url')],
    ['data inválida', Buffer.from(`abc.${randomUUID()}`).toString('base64url')],
    ['partes demais', Buffer.from(`1.${randomUUID()}.x`).toString('base64url')],
    ['gigante', 'A'.repeat(500)],
  ])('cursor inválido (%s) → 400 invalid_cursor', async (_label, cursor) => {
    const c = await setup();
    const { cookie } = await signIn(c);
    const res = await get(c, `/api/gallery?cursor=${cursor}`, cookie);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_cursor');
  });

  it('cursor faz ida e volta', () => {
    const photo = { createdAt: at(-3), id: randomUUID() };
    expect(decodeCursor(encodeCursor(photo))).toEqual(photo);
    expect(decodeCursor('')).toBeNull();
  });
});

describe('GET /api/gallery/updates', () => {
  it.each([
    ['ausente', ''],
    ['texto', '?since=ontem'],
    ['só a data', '?since=2026-10-04'],
    ['sem fuso', '?since=2026-10-04T20:00:00'],
    ['vazio', '?since='],
  ])('since %s → 400 validation_error', async (_label, query) => {
    const c = await setup();
    const { cookie } = await signIn(c);
    const res = await get(c, `/api/gallery/updates${query}`, cookie);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it.each([['Z', '2026-10-04T23:00:00.000Z'], ['offset', '2026-10-04T20:00:00-03:00'], ['sem milésimos', '2026-10-04T23:00:00Z']])(
    'aceita since com %s',
    async (_label, since) => {
      const c = await setup();
      const { cookie } = await signIn(c);
      expect((await updates(c, cookie, since)).status).toBe(200);
    },
  );

  it('added = criadas DEPOIS de since (estritamente); serverTime é o horário real, sem subtrair nada', async () => {
    const c = await setup();
    const { guestId, cookie } = await signIn(c);
    const [before, equal, after1, after2] = await seed(c, guestId, [
      { createdAt: at(-10) },
      { createdAt: at(-5) },
      { createdAt: at(-4) },
      { createdAt: at(0) },
    ]);
    const res = await updates(c, cookie, at(-5));
    expect(res.status).toBe(200);
    expect(ids(res.body.added)).toEqual([after1, after2]); // ordem cronológica
    expect(ids(res.body.added)).not.toContain(before);
    expect(ids(res.body.added)).not.toContain(equal);
    expect(res.body.removedIds).toEqual([]);
    expect(res.body.serverTime).toBe(T0.toISOString());
    expect(res.body.hasMore).toBe(false);
  });

  it('itens de updates têm o mesmo formato da listagem, com mine correto', async () => {
    const c = await setup();
    const ana = await signIn(c, 'Ana');
    const bia = await signIn(c, 'Bia');
    const [mine, other] = [
      (await seed(c, ana.guestId, [{ createdAt: at(-2) }]))[0]!,
      (await seed(c, bia.guestId, [{ createdAt: at(-1) }]))[0]!,
    ];
    const res = await updates(c, ana.cookie, at(-10));
    expect(res.body.added).toEqual([
      {
        id: mine,
        guestName: 'Ana',
        createdAt: at(-2).toISOString(),
        thumbUrl: `/api/gallery/photos/${mine}/thumb`,
        photoUrl: `/api/gallery/photos/${mine}`,
        mine: true,
      },
      expect.objectContaining({ id: other, guestName: 'Bia', mine: false }),
    ]);
  });

  it('since no futuro → nada', async () => {
    const c = await setup();
    const { guestId, cookie } = await signIn(c);
    await seed(c, guestId, [{ createdAt: at(-1) }]);
    const res = await updates(c, cookie, at(60));
    expect(res.body).toEqual({ added: [], removedIds: [], serverTime: T0.toISOString(), hasMore: false });
  });

  it('since no passado devolve tudo o que mudou: visíveis em added e ocultadas em removedIds', async () => {
    const c = await setup();
    const { guestId, cookie } = await signIn(c);
    const [a, b, hidden, revived] = await seed(c, guestId, [
      { createdAt: at(-50) },
      { createdAt: at(-40) },
      { createdAt: at(-30), hiddenAt: at(-20), visibilityChangedAt: at(-20) },
      { createdAt: at(-25), visibilityChangedAt: at(-10) },
    ]);
    const res = await updates(c, cookie, '1970-01-01T00:00:00Z');
    expect(res.status).toBe(200);
    expect(new Set(ids(res.body.added))).toEqual(new Set([a, b, revived]));
    expect(res.body.added).toHaveLength(3);
    expect(res.body.removedIds).toEqual([hidden]);
  });

  it('foto REEXIBIDA (criada antes de since) aparece em added, e não em removedIds', async () => {
    const c = await setup();
    const { guestId, cookie } = await signIn(c);
    const [id] = await seed(c, guestId, [{ createdAt: at(-60) }]);
    await hide(c, id!, at(-30));
    await show(c, id!, at(-1));

    const res = await updates(c, cookie, at(-2));
    expect(ids(res.body.added)).toEqual([id]);
    expect(res.body.removedIds).toEqual([]);
    // Depois de reexibida e já sincronizada, não volta a aparecer.
    const later = await updates(c, cookie, at(0));
    expect(later.body.added).toEqual([]);
  });

  it('foto OCULTADA depois de since aparece em removedIds, e não em added', async () => {
    const c = await setup();
    const { guestId, cookie } = await signIn(c);
    const [id] = await seed(c, guestId, [{ createdAt: at(-60) }]);
    await hide(c, id!, at(-1));

    const res = await updates(c, cookie, at(-2));
    expect(res.body.removedIds).toEqual([id]);
    expect(res.body.added).toEqual([]);
    // Se a mudança foi antes de since, o cliente já sabe: não repete.
    expect((await updates(c, cookie, at(0))).body.removedIds).toEqual([]);
  });

  it('criada e ocultada dentro da mesma janela → só removedIds (o cliente nunca a mostra)', async () => {
    const c = await setup();
    const { guestId, cookie } = await signIn(c);
    const [id] = await seed(c, guestId, [
      { createdAt: at(-5), hiddenAt: at(-3), visibilityChangedAt: at(-3) },
    ]);
    const res = await updates(c, cookie, at(-10));
    expect(res.body.added).toEqual([]);
    expect(res.body.removedIds).toEqual([id]);
  });

  it('ocultada e reexibida entre duas consultas → reaparece em added e não sai em removedIds', async () => {
    const c = await setup();
    const { guestId, cookie } = await signIn(c);
    const [id] = await seed(c, guestId, [{ createdAt: at(-60) }]);
    await hide(c, id!, at(-5));
    await show(c, id!, at(-4));
    const res = await updates(c, cookie, at(-6));
    expect(ids(res.body.added)).toEqual([id]);
    expect(res.body.removedIds).toEqual([]);
  });

  it('fotos ocultadas antes de since nunca viram removedIds; ocultas nunca entram em added', async () => {
    const c = await setup();
    const { guestId, cookie } = await signIn(c);
    await seed(c, guestId, [
      { createdAt: at(-60), hiddenAt: at(-50), visibilityChangedAt: at(-50) },
      { createdAt: at(-1), hiddenAt: at(-1), visibilityChangedAt: at(-1) },
    ]);
    const res = await updates(c, cookie, at(-20));
    expect(res.body.added).toEqual([]);
    expect(res.body.removedIds).toHaveLength(1); // só a de -1
  });

  it('>200 novas: devolve as 200 mais antigas com hasMore e serverTime no ponto onde parou; a próxima chamada completa', async () => {
    const c = await setup();
    const { guestId, cookie } = await signIn(c);
    const all = await seed(c, guestId, Array.from({ length: 250 }, (_, i) => ({ createdAt: sec(at(-60), i) })));

    const first = await updates(c, cookie, at(-90));
    expect(first.body.added).toHaveLength(200);
    expect(first.body.hasMore).toBe(true);
    expect(ids(first.body.added)).toEqual(all.slice(0, 200));
    expect(first.body.serverTime).toBe(sec(at(-60), 199).toISOString()); // a 200ª, não o relógio

    const second = await updates(c, cookie, first.body.serverTime);
    expect(ids(second.body.added)).toEqual(all.slice(200));
    expect(second.body.hasMore).toBe(false);
    expect(second.body.serverTime).toBe(T0.toISOString());
  });

  it('exatamente 200 novas → sem hasMore e serverTime real', async () => {
    const c = await setup();
    const { guestId, cookie } = await signIn(c);
    await seed(c, guestId, Array.from({ length: 200 }, (_, i) => ({ createdAt: sec(at(-60), i) })));
    const res = await updates(c, cookie, at(-90));
    expect(res.body.added).toHaveLength(200);
    expect(res.body.hasMore).toBe(false);
    expect(res.body.serverTime).toBe(T0.toISOString());
  });

  it('empate no corte (mesmo instante da 200ª) não separa fotos: todas vêm juntas', async () => {
    const c = await setup();
    const { guestId, cookie } = await signIn(c);
    const rows: Row[] = [
      ...Array.from({ length: 195 }, (_, i) => ({ createdAt: sec(at(-60), i) })),
      ...Array.from({ length: 15 }, () => ({ createdAt: at(-30) })), // 15 no mesmo instante, cruzando o corte de 200
      { createdAt: at(-20) },
    ];
    const all = await seed(c, guestId, rows);

    const first = await updates(c, cookie, at(-90));
    expect(first.body.added).toHaveLength(210); // 195 + as 15 empatadas
    expect(first.body.hasMore).toBe(true);
    expect(first.body.serverTime).toBe(at(-30).toISOString());
    const second = await updates(c, cookie, first.body.serverTime);
    expect(ids(second.body.added)).toEqual([all[210]]);
    expect(second.body.hasMore).toBe(false);
  });

  it.each([[450], [700]])(
    'cliente que segue hasMore recebe %i fotos novas e reexibidas, sem perder nem repetir nenhuma',
    async (total) => {
      const c = await setup();
      const { guestId, cookie } = await signIn(c);
      // Metade "criada depois de since", metade "reexibida depois de since" (criada antes), intercaladas.
      const rows: Row[] = Array.from({ length: total }, (_, i) =>
        i % 2 === 0
          ? { createdAt: sec(at(-60), i) }
          : { createdAt: at(-500 + i), visibilityChangedAt: sec(at(-60), i) },
      );
      const all = await seed(c, guestId, rows);

      const received: string[] = [];
      let since: string = at(-90).toISOString();
      let calls = 0;
      for (;;) {
        const res = await updates(c, cookie, since);
        expect(res.status).toBe(200);
        expect(res.body.added.length).toBeLessThanOrEqual(200);
        received.push(...ids(res.body.added));
        since = res.body.serverTime;
        calls++;
        if (!res.body.hasMore) break;
        expect(calls).toBeLessThan(20);
      }
      expect(received).toHaveLength(total);
      expect(new Set(received)).toEqual(new Set(all));
      expect(calls).toBeGreaterThanOrEqual(2);
    },
  );

  it('removedIds vem completo mesmo quando added está truncado', async () => {
    const c = await setup();
    const { guestId, cookie } = await signIn(c);
    await seed(c, guestId, Array.from({ length: 250 }, (_, i) => ({ createdAt: sec(at(-60), i) })));
    const [gone] = await seed(c, guestId, [{ createdAt: at(-100), hiddenAt: at(-2), visibilityChangedAt: at(-2) }]);
    const res = await updates(c, cookie, at(-90));
    expect(res.body.hasMore).toBe(true);
    expect(res.body.removedIds).toEqual([gone]);
  });
});

describe('arquivos da galeria', () => {
  async function uploaded() {
    const c = await setup();
    const ana = await signIn(c, 'Ana');
    const bia = await signIn(c, 'Bia');
    const res = await uploadOk(c, await fx.jpeg(800, 600), ana.cookie);
    expect(res.status).toBe(201);
    const photo = await c.prisma.photo.findUniqueOrThrow({ where: { id: res.body.id } });
    return { c, ana, bia, photo };
  }

  it('qualquer convidado com sessão recebe a foto e a miniatura, com os bytes do disco e cache privado curto', async () => {
    const { c, bia, photo } = await uploaded();
    for (const [url, rel] of [
      [`/api/gallery/photos/${photo.id}`, photo.filePath],
      [`/api/gallery/photos/${photo.id}/thumb`, photo.thumbPath],
    ] as const) {
      const res = await get(c, url, bia.cookie).buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (d: Buffer) => chunks.push(d));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      expect(res.status, url).toBe(200);
      expect(res.headers['content-type']).toBe('image/jpeg');
      expect(res.headers['cache-control']).toBe('private, max-age=60');
      expect(res.headers['vary']).toMatch(/Cookie/i);
      expect(res.headers['etag']).toBeTruthy();
      expect(Buffer.compare(res.body as Buffer, readFileSync(path.join(c.env.DATA_DIR, rel)))).toBe(0);
    }
  });

  it('foto OCULTA → 404 na foto e na miniatura, sem cache, mesmo para o dono', async () => {
    const { c, ana, bia, photo } = await uploaded();
    await hide(c, photo.id, at(1));
    for (const cookie of [ana.cookie, bia.cookie]) {
      for (const url of [`/api/gallery/photos/${photo.id}`, `/api/gallery/photos/${photo.id}/thumb`]) {
        const res = await get(c, url, cookie);
        expect(res.status, url).toBe(404);
        expect(res.body.error.code).toBe('not_found');
        expect(res.headers['cache-control']).toBeUndefined();
      }
    }
    // Reexibida, volta a ser servida.
    await show(c, photo.id, at(2));
    expect((await get(c, `/api/gallery/photos/${photo.id}`, bia.cookie)).status).toBe(200);
  });

  it('requisição condicional: 304 enquanto visível; depois de ocultada, 404 (o ETag não vale mais)', async () => {
    const { c, bia, photo } = await uploaded();
    const url = `/api/gallery/photos/${photo.id}/thumb`;
    const first = await get(c, url, bia.cookie);
    const etag = first.headers['etag']!;
    expect((await get(c, url, bia.cookie, { 'If-None-Match': etag })).status).toBe(304);
    await hide(c, photo.id, at(1));
    expect((await get(c, url, bia.cookie, { 'If-None-Match': etag })).status).toBe(404);
  });

  it.each([
    ['uuid inexistente', randomUUID()],
    ['id que não é uuid', 'nao-e-uuid'],
    ['tentativa de traversal', '..%2F..%2Fetc%2Fpasswd'],
  ])('%s → 404', async (_label, id) => {
    const c = await setup();
    const { cookie } = await signIn(c);
    for (const url of [`/api/gallery/photos/${id}`, `/api/gallery/photos/${id}/thumb`]) {
      expect((await get(c, url, cookie)).status, url).toBe(404);
    }
  });

  it('arquivo sumiu do disco → 404 (sem cache), não 500', async () => {
    const { c, bia, photo } = await uploaded();
    rmSync(path.join(c.env.DATA_DIR, photo.thumbPath));
    const res = await get(c, `/api/gallery/photos/${photo.id}/thumb`, bia.cookie);
    expect(res.status).toBe(404);
    expect(res.headers['cache-control']).toBeUndefined();
    expect((await get(c, `/api/gallery/photos/${photo.id}`, bia.cookie)).status).toBe(200);
  });

  it('caminho do banco que escapa de DATA_DIR nunca é servido', async () => {
    const c = await setup();
    const { guestId, cookie } = await signIn(c);
    writeFileSync(path.join(c.env.DATA_DIR, '..', 'segredo.txt'), 'SEGREDO');
    for (const bad of ['../segredo.txt', '../../segredo.txt', path.resolve(c.env.DATA_DIR, '..', 'segredo.txt')]) {
      const [id] = await seed(c, guestId, [{ createdAt: at(-1) }]);
      await c.prisma.photo.update({ where: { id: id! }, data: { filePath: bad, thumbPath: bad } });
      for (const url of [`/api/gallery/photos/${id}`, `/api/gallery/photos/${id}/thumb`]) {
        const res = await get(c, url, cookie);
        expect(res.status, `${bad} ${url}`).toBe(404);
        expect(res.text).not.toContain('SEGREDO');
      }
    }
  });
});

describe('ponta a ponta: envio → galeria → ocultar → updates', () => {
  it('a foto de uma convidada aparece para a outra, e some quando oculta', async () => {
    let clock = T0;
    const c = await setup({ now: () => clock });
    const ana = await signIn(c, 'Ana');
    const bia = await signIn(c, 'Bia');

    const first = await get(c, '/api/gallery', bia.cookie);
    let since = first.body.serverTime as string;
    expect(first.body.items).toEqual([]);

    clock = at(1);
    const sent = await uploadOk(c, await fx.jpeg(), ana.cookie);
    const id = sent.body.id as string;

    clock = at(2);
    const poll1 = await updates(c, bia.cookie, since);
    expect(poll1.body.added).toEqual([expect.objectContaining({ id, guestName: 'Ana', mine: false })]);
    since = poll1.body.serverTime;
    expect((await get(c, poll1.body.added[0].thumbUrl, bia.cookie)).status).toBe(200);

    clock = at(3);
    await hide(c, id, clock);
    clock = at(4);
    const poll2 = await updates(c, bia.cookie, since);
    expect(poll2.body.removedIds).toEqual([id]);
    expect(poll2.body.added).toEqual([]);
    expect((await get(c, poll1.body.added[0].thumbUrl, bia.cookie)).status).toBe(404);
  });
});

describe('limite por IP da galeria', () => {
  it('IP_MAX_GALLERY_PER_WINDOW estourado → 429 com Retry-After; outro IP segue passando', async () => {
    const c = await setup({ env: { IP_MAX_GALLERY_PER_WINDOW: '3' } });
    const { cookie } = await signIn(c);
    const ip = '198.51.100.9';
    for (let i = 0; i < 3; i++) {
      expect((await get(c, '/api/gallery', cookie, { 'X-Forwarded-For': ip })).status).toBe(200);
    }
    const blocked = await get(c, '/api/gallery/updates?since=2026-01-01T00:00:00Z', cookie, { 'X-Forwarded-For': ip });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('rate_limited');
    expect(Number(blocked.headers['retry-after'])).toBe(blocked.body.error.retryAfterSeconds);
    expect((await get(c, '/api/gallery', cookie, { 'X-Forwarded-For': '198.51.100.10' })).status).toBe(200);
  });
});
