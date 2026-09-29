import type { Prisma, PrismaClient } from '@prisma/client';
import type { Env } from './env.js';

export interface Quota {
  remainingInWindow: number;
  remainingTotal: number;
  /** Quando a foto mais antiga da janela deixa de contar; null se não há fotos na janela. */
  resetsAt: string | null;
}

type Db = PrismaClient | Prisma.TransactionClient;

/** Fotos ocultas continuam contando: a cota mede o que o convidado enviou. */
export async function getQuota(db: Db, env: Env, guestId: string, now: Date): Promise<Quota> {
  const windowMs = env.GUEST_WINDOW_MINUTES * 60_000;
  const windowStart = new Date(now.getTime() - windowMs);
  const inWindow = { guestId, createdAt: { gt: windowStart } };

  const [total, countInWindow, oldestInWindow] = await Promise.all([
    db.photo.count({ where: { guestId } }),
    db.photo.count({ where: inWindow }),
    db.photo.findFirst({ where: inWindow, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
  ]);

  const remainingTotal = Math.max(0, env.GUEST_MAX_TOTAL - total);
  return {
    remainingInWindow: Math.max(0, Math.min(env.GUEST_MAX_PER_WINDOW - countInWindow, remainingTotal)),
    remainingTotal,
    resetsAt: oldestInWindow ? new Date(oldestInWindow.createdAt.getTime() + windowMs).toISOString() : null,
  };
}
