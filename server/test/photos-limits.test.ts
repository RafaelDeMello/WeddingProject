import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { defaultStatFs } from '../src/storage.js';
import * as fx from './fixtures.js';
import { expectDiskConsistent, signIn, T0, upload, uploadOk, useContext } from './photoHelpers.js';

const setup = useContext();
const CLOSES = new Date('2026-10-06T23:59:59-03:00');

describe('cota por janela deslizante', () => {
  it('a foto seguinte ao limite → 429 quota_exceeded com Retry-After; volta a passar quando a janela anda', async () => {
    let clock = T0;
    const c = await setup({ env: { GUEST_MAX_PER_WINDOW: '3' }, now: () => clock });
    const { cookie } = await signIn(c);
    const image = await fx.jpeg();

    for (let i = 0; i < 3; i++) {
      const ok = await uploadOk(c, image, cookie);
      expect(ok.status).toBe(201);
      expect(ok.body.quota.remainingInWindow).toBe(2 - i);
    }

    const blocked = await uploadOk(c, image, cookie);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toEqual({
      code: 'quota_exceeded',
      message: expect.stringMatching(/limite.*Tente novamente em 10 min/),
      retryAfterSeconds: 600,
    });
    expect(blocked.headers['retry-after']).toBe('600');
    await expectDiskConsistent(c, 3);

    clock = new Date(T0.getTime() + 300_000); // 5 min depois: retryAfter encolhe
    const still = await uploadOk(c, image, cookie);
    expect(still.status).toBe(429);
    expect(still.body.error.retryAfterSeconds).toBe(300);

    clock = new Date(T0.getTime() + 601_000);
    const again = await uploadOk(c, image, cookie);
    expect(again.status).toBe(201);
    await expectDiskConsistent(c, 4);
  });

  it('a cota é por convidado: outro convidado no mesmo IP não é afetado', async () => {
    const c = await setup({ env: { GUEST_MAX_PER_WINDOW: '1' } });
    const a = await signIn(c, 'Ana');
    const b = await signIn(c, 'Bia');
    const image = await fx.jpeg();
    expect((await uploadOk(c, image, a.cookie)).status).toBe(201);
    expect((await uploadOk(c, image, a.cookie)).status).toBe(429);
    expect((await uploadOk(c, image, b.cookie)).status).toBe(201);
  });

  it('fotos ocultas continuam contando na cota', async () => {
    const c = await setup({ env: { GUEST_MAX_PER_WINDOW: '1' } });
    const { cookie } = await signIn(c);
    const first = await uploadOk(c, await fx.jpeg(), cookie);
    await c.prisma.photo.update({ where: { id: first.body.id }, data: { hiddenAt: T0 } });
    expect((await uploadOk(c, await fx.jpeg(), cookie)).status).toBe(429);
  });
});

describe('cota total', () => {
  it('após o total → 429 total_quota_exceeded, retryAfterSeconds até o fim do evento', async () => {
    const c = await setup({ env: { GUEST_MAX_TOTAL: '2', GUEST_MAX_PER_WINDOW: '10' } });
    const { cookie } = await signIn(c);
    const image = await fx.jpeg();
    expect((await uploadOk(c, image, cookie)).status).toBe(201);
    const last = await uploadOk(c, image, cookie);
    expect(last.status).toBe(201);
    expect(last.body.quota).toMatchObject({ remainingTotal: 0, remainingInWindow: 0 });

    const blocked = await uploadOk(c, image, cookie);
    const expected = Math.ceil((CLOSES.getTime() - T0.getTime()) / 1000);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toEqual({
      code: 'total_quota_exceeded',
      message: 'Você atingiu o limite total de fotos.',
      retryAfterSeconds: expected,
    });
    expect(blocked.headers['retry-after']).toBe(String(expected));
    await expectDiskConsistent(c, 2);
  });

  it('janela e total: remainingInWindow nunca passa do que resta no total', async () => {
    const c = await setup({ env: { GUEST_MAX_TOTAL: '2', GUEST_MAX_PER_WINDOW: '10' } });
    const { cookie } = await signIn(c);
    const res = await uploadOk(c, await fx.jpeg(), cookie);
    expect(res.body.quota).toMatchObject({ remainingTotal: 1, remainingInWindow: 1 });
  });
});

