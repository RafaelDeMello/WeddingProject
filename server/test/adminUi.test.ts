import { readFileSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { baseEnv } from './helpers.js';
import { useContext } from './photoHelpers.js';

const setup = useContext();
const AUTH = `Basic ${Buffer.from(`${baseEnv.ADMIN_USER}:${baseEnv.ADMIN_PASSWORD}`).toString('base64')}`;
const UI_DIR = path.resolve(import.meta.dirname, '../admin-ui');
const source = (file: string) => readFileSync(path.join(UI_DIR, file), 'utf8');
const get = (c: Awaited<ReturnType<typeof setup>>, url: string, auth = true) => {
  const req = request(c.app).get(url);
  if (auth) req.set('Authorization', AUTH);
  return req;
};

describe('página /admin', () => {
  it.each([['/admin'], ['/admin/'], ['/admin/admin.js'], ['/admin/admin.css']])(
    '%s sem credenciais → 401 (a página também fica atrás do login)',
    async (url) => {
      const c = await setup();
      const res = await get(c, url, false);
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toMatch(/^Basic/);
      expect(res.text).not.toContain('Moderação');
    },
  );

  it('/admin com login → HTML, no-store, noindex e CSP restritiva', async () => {
    const c = await setup();
    for (const url of ['/admin', '/admin/']) {
      const res = await get(c, url);
      expect(res.status, url).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-security-policy']).toContain("script-src 'self'");
      expect(res.headers['content-security-policy']).toContain("style-src 'self'");
      expect(res.text).toContain('<ul id="grid"');
      expect(res.text).toContain('/api/admin/export.zip'); // botão do ZIP
    }
  });

  it('o HTML usa só arquivos externos: sem script, estilo ou handler inline', async () => {
    const c = await setup();
    const html = (await get(c, '/admin')).text;
    const inlineScripts = [...html.matchAll(/<script\b([^>]*)>/gi)].filter((m) => !/\bsrc=/.test(m[1]!));
    expect(inlineScripts).toEqual([]);
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/(?:src|href)="(?:https?:)?\/\//i); // nada de recursos externos
  });

  it('admin.js e admin.css são servidos com o tipo certo e sem cache', async () => {
    const c = await setup();
    const js = await get(c, '/admin/admin.js');
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toMatch(/javascript/);
    expect(js.headers['cache-control']).toBe('no-store');
    expect(js.text).toBe(source('admin.js'));
    const css = await get(c, '/admin/admin.css');
    expect(css.status).toBe(200);
    expect(css.headers['content-type']).toMatch(/text\/css/);
    expect(css.headers['cache-control']).toBe('no-store');
  });

  it('arquivos que não existem ou tentativas de sair da pasta → 404 (depois do login)', async () => {
    const c = await setup();
    expect((await get(c, '/admin/nao-existe.js')).status).toBe(404);
    expect((await get(c, '/admin/../../package.json')).status).not.toBe(200);
  });
});

describe('segurança do código da página (análise estática)', () => {
  it('admin.js não usa innerHTML/outerHTML/insertAdjacentHTML/document.write/eval (nomes de convidado são conteúdo de usuário)', () => {
    const js = source('admin.js');
    for (const forbidden of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'setAttribute(\'on']) {
      expect(js, forbidden).not.toContain(forbidden);
    }
    // O nome entra por textContent.
    expect(js).toContain('who.textContent = photo.guestName');
  });

  it('o CSS não importa nada de fora nem usa data:/url externa', () => {
    const css = source('admin.css');
    expect(css).not.toMatch(/@import/);
    expect(css).not.toMatch(/url\(/);
    expect(css).not.toMatch(/https?:\/\//);
  });
});
