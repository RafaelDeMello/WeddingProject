import type { Request } from 'express';
import { rateLimit, type RateLimitInfo } from 'express-rate-limit';
import type { Env } from './env.js';
import { sendRateLimited } from './errors.js';

export const IP_WINDOW_MINUTES = 10;

/**
 * Proteção contra abuso por IP. É generosa de propósito: dezenas de convidados dividem o IP do
 * Wi-Fi do salão (ou do CGNAT do 4G) — a cota real é por convidado.
 */
function ipLimiter(limit: number, message: string) {
  const windowMs = IP_WINDOW_MINUTES * 60_000;
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res) => {
      const info = (req as Request & { rateLimit?: RateLimitInfo }).rateLimit;
      const resetTime = info?.resetTime?.getTime() ?? Date.now() + windowMs;
      sendRateLimited(res, Math.ceil((resetTime - Date.now()) / 1000), message);
    },
  });
}

export const guestCreationLimiter = (env: Env) =>
  ipLimiter(env.IP_MAX_GUESTS_PER_WINDOW, 'Muitas tentativas a partir desta rede.');

/** Conta toda tentativa de upload, inclusive as inválidas e os retries. */
export const photoUploadLimiter = (env: Env) =>
  ipLimiter(env.IP_MAX_UPLOADS_PER_WINDOW, 'Muitos envios a partir desta rede.');