describe('uploads concorrentes do mesmo convidado', () => {
  it('10 em paralelo com limite de 3 por janela → exatamente 3 × 201 e 7 × 429, sem órfãos', async () => {
    const c = await setup({ env: { GUEST_MAX_PER_WINDOW: '3' } });
    const { cookie } = await signIn(c);
    const image = await fx.jpeg(800, 600);

    const results = await Promise.all(Array.from({ length: 10 }, () => uploadOk(c, image, cookie)));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 201, 201, 429, 429, 429, 429, 429, 429, 429]);
    for (const r of results.filter((r) => r.status === 429)) {
      expect(r.body.error.code).toBe('quota_exceeded');
      expect(r.body.error.retryAfterSeconds).toBeGreaterThan(0);
    }
    await expectDiskConsistent(c, 3); // tmp vazio e só 3 fotos + 3 miniaturas no disco
  });

  it('10 em paralelo com limite total de 4 → exatamente 4 × 201 e 6 × 429', async () => {
    const c = await setup({ env: { GUEST_MAX_TOTAL: '4', GUEST_MAX_PER_WINDOW: '100' } });
    const { cookie } = await signIn(c);
    const image = await fx.jpeg(800, 600);

    const results = await Promise.all(Array.from({ length: 10 }, () => uploadOk(c, image, cookie)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(4);
    const blocked = results.filter((r) => r.status === 429);
    expect(blocked).toHaveLength(6);
    expect(blocked.every((r) => r.body.error.code === 'total_quota_exceeded')).toBe(true);
    await expectDiskConsistent(c, 4);
  });

  it('convidados diferentes em paralelo não se bloqueiam: cada um usa a própria cota', async () => {
    const c = await setup({ env: { GUEST_MAX_PER_WINDOW: '2' } });
    const guests = await Promise.all(['A', 'B', 'C'].map((n) => signIn(c, n)));
    const image = await fx.jpeg();
    const results = await Promise.all(guests.flatMap((g) => [0, 1, 2].map(() => uploadOk(c, image, g.cookie))));
    expect(results.filter((r) => r.status === 201)).toHaveLength(6);
    expect(results.filter((r) => r.status === 429)).toHaveLength(3);
    await expectDiskConsistent(c, 6);
  });
});

describe('idempotência por clientUploadId', () => {
  it('mesmo id duas vezes → 201 e depois 200 com a mesma foto, sem consumir cota', async () => {
    const c = await setup();
    const { cookie } = await signIn(c);
    const id = randomUUID();
    const first = await uploadOk(c, await fx.jpeg(), cookie, id);
    const second = await uploadOk(c, await fx.jpeg(), cookie, id);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.quota).toEqual(first.body.quota);
    expect(first.body.quota.remainingTotal).toBe(149);
    await expectDiskConsistent(c, 1);
  });

  it('o mesmo clientUploadId em convidados diferentes são fotos diferentes', async () => {
    const c = await setup();
    const a = await signIn(c, 'Ana');
    const b = await signIn(c, 'Bia');
    const id = randomUUID();
    const ra = await uploadOk(c, await fx.jpeg(), a.cookie, id);
    const rb = await uploadOk(c, await fx.jpeg(), b.cookie, id);
    expect([ra.status, rb.status]).toEqual([201, 201]);
    expect(ra.body.id).not.toBe(rb.body.id);
  });

  it('5 envios simultâneos do mesmo id → 1 registro, 1 × 201, 4 × 200, mesmo id e sem órfãos', async () => {
    const c = await setup();
    const { cookie } = await signIn(c);
    const id = randomUUID();
    const image = await fx.jpeg(800, 600);

    const results = await Promise.all(Array.from({ length: 5 }, () => uploadOk(c, image, cookie, id)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201]);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    await expectDiskConsistent(c, 1);
    const quota = results.find((r) => r.status === 201)!.body.quota;
    expect(quota.remainingTotal).toBe(149);
  });

  it('com a cota esgotada, repetir um id já aceito ainda responde 200 (retry legítimo)', async () => {
    const c = await setup({ env: { GUEST_MAX_PER_WINDOW: '1' } });
    const { cookie } = await signIn(c);
    const id = randomUUID();
    const first = await uploadOk(c, await fx.jpeg(), cookie, id);
    expect(first.status).toBe(201);

    const retry = await uploadOk(c, await fx.jpeg(), cookie, id);
    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe(first.body.id);
    expect((await uploadOk(c, await fx.jpeg(), cookie)).status).toBe(429); // id novo continua bloqueado
  });

  it('retry com arquivo inválido mas id já aceito → 200 (não reprocessa)', async () => {
    const c = await setup();
    const { cookie } = await signIn(c);
    const id = randomUUID();
    const first = await uploadOk(c, await fx.jpeg(), cookie, id);
    const retry = await uploadOk(c, fx.notAnImage(), cookie, id);
    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe(first.body.id);
  });
});

