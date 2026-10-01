import type { PrismaClient } from '@prisma/client';
import { decodeCursor, encodeCursor } from './gallery.js';

export const ADMIN_DEFAULT_LIMIT = 60;
export const ADMIN_MAX_LIMIT = 100;

export interface AdminPhoto {
  id: string;
  guestName: string;
  createdAt: string;
  /** Oculta pelo admin OU apagada pelo próprio convidado (não há distinção). */
  hidden: boolean;
  thumbUrl: string;
  photoUrl: string;
}

export { decodeCursor };

/** Todas as fotos, inclusive as ocultas, das mais recentes para as mais antigas (mesmo cursor da galeria). */
export async function listAdminPhotos(
  prisma: PrismaClient,
  { limit, cursor }: { limit: number; cursor: { createdAt: Date; id: string } | null },
): Promise<{ items: AdminPhoto[]; nextCursor: string | null }> {
  const rows = await prisma.photo.findMany({
    where: cursor
      ? {
          OR: [
            { createdAt: { lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { lt: cursor.id } },
          ],
        }
      : {},
    include: { guest: { select: { name: true } } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((p) => ({
      id: p.id,
      guestName: p.guest.name,
      createdAt: p.createdAt.toISOString(),
      hidden: p.hiddenAt !== null,
      thumbUrl: `/api/admin/photos/${p.id}/thumb`,
      photoUrl: `/api/admin/photos/${p.id}`,
    })),
    nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
  };
}

export async function adminCounts(prisma: PrismaClient): Promise<{ total: number; hidden: number }> {
  const [total, hidden] = await Promise.all([
    prisma.photo.count(),
    prisma.photo.count({ where: { hiddenAt: { not: null } } }),
  ]);
  return { total, hidden };
}

/**
 * Oculta ou reexibe uma foto: grava `hiddenAt` e `visibilityChangedAt` (mesmo instante). Idempotente — se a
 * foto já está no estado pedido, não mexe em nada (os timestamps do primeiro efeito ficam). Não distingue
 * foto ocultada pelo admin de foto apagada pelo dono: reexibir traz as duas de volta.
 * Devolve false se a foto não existe.
 */
export async function setPhotoHidden(
  prisma: PrismaClient,
  id: string,
  hidden: boolean,
  when: Date,
): Promise<boolean> {
  const exists = await prisma.photo.findUnique({ where: { id }, select: { id: true } });
  if (!exists) return false;
  // Condicional: chamadas simultâneas resultam numa única mudança.
  if (hidden) {
    await prisma.photo.updateMany({
      where: { id, hiddenAt: null },
      data: { hiddenAt: when, visibilityChangedAt: when },
    });
  } else {
    await prisma.photo.updateMany({
      where: { id, hiddenAt: { not: null } },
      data: { hiddenAt: null, visibilityChangedAt: when },
    });
  }
  return true;
}
