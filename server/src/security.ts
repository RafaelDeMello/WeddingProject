import type { RequestHandler } from 'express';
import helmet from 'helmet';
import type { Env } from './env.js';
import { sendError } from './errors.js';

export function securityHeaders(env: Env): RequestHandler[] {
  const production = env.NODE_ENV === 'production';
  return [
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'blob:', 'data:'],
          mediaSrc: ["'self'", 'blob:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          ...(production ? { upgradeInsecureRequests: [] } : {}),
        },
      },
      strictTransportSecurity: production ? { maxAge: 180 * 24 * 60 * 60 } : false,
    }),
    (_req, res, next) => {
      res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
      next();
    },
  ];
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Em dev o front roda no Vite (localhost) ou num túnel do cloudflared com URL variável. */
function isDevOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    return url.protocol === 'http:' || url.protocol === 'https:';
  }
  return url.protocol === 'https:' && url.hostname.endsWith('.trycloudflare.com');
}

/** CSRF: além do SameSite=Lax, métodos que alteram estado exigem Origin igual ao do site. */
export function originCheck(env: Env): RequestHandler {
  return (req, res, next) => {
    if (!UNSAFE_METHODS.has(req.method)) return next();
    const origin = req.get('origin');
    const allowed =
      origin !== undefined &&
      (origin === env.PUBLIC_BASE_URL || (env.NODE_ENV === 'development' && isDevOrigin(origin)));
    if (!allowed) {
      sendError(res, 403, 'invalid_origin', 'Origem da requisição não permitida.');
      return;
    }
    next();
  };
}
