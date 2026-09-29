import type { Request } from 'express';
import { rateLimit, type RateLimitInfo } from 'express-rate-limit';
import type { Env } from './env.js';
import { sendRateLimited } from './errors.js';

export const IP_WINDOW_MINUTES = 10;

/** Proteção contra abuso por IP (o Wi-Fi do salão é compartilhado — a cota real é por convidado). */
export function guestCreationLimiter(env: Env) {
  const windowMs = IP_WINDOW_MINUTES * 60_000;
  return rateLimit({
    windowMs,
    limit: env.IP_MAX_GUESTS_PER_WINDOW,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res) => {
      const info = (req as Request & { rateLimit?: RateLimitInfo }).rateLimit;
      const resetTime = info?.resetTime?.getTime() ?? Date.now() + windowMs;
      sendRateLimited(res, Math.ceil((resetTime - Date.now()) / 1000), 'Muitas tentativas a partir desta rede.');
    },
  });
}
