import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { parseBasicAuth, safeEqual } from '../src/adminAuth.js';
import { parseEnv } from '../src/env.js';
import { baseEnv } from './helpers.js';
import { type Ctx, useContext } from './photoHelpers.js';

const setup = useContext();
const USER = baseEnv.ADMIN_USER!;
const PASSWORD = baseEnv.ADMIN_PASSWORD!;
const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

const ZIP = '/api/admin/export.zip';
const asAdmin = (c: Ctx, url = ZIP) => request(c.app).get(url).set('Authorization', basic(USER, PASSWORD));

describe('Basic Auth do admin', () => {
  it.each([['/api/admin/export.zip'], ['/admin'], ['/api/admin/qualquer-coisa'], ['/admin/admin.js']])(
    '%s sem credenciais → 401 com desafio Basic, JSON padrão e no-store',
    async (url) => {
      const c = await setup();
      const res = await request(c.app).get(url);
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toMatch(/^Basic realm="weddingrafessa"/);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toEqual({ error: { code: 'unauthorized', message: expect.any(String) } });
    },
  );

  it.each([
    ['usuário errado', basic('root', PASSWORD)],
    ['senha errada', basic(USER, 'senha-errada-000')],
    ['os dois errados', basic('root', 'nada')],
    ['senha quase certa (1 caractere a mais)', basic(USER, PASSWORD + 'x')],
    ['senha quase certa (1 caractere a menos)', basic(USER, PASSWORD.slice(0, -1))],
    ['maiúsculas no usuário', basic(USER.toUpperCase(), PASSWORD)],
    ['usuário e senha vazios', basic('', '')],
    ['esquema Bearer', `Bearer ${PASSWORD}`],
    ['Basic sem dois-pontos', `Basic ${Buffer.from(USER + PASSWORD).toString('base64')}`],
    ['Basic com base64 inválido', 'Basic !!!'],
    ['Basic vazio', 'Basic '],
    ['só "Basic"', 'Basic'],
  ])('%s → 401', async (_label, header) => {
    const c = await setup();
    const res = await request(c.app).get(ZIP).set('Authorization', header);
    expect(res.status).toBe(401);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-type']).not.toMatch(/zip/);
  });

  it('credenciais corretas → 200 e a resposta também é no-store', async () => {
    const c = await setup();
    const res = await asAdmin(c);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('o esquema "Basic" não diferencia maiúsculas (RFC 7617)', async () => {
    const c = await setup();
    const res = await request(c.app).get(ZIP).set('Authorization', `basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`);
    expect(res.status).toBe(200);
  });

  it('senha com ":" e com acentos funciona (só o primeiro ":" separa)', async () => {
    const senha = 'sênha:com:dois-pontos-é-ã-123';
    const c = await setup({ env: { ADMIN_PASSWORD: senha } });
    expect((await request(c.app).get(ZIP).set('Authorization', basic(USER, senha))).status).toBe(200);
    expect((await request(c.app).get(ZIP).set('Authorization', basic(USER, 'sênha'))).status).toBe(401);
  });

  it('caminho admin inexistente: 401 sem credenciais (não revela nada) e 404 JSON com elas', async () => {
    const c = await setup();
    expect((await request(c.app).get('/api/admin/nao-existe')).status).toBe(401);
    const res = await asAdmin(c, '/api/admin/nao-existe');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('a sessão de convidado NÃO vale no admin', async () => {
    const c = await setup();
    const guest = await request(c.app)
      .post('/api/guests')
      .set('Origin', baseEnv.PUBLIC_BASE_URL!)
      .send({ slug: c.env.EVENT_SLUG, name: 'Ana' });
    const cookie = guest.headers['set-cookie']![0]!.split(';')[0]!;
    expect((await request(c.app).get(ZIP).set('Cookie', cookie)).status).toBe(401);
  });
});

describe('limite de tentativas erradas por IP', () => {
  const ip = (n: number) => ({ 'X-Forwarded-For': `203.0.113.${n}` });
  const attempt = (c: Ctx, header: string | null, headers: Record<string, string>) => {
    const req = request(c.app).get(ZIP).set(headers);
    if (header) req.set('Authorization', header);
    return req;
  };

  it('depois de N senhas erradas → 429 com Retry-After; até a senha CERTA é recusada enquanto dura o bloqueio', async () => {
    const c = await setup({ env: { ADMIN_MAX_FAILURES_PER_WINDOW: '3' } });
    for (let i = 0; i < 3; i++) {
      expect((await attempt(c, basic(USER, `errada-${i}`), ip(1))).status).toBe(401);
    }
    const blocked = await attempt(c, basic(USER, 'errada-3'), ip(1));
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('rate_limited');
    expect(blocked.body.error.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.body.error.retryAfterSeconds).toBeLessThanOrEqual(15 * 60);
    expect(Number(blocked.headers['retry-after'])).toBe(blocked.body.error.retryAfterSeconds);
    expect(blocked.headers['cache-control']).toBe('no-store');

    // Senão o limite não impediria adivinhar a senha: o acerto também recebe 429.
    expect((await attempt(c, basic(USER, PASSWORD), ip(1))).status).toBe(429);
    // Outro IP não é afetado.
    expect((await attempt(c, basic(USER, PASSWORD), ip(2))).status).toBe(200);
  });

  it('requisições SEM credenciais (o desafio do navegador) e as bem-sucedidas não gastam a cota', async () => {
    const c = await setup({ env: { ADMIN_MAX_FAILURES_PER_WINDOW: '3' } });
    for (let i = 0; i < 12; i++) expect((await attempt(c, null, ip(1))).status).toBe(401);
    for (let i = 0; i < 12; i++) expect((await attempt(c, basic(USER, PASSWORD), ip(1))).status).toBe(200);
    // Depois de tudo isso, ainda restam as 3 tentativas erradas.
    for (let i = 0; i < 3; i++) expect((await attempt(c, basic(USER, 'x'), ip(1))).status).toBe(401);
    expect((await attempt(c, basic(USER, 'x'), ip(1))).status).toBe(429);
  });

  it('o limite é configurável; o padrão é 10 tentativas erradas', async () => {
    const { ADMIN_MAX_FAILURES_PER_WINDOW: _omit, ...rest } = baseEnv as Record<string, string>;
    expect(parseEnv(rest).ADMIN_MAX_FAILURES_PER_WINDOW).toBe(10);
    expect(parseEnv({ ...rest, ADMIN_MAX_FAILURES_PER_WINDOW: '30' }).ADMIN_MAX_FAILURES_PER_WINDOW).toBe(30);
    expect(() => parseEnv({ ...rest, ADMIN_MAX_FAILURES_PER_WINDOW: '0' })).toThrow();

    const c = await setup();
    for (let i = 0; i < 10; i++) expect((await attempt(c, basic(USER, `e${i}`), ip(5))).status).toBe(401);
    expect((await attempt(c, basic(USER, 'e10'), ip(5))).status).toBe(429);
  });
});

describe('funções auxiliares', () => {
  it('safeEqual compara em tempo constante (valores de tamanhos diferentes, vazios e com acento)', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
    expect(safeEqual('', 'a')).toBe(false);
    expect(safeEqual('é', 'é')).toBe(true);
    expect(safeEqual('é', 'e')).toBe(false);
  });

  it('parseBasicAuth', () => {
    expect(parseBasicAuth(basic('u', 'p'))).toEqual({ user: 'u', password: 'p' });
    expect(parseBasicAuth(basic('u', 'a:b:c'))).toEqual({ user: 'u', password: 'a:b:c' });
    expect(parseBasicAuth(basic('u', ''))).toEqual({ user: 'u', password: '' });
    expect(parseBasicAuth(undefined)).toBeNull();
    expect(parseBasicAuth('Bearer x')).toBeNull();
    expect(parseBasicAuth('Basic')).toBeNull();
    expect(parseBasicAuth(`Basic ${Buffer.from('semdoispontos').toString('base64')}`)).toBeNull();
  });
});
