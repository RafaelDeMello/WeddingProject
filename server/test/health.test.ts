import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, ORIGIN } from './helpers.js';

describe('app base', () => {
  let ctx: Awaited<ReturnType<typeof createTestContext>>;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(() => ctx.cleanup());

  it('GET /api/health → 200 { ok: true }', async () => {
    const res = await request(ctx.app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('rota /api desconhecida → 404 no formato de erro padrão', async () => {
    const res = await request(ctx.app).get('/api/nao-existe');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'not_found', message: expect.any(String) } });
  });

  it('JSON acima de 10kb → 413 no formato de erro padrão', async () => {
    const res = await request(ctx.app)
      .post('/api/nao-existe')
      .set('Origin', ORIGIN)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ x: 'a'.repeat(11 * 1024) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('payload_too_large');
  });

  it('JSON malformado → 400 invalid_json', async () => {
    const res = await request(ctx.app)
      .post('/api/nao-existe')
      .set('Origin', ORIGIN)
      .set('Content-Type', 'application/json')
      .send('{x');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_json');
  });
});

describe('banco de dados', () => {
  let ctx: Awaited<ReturnType<typeof createTestContext>>;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(() => ctx.cleanup());

  it('SQLite em modo WAL', async () => {
    expect(ctx.journalMode).toBe('wal');
    const rows = await ctx.prisma.$queryRawUnsafe<{ journal_mode: string }[]>('PRAGMA journal_mode;');
    expect(rows[0]?.journal_mode).toBe('wal');
  });

  it('migração aplicada: cria Guest e Photo e respeita unique (guestId, clientUploadId)', async () => {
    const guest = await ctx.prisma.guest.create({ data: { name: 'Ana' } });
    const photo = {
      guestId: guest.id,
      clientUploadId: 'c1',
      filePath: 'p',
      thumbPath: 't',
      sizeBytes: 1,
      width: 1,
      height: 1,
    };
    await ctx.prisma.photo.create({ data: photo });
    await expect(ctx.prisma.photo.create({ data: photo })).rejects.toMatchObject({ code: 'P2002' });
  });
});
