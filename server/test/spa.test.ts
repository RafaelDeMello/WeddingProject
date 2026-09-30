import { readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, inject } from 'vitest';
import { createTestContext } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof createTestContext>>;

const webDist = inject('webDist');
const SLUG = 'teste1'; // EVENT_SLUG do baseEnv

let ctx: Ctx | undefined;
afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const setup = async (overrides: Record<string, string> = {}) => {
  ctx = await createTestContext({ WEB_DIST_DIR: webDist, NODE_ENV: 'production', ...overrides });
  return ctx;
};

const indexHtml = () => readFileSync(path.join(webDist, 'index.html'), 'utf8');

/** Caminhos /assets/... referenciados pelo index.html compilado. */
const referencedAssets = () => [...indexHtml().matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]!);

/** Requisição HTTP "crua": o cliente do supertest normalizaria `%2e%2e` em `..` antes de enviar. */
async function rawGet(c: Ctx, rawPath: string) {
  const server = c.app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    return await new Promise<{ status: number; body: string }>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: rawPath }, (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        })
        .on('error', reject);
    });
  } finally {
    server.close();
  }
}

describe('GET /e/:slug', () => {
  it('slug correto → 200 com o index.html do build, sem cache e com CSP', async () => {
    const c = await setup();
    const res = await request(c.app).get(`/e/${SLUG}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(res.text).toBe(indexHtml());
    expect(res.text).toContain('<div id="root">');
  });

  it('com barra no final e HEAD também funcionam', async () => {
    const c = await setup();
    expect((await request(c.app).get(`/e/${SLUG}/`)).status).toBe(200);
    expect((await request(c.app).head(`/e/${SLUG}`)).status).toBe(200);
  });

  it.each([
    ['slug errado', '/e/outro'],
    ['slug com maiúsculas diferentes', `/e/${SLUG.toUpperCase()}`],
    ['sem slug', '/e/'],
    ['subcaminho do slug', `/e/${SLUG}/extra`],
    ['raiz', '/'],
    ['index.html direto', '/index.html'],
    ['caminho qualquer', '/admin'],
  ])('%s → 404 HTML simples, sem entregar o app', async (_label, url) => {
    const c = await setup();
    const res = await request(c.app).get(url);
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).not.toContain('id="root"');
    expect(res.text).not.toContain('<script');
  });

  it('POST fora de /api também cai no 404 simples', async () => {
    const c = await setup();
    expect((await request(c.app).post(`/e/${SLUG}`)).status).toBe(404);
  });

  it('rotas /api continuam em JSON (o SPA não as captura)', async () => {
    const c = await setup();
    const res = await request(c.app).get('/api/nao-existe');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
    expect((await request(c.app).get('/api/health')).body).toEqual({ ok: true });
  });

  it('sem build do front, /e/:slug não existe e a API segue funcionando', async () => {
    const c = await setup({ WEB_DIST_DIR: '/nonexistent-web-dist' });
    const res = await request(c.app).get(`/e/${SLUG}`);
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('id="root"');
    expect((await request(c.app).get('/api/health')).status).toBe(200);
  });
});

describe('/assets', () => {
  it('serve cada arquivo do build com o tipo certo e cache imutável de 1 ano', async () => {
    const c = await setup();
    const assets = referencedAssets();
    expect(assets.length).toBeGreaterThan(0);
    for (const asset of assets) {
      const res = await request(c.app).get(asset);
      expect(res.status, asset).toBe(200);
      expect(res.headers['cache-control'], asset).toBe('public, max-age=31536000, immutable');
      if (asset.endsWith('.js')) expect(res.headers['content-type']).toMatch(/javascript/);
      if (asset.endsWith('.css')) expect(res.headers['content-type']).toMatch(/text\/css/);
    }
  });

  it('asset inexistente (hash antigo após um deploy) → 404 simples', async () => {
    const c = await setup();
    const res = await request(c.app).get('/assets/index-antigo.js');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('id="root"');
  });

  it.each([
    ['../ codificado até o banco-modelo', '/%2e%2e/template.db'],
    ['../ duplo dentro de /assets', '/assets/%2e%2e/%2e%2e/template.db'],
    ['barra invertida', '/assets/..%5c..%5ctemplate.db'],
    ['byte nulo', '/assets/%00.js'],
  ])('path traversal (%s) não vaza nada fora do build', async (_label, rawPath) => {
    const c = await setup();
    const res = await rawGet(c, rawPath);
    expect([400, 403, 404]).toContain(res.status);
    expect(res.body).not.toContain('SQLite');
  });

  it('nada de DATA_DIR é servido: fotos, miniaturas e banco não têm rota pública', async () => {
    const c = await setup();
    for (const url of ['/photos/x.jpg', '/thumbs/x.jpg', '/data/db/app.db', '/db/app.db', '/.env']) {
      const res = await request(c.app).get(url);
      expect(res.status, url).toBe(404);
    }
  });
});

describe('o build é compatível com a CSP (script-src/style-src/font-src/img-src)', () => {
  const files = (ext: string) =>
    readdirSync(path.join(webDist, 'assets'))
      .filter((f) => f.endsWith(ext))
      .map((f) => ({ name: f, text: readFileSync(path.join(webDist, 'assets', f), 'utf8') }));

  it('index.html não tem script, estilo ou handler inline nem recursos de outra origem', () => {
    const html = indexHtml();
    const inlineScripts = [...html.matchAll(/<script\b([^>]*)>/gi)].filter((m) => !/\bsrc=/.test(m[1]!));
    expect(inlineScripts).toEqual([]);
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\son[a-z]+=/i); // onclick=, onload=…
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/(?:src|href)="(?:https?:)?\/\//i);
    for (const ref of [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]!)) {
      expect(ref.startsWith('/'), ref).toBe(true);
    }
  });

  it('CSS usa só arquivos da própria origem ou data:image (font-src não permite data:)', () => {
    for (const { name, text } of files('.css')) {
      expect(text, name).not.toMatch(/@import\s+(?:url\()?["']?(?:https?:)?\/\//i);
      for (const m of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
        const url = m[1]!;
        const ok = url.startsWith('data:image/') || (!/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('//'));
        expect(ok, `${name}: url(${url.slice(0, 40)})`).toBe(true);
      }
    }
  });

  it('JS não usa eval nem new Function (script-src não tem unsafe-eval)', () => {
    for (const { name, text } of files('.js')) {
      expect(text, name).not.toMatch(/\beval\(/);
      expect(text, name).not.toMatch(/new Function\(/);
    }
  });

  it('todo arquivo do build em /assets é servido com 200 (fontes, SVGs, imagens incluídos)', async () => {
    const c = await setup();
    for (const { name } of files('')) {
      const res = await request(c.app).get(`/assets/${name}`);
      expect(res.status, name).toBe(200);
    }
  });
});