describe('espaço em disco', () => {
  const statfsWith = (freeMb: number) => async () => ({ bavail: (freeMb * 1024 * 1024) / 4096, bsize: 4096 });

  it('statfs simulado com 100 MB livres e mínimo de 2048 MB → 507 e nada gravado', async () => {
    const c = await setup({ env: { MIN_FREE_DISK_MB: '2048' }, statfs: statfsWith(100) });
    const { cookie } = await signIn(c);
    const res = await uploadOk(c, await fx.jpeg(), cookie);
    expect(res.status).toBe(507);
    expect(res.body.error.code).toBe('insufficient_storage');
    await expectDiskConsistent(c, 0);
  });

  it('statfs simulado com 10 GB livres → passa', async () => {
    const c = await setup({ env: { MIN_FREE_DISK_MB: '2048' }, statfs: statfsWith(10 * 1024) });
    const { cookie } = await signIn(c);
    expect((await uploadOk(c, await fx.jpeg(), cookie)).status).toBe(201);
  });

  it('exatamente o mínimo livre → passa; 1 MB abaixo → 507', async () => {
    const at = await setup({ env: { MIN_FREE_DISK_MB: '2048' }, statfs: statfsWith(2048) });
    const s1 = await signIn(at);
    expect((await uploadOk(at, await fx.jpeg(), s1.cookie)).status).toBe(201);
    const below = await setup({ env: { MIN_FREE_DISK_MB: '2048' }, statfs: statfsWith(2047) });
    const s2 = await signIn(below);
    expect((await uploadOk(below, await fx.jpeg(), s2.cookie)).status).toBe(507);
  });

  it('bavail/bsize em bigint (como o Node devolve com bigint: true) também funciona', async () => {
    const c = await setup({ env: { MIN_FREE_DISK_MB: '2048' }, statfs: async () => ({ bavail: 10_000_000n, bsize: 4096n }) });
    const { cookie } = await signIn(c);
    expect((await uploadOk(c, await fx.jpeg(), cookie)).status).toBe(201);
  });

  it('statfs real (implementação padrão): mínimo absurdo → 507; mínimo 0 → passa', async () => {
    const huge = await setup({ env: { MIN_FREE_DISK_MB: '999999999' }, statfs: defaultStatFs });
    const s1 = await signIn(huge);
    expect((await uploadOk(huge, await fx.jpeg(), s1.cookie)).status).toBe(507);

    const ok = await setup({ env: { MIN_FREE_DISK_MB: '0' }, statfs: defaultStatFs });
    const s2 = await signIn(ok);
    expect((await uploadOk(ok, await fx.jpeg(), s2.cookie)).status).toBe(201);
  });

  it('falha ao medir o disco não bloqueia o envio', async () => {
    const c = await setup({
      env: { MIN_FREE_DISK_MB: '2048' },
      statfs: async () => {
        throw new Error('statfs quebrou');
      },
    });
    const { cookie } = await signIn(c);
    expect((await uploadOk(c, await fx.jpeg(), cookie)).status).toBe(201);
  });
});

describe('rate limit de upload por IP', () => {
  it('estoura no limite → 429 rate_limited com Retry-After, vale para convidados diferentes no mesmo IP', async () => {
    const c = await setup({ env: { IP_MAX_UPLOADS_PER_WINDOW: '3' } });
    const a = await signIn(c, 'Ana', '198.51.100.1');
    const b = await signIn(c, 'Bia', '198.51.100.1');
    const image = await fx.jpeg();

    expect((await uploadOk(c, image, a.cookie, undefined, { ip: '198.51.100.1' })).status).toBe(201);
    expect((await uploadOk(c, image, a.cookie, undefined, { ip: '198.51.100.1' })).status).toBe(201);
    expect((await uploadOk(c, image, b.cookie, undefined, { ip: '198.51.100.1' })).status).toBe(201);

    const blocked = await uploadOk(c, image, a.cookie, undefined, { ip: '198.51.100.1' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('rate_limited');
    expect(blocked.body.error.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.body.error.retryAfterSeconds).toBeLessThanOrEqual(600);
    expect(Number(blocked.headers['retry-after'])).toBe(blocked.body.error.retryAfterSeconds);
    await expectDiskConsistent(c, 3);
  });

  it('outro IP continua passando e o limite vem antes da leitura do corpo e da sessão', async () => {
    const c = await setup({ env: { IP_MAX_UPLOADS_PER_WINDOW: '1' } });
    const a = await signIn(c, 'Ana', '198.51.100.1');
    const image = await fx.jpeg();
    expect((await uploadOk(c, image, a.cookie, undefined, { ip: '198.51.100.1' })).status).toBe(201);

    const noSession = await upload(c, image, { id: randomUUID(), ip: '198.51.100.1' });
    expect(noSession.status).toBe(429); // e não 401: o limite do IP é a primeira barreira

    expect((await uploadOk(c, image, a.cookie, undefined, { ip: '198.51.100.2' })).status).toBe(201);
  });

});
