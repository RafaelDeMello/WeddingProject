import path from 'node:path';
import type { Guest, Photo, PrismaClient } from '@prisma/client';
import { z } from 'zod';

/** Máximo de fotos novas devolvidas por chamada de /updates (o resto vem com hasMore). */
export const UPDATES_MAX_ADDED = 200;
/** Empates no mesmo milissegundo na borda do corte são incluídos (até esse limite de folga). */
const UPDATES_TIE_SLACK = 100;
export const GALLERY_DEFAULT_LIMIT = 30;
export const GALLERY_MAX_LIMIT = 60;

export interface GalleryItem {
  id: string;
  guestName: string;
  createdAt: string;
  thumbUrl: string;
  photoUrl: string;
  mine: boolean;
}

type PhotoWithGuest = Photo & { guest: Pick<Guest, 'name'> };

export function toGalleryItem(photo: PhotoWithGuest, viewerId: string): GalleryItem {
  return {
    id: photo.id,
    guestName: photo.guest.name,
    createdAt: photo.createdAt.toISOString(),
    thumbUrl: `/api/gallery/photos/${photo.id}/thumb`,
    photoUrl: `/api/gallery/photos/${photo.id}`,
    mine: photo.guestId === viewerId,
  };
}

const withGuest = { guest: { select: { name: true } } } as const;

// --- Cursor opaco da listagem: base64url("<createdAt em ms>.<id>") ---------------------------

const cursorSchema = z.object({ ms: z.number().int().nonnegative(), id: z.uuid() });

export function encodeCursor(photo: Pick<Photo, 'createdAt' | 'id'>): string {
  return Buffer.from(`${photo.createdAt.getTime()}.${photo.id}`).toString('base64url');
}

/** null se o cursor não é um cursor válido desta API. */
export function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(cursor)) return null;
  const [ms, id, ...rest] = Buffer.from(cursor, 'base64url').toString('utf8').split('.');
  if (rest.length > 0) return null;
  const parsed = cursorSchema.safeParse({ ms: Number(ms), id });
  return parsed.success ? { createdAt: new Date(parsed.data.ms), id: parsed.data.id } : null;
}

// --- Listagem ---------------------------------------------------------------------------------

export async function listGallery(
  prisma: PrismaClient,
  viewerId: string,
  { limit, cursor }: { limit: number; cursor: { createdAt: Date; id: string } | null },
): Promise<{ items: GalleryItem[]; nextCursor: string | null }> {
  const rows = await prisma.photo.findMany({
    where: {
      hiddenAt: null,
      ...(cursor && {
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ],
      }),
    },
    include: withGuest,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1, // a foto extra só diz se há próxima página
  });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((p) => toGalleryItem(p, viewerId)),
    nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
  };
}

// --- Atualizações -----------------------------------------------------------------------------

/**
 * Quando a foto "apareceu" para os convidados: a última vez que foi reexibida ou, se nunca mudou,
 * quando foi criada. (visibilityChangedAt só é gravado depois da criação, então é sempre >= createdAt.)
 */
const appearedAt = (p: Photo) => p.visibilityChangedAt ?? p.createdAt;

export interface GalleryUpdates {
  added: GalleryItem[];
  removedIds: string[];
  serverTime: string;
  hasMore: boolean;
}

/**
 * added = visíveis com createdAt > since OU visibilityChangedAt > since; removedIds = ocultas com
 * visibilityChangedAt > since. Com mais de UPDATES_MAX_ADDED novas, devolve as mais antigas e move
 * `serverTime` para o ponto onde parou (hasMore = true): o cliente pergunta de novo na hora.
 */
export async function galleryUpdates(
  prisma: PrismaClient,
  viewerId: string,
  since: Date,
  serverTime: Date,
): Promise<GalleryUpdates> {
  const take = UPDATES_MAX_ADDED + UPDATES_TIE_SLACK + 1;

  // Dois conjuntos disjuntos, cada um já ordenado pela sua chave exata:
  //  - criadas depois de `since` e nunca mexidas (chave = createdAt);
  //  - mexidas (ocultar/reexibir) depois de `since` e visíveis agora (chave = visibilityChangedAt).
  const [fresh, revisited, removed] = await Promise.all([
    prisma.photo.findMany({
      where: { hiddenAt: null, visibilityChangedAt: null, createdAt: { gt: since } },
      include: withGuest,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take,
    }),
    prisma.photo.findMany({
      where: { hiddenAt: null, visibilityChangedAt: { gt: since } },
      include: withGuest,
      orderBy: [{ visibilityChangedAt: 'asc' }, { id: 'asc' }],
      take,
    }),
    prisma.photo.findMany({
      where: { hiddenAt: { not: null }, visibilityChangedAt: { gt: since } },
      select: { id: true },
    }),
  ]);

  const merged = [...fresh, ...revisited].sort(
    (a, b) => appearedAt(a).getTime() - appearedAt(b).getTime() || (a.id < b.id ? -1 : 1),
  );

  let cut = Math.min(merged.length, UPDATES_MAX_ADDED);
  if (merged.length > UPDATES_MAX_ADDED) {
    // Não separa fotos com o mesmo instante: a próxima chamada usa "> since" e perderia as que sobrassem.
    const boundary = appearedAt(merged[cut - 1]!).getTime();
    while (cut < merged.length && appearedAt(merged[cut]!).getTime() === boundary) cut++;
  }
  const page = merged.slice(0, cut);
  const last = page[page.length - 1];

  // Sobrou algo: ou já sabemos de fotos que ficaram de fora, ou uma das buscas bateu no teto (há mais no banco).
  const capped = fresh.length === take || revisited.length === take;
  const hasMore = cut < merged.length || (capped && cut === merged.length);

  return {
    added: page.map((p) => toGalleryItem(p, viewerId)),
    removedIds: removed.map((r) => r.id),
    // Parou no meio: serverTime vira o ponto onde parou. Completo: o horário real da consulta.
    serverTime: (hasMore && last ? appearedAt(last) : serverTime).toISOString(),
    hasMore,
  };
}

// --- Arquivos ---------------------------------------------------------------------------------

/** Caminho absoluto de um arquivo guardado no banco (relativo a DATA_DIR), ou null se escapar dele. */
export function resolveDataFile(dataDir: string, relative: string): string | null {
  const absolute = path.resolve(dataDir, relative);
  return absolute.startsWith(dataDir + path.sep) ? absolute : null;
}

// --- Apagar a própria foto --------------------------------------------------------------------

/**
 * O convidado "apaga" a própria foto: o efeito é o mesmo de o admin ocultar (hiddenAt e
 * visibilityChangedAt com o mesmo instante). O arquivo continua no disco e a foto continua contando
 * na cota. Idempotente: se já estava oculta, não mexe nos timestamps.
 * Devolve false quando a foto não existe OU não é do convidado (o chamador responde 404 nos dois casos).
 */
export async function deleteOwnPhoto(
  prisma: PrismaClient,
  guestId: string,
  photoId: string,
  when: Date,
): Promise<boolean> {
  const owned = await prisma.photo.findFirst({ where: { id: photoId, guestId }, select: { id: true } });
  if (!owned) return false;
  // Condicional: duas chamadas simultâneas resultam em uma única mudança.
  await prisma.photo.updateMany({
    where: { id: photoId, guestId, hiddenAt: null },
    data: { hiddenAt: when, visibilityChangedAt: when },
  });
  return true;
}
