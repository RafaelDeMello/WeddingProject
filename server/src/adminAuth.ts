import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { rateLimit, type RateLimitInfo } from 'express-rate-limit';
import type { Env } from './env.js';
import { sendError, sendRateLimited } from './errors.js';

export const ADMIN_LOGIN_WINDOW_MINUTES = 15;
const REALM = 'weddingrafessa';

const digest = (value: string) => createHash('sha256').update(value).digest();

/** Comparação em tempo constante: os dois lados viram SHA-256 (tamanho fixo) antes do timingSafeEqual. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

/** Usuário e senha do cabeçalho `Authorization: Basic …`, ou null se ausente/malformado. */
export function parseBasicAuth(header: string | undefined): { user: string; password: string } | null {
  const match = /^Basic\s+([A-Za-z0-9+/=_-]+)\s*$/i.exec(header ?? '');
  if (!match?.[1]) return null;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 0) return null;
  return { user: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

/**
 * Limite de tentativas ERRADAS por IP. Conta no início de cada requisição e devolve a vaga quando a
 * resposta é bem-sucedida. Requisição SEM credenciais (o primeiro pedido do navegador, que só recebe o
 * desafio 401) não conta. Com o limite estourado, até credenciais corretas recebem 429 — senão o
 * limite não impediria adivinhar a senha.
 */
function failedLoginLimiter(env: Env): RequestHandler {
  const windowMs = ADMIN_LOGIN_WINDOW_MINUTES * 60_000;
  return rateLimit({
    windowMs,
    limit: env.ADMIN_MAX_FAILURES_PER_WINDOW,
    standardHeaders: false,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (req, res) => res.statusCode < 400 || !req.headers.authorization,
    handler: (req, res) => {
      const info = (req as Request & { rateLimit?: RateLimitInfo }).rateLimit;
      const resetTime = info?.resetTime?.getTime() ?? Date.now() + windowMs;
      sendRateLimited(res, Math.ceil((resetTime - Date.now()) / 1000), 'Muitas tentativas de login.');
    },
  });
}

/** Tudo do admin: nunca em cache, limite de falhas e Basic Auth com comparação em tempo constante. */
export function adminAuth(env: Env): RequestHandler[] {
  const noStore: RequestHandler = (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    next();
  };

  const authenticate: RequestHandler = (req, res, next) => {
    const credentials = parseBasicAuth(req.headers.authorization);
    // Sempre compara usuário e senha (sem curto-circuito) para o tempo não revelar qual errou.
    const userOk = safeEqual(credentials?.user ?? '', env.ADMIN_USER);
    const passwordOk = safeEqual(credentials?.password ?? '', env.ADMIN_PASSWORD);
    if (credentials && userOk && passwordOk) return next();

    res.setHeader('WWW-Authenticate', `Basic realm="${REALM}", charset="UTF-8"`);
    sendError(res, 401, 'unauthorized', 'Autenticação necessária.');
  };

  return [noStore, failedLoginLimiter(env), authenticate];
}
