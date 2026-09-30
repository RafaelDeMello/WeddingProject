import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { parseEnv } from '../src/env.js';
import { baseEnv, createTestContext, ORIGIN } from './helpers.js';

let ctx: Awaited<ReturnType<typeof createTestContext>> | undefined;
afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const postGuest = (origin: string | undefined, xff?: string) => {
  const req = request(ctx!.app).post('/api/guests');
  if (origin !== undefined) req.set('Origin', origin);
  if (xff) req.set('X-Forwarded-For', xff);
  return req.send({ slug: ctx!.env.EVENT_SLUG, name: 'Ana' });
};

describe('checagem de Origin — produção (estrita)', () => {
  it.each([
    ['ausente', undefined],
    ['outro domínio', 'https://evil.example'],
    ['subdomínio parecido', 'https://weddingrafessa.example.com.evil.example'],
    ['http em vez de https', 'http://weddingrafessa.example.com'],
    ['"null" (iframe sandbox / file://)', 'null'],
    ['localhost', 'http://localhost:5173'],
    ['túnel trycloudflare', 'https://abc-def.trycloudflare.com'],
  ])('Origin %s → 403 invalid_origin, sem criar guest', async (_label, origin) => {
    ctx = await createTestContext({ NODE_ENV: 'production' });
    const res = await postGuest(origin);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('invalid_origin');
    expect(await ctx.prisma.guest.count()).toBe(0);
  });

  it('Origin igual a PUBLIC_BASE_URL → passa', async () => {
    ctx = await createTestContext({ NODE_ENV: 'production' });
    expect((await postGuest(ORIGIN)).status).toBe(201);
  });

  it('GET não exige Origin', async () => {
    ctx = await createTestContext({ NODE_ENV: 'production' });
    expect((await request(ctx.app).get('/api/event')).status).toBe(200);
  });
});

describe('checagem de Origin — desenvolvimento (relaxada)', () => {
  const devEnv = { NODE_ENV: 'development', PUBLIC_BASE_URL: 'http://localhost:5173' };

  it.each([
    ['PUBLIC_BASE_URL', 'http://localhost:5173'],
    ['localhost em outra porta', 'http://localhost:3000'],
    ['127.0.0.1', 'http://127.0.0.1:5173'],
    ['túnel trycloudflare', 'https://abc-def.trycloudflare.com'],
  ])('Origin %s → passa', async (_label, origin) => {
    ctx = await createTestContext(devEnv);
    expect((await postGuest(origin)).status).toBe(201);
  });

  it.each([
    ['ausente', undefined],
    ['outro domínio', 'https://evil.example'],
    ['trycloudflare em http', 'http://abc.trycloudflare.com'],
    ['domínio terminando em trycloudflare.com sem ponto', 'https://eviltrycloudflare.com'],
  ])('Origin %s → 403', async (_label, origin) => {
    ctx = await createTestContext(devEnv);
    expect((await postGuest(origin)).status).toBe(403);
  });
});

describe('headers de segurança', () => {
  it('CSP restritiva, Permissions-Policy com câmera e sem X-Powered-By', async () => {
    ctx = await createTestContext({ NODE_ENV: 'production' });
    const res = await request(ctx.app).get('/api/health');
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("img-src 'self' blob: data:");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain('upgrade-insecure-requests');
    expect(res.headers['permissions-policy']).toBe('camera=(self), microphone=(), geolocation=()');
    expect(res.headers['strict-transport-security']).toMatch(/max-age=/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('dev: sem HSTS nem upgrade-insecure-requests (localhost em http)', async () => {
    ctx = await createTestContext({ NODE_ENV: 'development', PUBLIC_BASE_URL: 'http://localhost:5173' });
    const res = await request(ctx.app).get('/api/health');
    expect(res.headers['strict-transport-security']).toBeUndefined();
    expect(res.headers['content-security-policy']).not.toContain('upgrade-insecure-requests');
  });
});

describe('rate limit de criação de convidado por IP', () => {
  it('estoura no limite com 429, Retry-After e retryAfterSeconds; outro IP continua passando', async () => {
    ctx = await createTestContext({ IP_MAX_GUESTS_PER_WINDOW: '3' });
    for (let i = 0; i < 3; i++) {
      expect((await postGuest(ORIGIN, '198.51.100.1')).status).toBe(201);
    }
    const blocked = await postGuest(ORIGIN, '198.51.100.1');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('rate_limited');
    expect(blocked.body.error.message).toMatch(/Tente novamente em 10 min/);
    expect(blocked.body.error.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.body.error.retryAfterSeconds).toBeLessThanOrEqual(600);
    expect(Number(blocked.headers['retry-after'])).toBe(blocked.body.error.retryAfterSeconds);

    expect((await postGuest(ORIGIN, '198.51.100.2')).status).toBe(201);
    expect(await ctx.prisma.guest.count()).toBe(4);
  });

  it('usa os padrões (150 convidados, 1000 uploads por IP) quando as envs não são definidas', async () => {
    const { IP_MAX_GUESTS_PER_WINDOW, IP_MAX_UPLOADS_PER_WINDOW, IP_MAX_GALLERY_PER_WINDOW, ...rest } = baseEnv as Record<string, string>;
    const env = parseEnv(rest);
    expect(env.IP_MAX_GUESTS_PER_WINDOW).toBe(150);
    expect(env.IP_MAX_UPLOADS_PER_WINDOW).toBe(1000);
    expect(env.IP_MAX_GALLERY_PER_WINDOW).toBe(100000);
  });
});
