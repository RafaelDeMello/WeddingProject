import type { Guest, PrismaClient } from '@prisma/client';
import type { CookieOptions, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import type { Env } from './env.js';
import { sendError } from './errors.js';

export const SESSION_COOKIE = 'wr_session';

declare global {
  namespace Express {
    interface Request {
      guest?: Guest;
    }
  }
}

function baseOptions(env: Env): CookieOptions {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  };
}

export function setSessionCookie(res: Response, env: Env, guestId: string) {
  res.cookie(SESSION_COOKIE, guestId, {
    ...baseOptions(env),
    signed: true,
    expires: new Date(env.UPLOAD_CLOSES_AT.getTime() + 24 * 60 * 60_000),
  });
}

export function clearSessionCookie(res: Response, env: Env) {
  res.clearCookie(SESSION_COOKIE, baseOptions(env));
}

const guestIdSchema = z.uuid();

/**
 * Guest da sessão, ou null. O cookie-parser devolve `false` para assinatura inválida
 * e deixa em `req.cookies` (não em `signedCookies`) um cookie sem assinatura.
 */
export async function loadSessionGuest(req: Request, prisma: PrismaClient): Promise<Guest | null> {
  const parsed = guestIdSchema.safeParse(req.signedCookies?.[SESSION_COOKIE]);
  if (!parsed.success) return null;
  return prisma.guest.findUnique({ where: { id: parsed.data } });
}

const hasSessionCookie = (req: Request) =>
  req.cookies?.[SESSION_COOKIE] !== undefined || req.signedCookies?.[SESSION_COOKIE] !== undefined;

export function requireGuest(env: Env, prisma: PrismaClient): RequestHandler {
  return async (req, res, next) => {
    const guest = await loadSessionGuest(req, prisma);
    if (!guest) {
      if (hasSessionCookie(req)) clearSessionCookie(res, env);
      sendError(res, 401, 'unauthorized', 'Sessão inválida. Informe seu nome novamente.');
      return;
    }
    req.guest = guest;
    next();
  };
}
