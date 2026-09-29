import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestContext, ORIGIN } from './helpers.js';

let ctx: Awaited<ReturnType<typeof createTestContext>> | undefined;
afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

/** Cria um guest e devolve o par `nome=valor` do cookie assinado. */
async function signIn(overrides: Record<string, string> = {}) {
  ctx = await createTestContext(overrides);
  const res = await request(ctx.app)
    .post('/api/guests')
    .set('Origin', ORIGIN)
    .send({ slug: ctx.env.EVENT_SLUG, name: 'Ana' });
  expect(res.status).toBe(201);
  const setCookie = res.headers['set-cookie']![0]!;
  return { ctx, guestId: res.body.guestId as string, setCookie, cookie: setCookie.split(';')[0]! };
}

function expectCookieCleared(res: request.Response) {
  expect(res.headers['set-cookie']?.[0]).toMatch(/^wr_session=;.*Expires=Thu, 01 Jan 1970/);
}

describe('GET /api/me', () => {
  it('com sessão válida → nome e cota cheia com resetsAt null', async () => {
    const { ctx, guestId, cookie } = await signIn();
    const res = await request(ctx.app).get('/api/me').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      guestId,
      name: 'Ana',
      quota: { remainingInWindow: 10, remainingTotal: 150, resetsAt: null },
    });
  });

  it('sem cookie → 401 unauthorized', async () => {
    ctx = await createTestContext();
    const res = await request(ctx.app).get('/api/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('cookie adulterado (outro guestId com a assinatura antiga) → 401 e cookie apagado', async () => {
    const { ctx, guestId, cookie } = await signIn();
    const other = await ctx.prisma.guest.create({ data: { name: 'Intrusa' } });
    const tampered = cookie.replace(guestId, other.id);
    expect(tampered).not.toBe(cookie);

    const res = await request(ctx.app).get('/api/me').set('Cookie', tampered);
    expect(res.status).toBe(401);
    expectCookieCleared(res);
  });

  it('cookie com assinatura alterada → 401', async () => {
    const { ctx, cookie } = await signIn();
    const res = await request(ctx.app).get('/api/me').set('Cookie', cookie.slice(0, -3) + 'AAA');
    expect(res.status).toBe(401);
  });

  it('cookie sem assinatura (guestId existente em claro) → 401', async () => {
    const { ctx, guestId } = await signIn();
    const res = await request(ctx.app).get('/api/me').set('Cookie', `wr_session=${guestId}`);
    expect(res.status).toBe(401);
    expectCookieCleared(res);
  });

  it('cookie assinado com outro segredo → 401', async () => {
    const { cookie } = await signIn({ SESSION_SECRET: 'b'.repeat(64) });
    const first = ctx!;
    ctx = await createTestContext(); // mesmo banco-modelo, segredo padrão ('a'…)
    const res = await request(ctx.app).get('/api/me').set('Cookie', cookie);
    expect(res.status).toBe(401);
    await first.cleanup();
  });

  it('assinatura válida mas guest inexistente no banco → 401 e cookie apagado', async () => {
    const { ctx, guestId, cookie } = await signIn();
    await ctx.prisma.guest.delete({ where: { id: guestId } });
    const res = await request(ctx.app).get('/api/me').set('Cookie', cookie);
    expect(res.status).toBe(401);
    expectCookieCleared(res);
  });

  it('POST /api/guests com cookie de guest inexistente cria um guest novo', async () => {
    const { ctx, guestId, cookie } = await signIn();
    await ctx.prisma.guest.delete({ where: { id: guestId } });
    const res = await request(ctx.app)
      .post('/api/guests')
      .set('Origin', ORIGIN)
      .set('Cookie', cookie)
      .send({ slug: ctx.env.EVENT_SLUG, name: 'Ana' });
    expect(res.status).toBe(201);
    expect(res.body.guestId).not.toBe(guestId);
  });

});

describe('flags do cookie de sessão', () => {
  it('produção: HttpOnly, Secure, SameSite=Lax, Path=/ e expira 1 dia após o fechamento', async () => {
    const { setCookie } = await signIn({ NODE_ENV: 'production' });
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/; Secure/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).toMatch(/Path=\//);
    const expires = new Date(/Expires=([^;]+)/.exec(setCookie)![1]!);
    expect(expires.getTime()).toBe(ctx!.env.UPLOAD_CLOSES_AT.getTime() + 24 * 60 * 60_000);
  });

  it('desenvolvimento: sem Secure (localhost em http)', async () => {
    ctx = await createTestContext({ NODE_ENV: 'development', PUBLIC_BASE_URL: 'http://localhost:5173' });
    const res = await request(ctx.app)
      .post('/api/guests')
      .set('Origin', 'http://localhost:5173')
      .send({ slug: ctx.env.EVENT_SLUG, name: 'Ana' });
    const setCookie = res.headers['set-cookie']![0]!;
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).not.toMatch(/Secure/);
  });
});

describe('POST /api/session/logout', () => {
  it('apaga o cookie; a sessão antiga some do navegador e o guest continua no banco', async () => {
    const { ctx, guestId, cookie } = await signIn();
    const agent = request.agent(ctx.app);
    agent.jar.setCookie(`${cookie}; Path=/`, '127.0.0.1', '/');

    expect((await agent.get('/api/me')).status).toBe(200);
    const res = await agent.post('/api/session/logout').set('Origin', ORIGIN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expectCookieCleared(res);
    expect((await agent.get('/api/me')).status).toBe(401);
    expect(await ctx.prisma.guest.count({ where: { id: guestId } })).toBe(1);
  });

  it('sem sessão também responde 200 (idempotente)', async () => {
    ctx = await createTestContext();
    const res = await request(ctx.app).post('/api/session/logout').set('Origin', ORIGIN);
    expect(res.status).toBe(200);
  });

  it('exige Origin válido', async () => {
    const { ctx, cookie } = await signIn();
    const res = await request(ctx.app)
      .post('/api/session/logout')
      .set('Origin', 'https://evil.example')
      .set('Cookie', cookie);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('invalid_origin');
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});
