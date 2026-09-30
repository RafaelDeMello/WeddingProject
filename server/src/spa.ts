import { existsSync } from 'node:fs';
import path from 'node:path';
import express, { Router, type RequestHandler } from 'express';
import type { Env } from './env.js';

// server/src/spa.ts e server/dist/spa.js ficam na mesma profundidade: ../../web/dist nos dois casos.
const DEFAULT_WEB_DIST = path.resolve(import.meta.dirname, '../../web/dist');

/** Diretório do build do front, ou null se não existir (dev com Vite, testes do backend). */
export function resolveWebDist(env: Env): string | null {
  const dir = env.WEB_DIST_DIR ?? DEFAULT_WEB_DIST;
  return existsSync(path.join(dir, 'index.html')) ? dir : null;
}

const NOT_FOUND_HTML = `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>Página não encontrada</title>
  </head>
  <body>
    <p>Página não encontrada.</p>
  </body>
</html>
`;

const sendNotFound: RequestHandler = (_req, res) => {
  res.status(404).set('Cache-Control', 'no-store').type('html').send(NOT_FOUND_HTML);
};

const YEAR_SECONDS = 365 * 24 * 60 * 60;

/**
 * Serve o front compilado. A única "página" é /e/<EVENT_SLUG> (o QR das mesas); com outro slug,
 * ou em qualquer outro caminho, a resposta é um 404 simples que não entrega o app.
 * Só o conteúdo de `webDist` é servido — nunca DATA_DIR.
 */
export function spaRoutes(env: Env, webDist: string): Router {
  const router = Router();
  const indexFile = path.join(webDist, 'index.html');

  router.use((_req, res, next) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow'); // evento privado
    next();
  });

  router.get('/e/:slug', (req, res, next) => {
    if (req.params.slug !== env.EVENT_SLUG) return next();
    // index.html muda a cada deploy (aponta para assets com hash novo): nunca fica em cache.
    res.sendFile(indexFile, { headers: { 'Cache-Control': 'no-cache' } });
  });

  // index.html só é entregue pela rota acima (com a checagem do slug).
  router.use((req, res, next) => {
    if (req.path === '/index.html') return sendNotFound(req, res, next);
    next();
  });

  router.use(
    express.static(webDist, {
      index: false,
      dotfiles: 'ignore',
      redirect: false,
      setHeaders(res, filePath) {
        const inAssets = filePath.split(path.sep).includes('assets');
        // Arquivos de /assets têm hash no nome: podem ficar em cache "para sempre".
        res.setHeader('Cache-Control', inAssets ? `public, max-age=${YEAR_SECONDS}, immutable` : 'public, max-age=3600');
      },
    }),
  );

  router.use(sendNotFound);
  return router;
}
