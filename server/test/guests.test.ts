import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestContext, ORIGIN } from './helpers.js';

const WINDOW = {
  UPLOAD_OPENS_AT: '2026-10-03T00:00:00-03:00',
  UPLOAD_CLOSES_AT: '2026-10-06T23:59:59-03:00',
};
const DURING = new Date('2026-10-03T21:00:00-03:00');

let ctx: Awaited<ReturnType<typeof createTestContext>> | undefined;
afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

async function setup(now = DURING, overrides: Record<string, string> = {}) {
  ctx = await createTestContext({ ...WINDOW, ...overrides }, { now: () => now });
  return ctx;
}

const createGuest = (app: Parameters<typeof request>[0], body: unknown) =>
  request(app).post('/api/guests').set('Origin', ORIGIN).send(body as object);

describe('POST /api/guests', () => {
  it('nome válido → 201 com guestId, nome, cota cheia e cookie de sessão', async () => {
    const { app, env, prisma } = await setup();
    const res = await createGuest(app, { slug: env.EVENT_SLUG, name: '  Tia   Célia  ' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      guestId: expect.any(String),
      name: 'Tia Célia',
      quota: { remainingInWindow: 10, remainingTotal: 150, resetsAt: null },
    });
    expect(res.headers['set-cookie']?.[0]).toMatch(/^wr_session=s%3A/);

    const guest = await prisma.guest.findUniqueOrThrow({ where: { id: res.body.guestId } });
    expect(guest.name).toBe('Tia Célia');
  });

  it('normaliza para NFC e remove caracteres invisíveis, mantendo emoji com ZWJ', async () => {
    const { app, env } = await setup();
    const nfd = 'José'; // "José" decomposto
    const res = await createGuest(app, { slug: env.EVENT_SLUG, name: `‮${nfd}\u0007 👨‍👩‍👧` });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('José 👨‍👩‍👧');
    expect(res.body.name).toBe(res.body.name.normalize('NFC'));
  });

  it('aceita 40 caracteres contando emoji como um', async () => {
    const { app, env } = await setup();
    const res = await createGuest(app, { slug: env.EVENT_SLUG, name: '😀'.repeat(40) });
    expect(res.status).toBe(201);
  });

  it.each([
    ['vazio', ''],
    ['só espaços', '   '],
    ['só caracteres de controle', '\u0000\u0007\u001b'],
    ['41 caracteres', 'a'.repeat(41)],
    ['não é string', 123],
    ['ausente', undefined],
  ])('nome inválido (%s) → 400 validation_error', async (_label, name) => {
    const { app, env, prisma } = await setup();
    const res = await createGuest(app, { slug: env.EVENT_SLUG, name });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(await prisma.guest.count()).toBe(0);
  });

  it('slug errado → 404 event_not_found', async () => {
    const { app, prisma } = await setup();
    const res = await createGuest(app, { slug: 'outro-evento', name: 'Ana' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('event_not_found');
    expect(await prisma.guest.count()).toBe(0);
  });

  it.each([
    ['antes da abertura', new Date('2026-10-02T23:59:59-03:00'), /ainda não abriu/],
    ['depois do encerramento', new Date('2026-10-07T00:00:00-03:00'), /encerrado/],
  ])('fora da janela (%s) → 403 upload_closed', async (_label, now, message) => {
    const { app, env, prisma } = await setup(now);
    const res = await createGuest(app, { slug: env.EVENT_SLUG, name: 'Ana' });
    expect(res.status).toBe(403);
    expect(res.body.error).toEqual({ code: 'upload_closed', message: expect.stringMatching(message) });
    expect(await prisma.guest.count()).toBe(0);
  });

  it('com sessão válida → 200 com o mesmo guest, sem criar outro', async () => {
    const { app, env, prisma } = await setup();
    const agent = request.agent(app);
    const first = await agent.post('/api/guests').set('Origin', ORIGIN).send({ slug: env.EVENT_SLUG, name: 'Ana' });
    const second = await agent.post('/api/guests').set('Origin', ORIGIN).send({ slug: env.EVENT_SLUG, name: 'Bia' });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.guestId).toBe(first.body.guestId);
    expect(second.body.name).toBe('Ana');
    expect(await prisma.guest.count()).toBe(1);
  });

  it('guarda ipHash (sha256 de ip + segredo) e nunca o IP em claro', async () => {
    const { app, env, prisma } = await setup();
    const res = await request(app)
      .post('/api/guests')
      .set('Origin', ORIGIN)
      .set('X-Forwarded-For', '203.0.113.7')
      .set('User-Agent', 'x'.repeat(300))
      .send({ slug: env.EVENT_SLUG, name: 'Ana' });

    const guest = await prisma.guest.findUniqueOrThrow({ where: { id: res.body.guestId } });
    expect(guest.ipHash).toBe(createHash('sha256').update('203.0.113.7' + env.SESSION_SECRET).digest('hex'));
    expect(guest.ipHash).not.toContain('203.0.113.7');
    expect(guest.userAgent).toHaveLength(255);
  });
});
