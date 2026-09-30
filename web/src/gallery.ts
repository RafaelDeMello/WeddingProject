// Estado da galeria compartilhada — lógica pura (sem React, sem rede), testada em node.
import type { ApiError, GalleryItem, GalleryPage, GalleryUpdates } from './api';
import type { UploadStatus } from './uploadQueue';

export const PAGE_SIZE = 30;
export const POLL_INTERVAL_MS = 15_000;
/** Toda consulta de updates volta 30 s antes do último serverTime (corrida de gravação); dedup por id. */
export const UPDATE_OVERLAP_MS = 30_000;
/** Proteção contra laço infinito se o servidor responder hasMore sempre. */
export const MAX_UPDATE_ROUNDS = 20;

export interface GalleryState {
  /** Mais recentes primeiro, sem ids repetidos. */
  items: GalleryItem[];
  nextCursor: string | null;
  firstPageLoaded: boolean;
  /** Último serverTime conhecido (sem a sobreposição). */
  lastServerTime: string | null;
  /** Ocultadas pela moderação: uma página atrasada não as traz de volta; um `added` sim (reexibida). */
  removed: ReadonlySet<string>;
}

export function initialGalleryState(): GalleryState {
  return { items: [], nextCursor: null, firstPageLoaded: false, lastServerTime: null, removed: new Set() };
}

function byNewest(a: GalleryItem, b: GalleryItem): number {
  const diff = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  if (diff !== 0) return diff;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Junta itens por id (o mais novo recebido prevalece) e reordena. */
function upsert(current: GalleryItem[], incoming: GalleryItem[], removed: ReadonlySet<string>): GalleryItem[] {
  const map = new Map(current.map((i) => [i.id, i]));
  for (const item of incoming) {
    if (!removed.has(item.id)) map.set(item.id, item);
  }
  return [...map.values()].sort(byNewest);
}

/**
 * Aplica uma página. Na primeira, define o ponto de partida das atualizações:
 * serverTime da resposta; sem ele, o createdAt mais recente; galeria vazia, `fallbackSince` (abertura do evento).
 */
export function applyPage(state: GalleryState, page: GalleryPage, fallbackSince: string): GalleryState {
  const items = upsert(state.items, page.items, state.removed);
  let lastServerTime = state.lastServerTime;
  if (!state.firstPageLoaded && lastServerTime === null) {
    const newest = page.items.reduce<string | null>(
      (acc, i) => (acc === null || Date.parse(i.createdAt) > Date.parse(acc) ? i.createdAt : acc),
      null,
    );
    lastServerTime = page.serverTime ?? newest ?? fallbackSince;
  }
  return { ...state, items, nextCursor: page.nextCursor, firstPageLoaded: true, lastServerTime };
}

export function applyUpdates(state: GalleryState, updates: GalleryUpdates): GalleryState {
  const removed = new Set(state.removed);
  for (const id of updates.removedIds) removed.add(id);
  // Foto reexibida volta como `added`: deixa de contar como removida.
  for (const item of updates.added) removed.delete(item.id);
  const kept = state.items.filter((i) => !removed.has(i.id));
  return {
    ...state,
    items: upsert(kept, updates.added, removed),
    removed,
    // Nunca volta: com a sobreposição, um lote já recebido pode voltar com um corte anterior.
    lastServerTime: laterOf(state.lastServerTime, updates.serverTime),
  };
}

function laterOf(a: string | null, b: string): string {
  return a !== null && Date.parse(a) > Date.parse(b) ? a : b;
}

/** A resposta mudou algo além do que já se sabia (foto nova ou remoção nova)? */
function broughtNews(state: GalleryState, updates: GalleryUpdates): boolean {
  const known = new Set(state.items.map((i) => i.id));
  return (
    updates.added.some((i) => !known.has(i.id) || state.removed.has(i.id)) ||
    updates.removedIds.some((id) => !state.removed.has(id))
  );
}

/** `since` a enviar: último serverTime menos 30 s. */
export function sinceWithOverlap(lastServerTime: string): string {
  return new Date(Date.parse(lastServerTime) - UPDATE_OVERLAP_MS).toISOString();
}

/** Onde o estado vive (no React, um ref + setState): cada rodada lê e grava o estado atual. */
export interface GalleryStateBox {
  get(): GalleryState;
  set(state: GalleryState): void;
}

/**
 * Consulta updates até o servidor dizer que acabou (hasMore=false), cada rodada com o novo
 * serverTime (menos a sobreposição). Cada rodada é aplicada sobre o estado do momento, então uma
 * página carregada no meio do caminho não se perde.
 */
export async function drainUpdatesInto(
  box: GalleryStateBox,
  fetchUpdates: (since: string) => Promise<GalleryUpdates>,
  maxRounds = MAX_UPDATE_ROUNDS,
): Promise<void> {
  let exactNext = false;
  for (let round = 0; round < maxRounds; round++) {
    const lastServerTime = box.get().lastServerTime;
    if (lastServerTime === null) return;
    const since = exactNext ? lastServerTime : sinceWithOverlap(lastServerTime);
    const updates = await fetchUpdates(since);
    const before = box.get();
    box.set(applyUpdates(before, updates));
    if (!updates.hasMore) return;
    // Mais mudanças que o limite por resposta dentro de 30 s: com a sobreposição a próxima rodada
    // devolveria as mesmas fotos e nunca avançaria. Se esta não trouxe nada novo, a próxima usa o
    // serverTime exato (um corte dentro de dados já gravados, não o "agora").
    exactNext = !broughtNews(before, updates);
  }
}

/** Mesmo que drainUpdatesInto, partindo de um estado e devolvendo o final. */
export async function drainUpdates(
  state: GalleryState,
  fetchUpdates: (since: string) => Promise<GalleryUpdates>,
  maxRounds = MAX_UPDATE_ROUNDS,
): Promise<GalleryState> {
  let current = state;
  await drainUpdatesInto({ get: () => current, set: (s) => (current = s) }, fetchUpdates, maxRounds);
  return current;
}

// ---------- Fotos do próprio convidado ainda não confirmadas pela galeria ----------

export interface LocalPhoto {
  clientUploadId: string;
  /** Object URL da foto comprimida no aparelho. */
  url: string;
  createdAt: number;
  status: UploadStatus;
  error: ApiError | null;
  /** id no servidor, quando o envio conclui. */
  serverId: string | null;
}

export type GridEntry =
  | { kind: 'local'; key: string; local: LocalPhoto }
  | { kind: 'server'; key: string; item: GalleryItem };

/**
 * Grade = fotos locais (mais recentes primeiro) + itens do servidor.
 * Uma local cujo serverId já chegou da galeria (ou foi removido pela moderação) sai da grade:
 * o item real a substitui sem duplicar. `superseded` lista as locais a descartar (liberar URL).
 */
export function mergeGrid(
  items: readonly GalleryItem[],
  locals: readonly LocalPhoto[],
  removed: ReadonlySet<string>,
): { entries: GridEntry[]; superseded: string[] } {
  const serverIds = new Set(items.map((i) => i.id));
  const superseded: string[] = [];
  const localEntries: GridEntry[] = [];
  for (const local of [...locals].sort((a, b) => b.createdAt - a.createdAt)) {
    if (local.serverId !== null && (serverIds.has(local.serverId) || removed.has(local.serverId))) {
      superseded.push(local.clientUploadId);
    } else {
      localEntries.push({ kind: 'local', key: `local-${local.clientUploadId}`, local });
    }
  }
  const serverEntries: GridEntry[] = items.map((item) => ({ kind: 'server', key: `srv-${item.id}`, item }));
  return { entries: [...localEntries, ...serverEntries], superseded };
}

/**
 * Visualizador aberto numa foto que sumiu (moderação): segue para a que ficou no mesmo lugar,
 * ou a anterior; null se a grade esvaziou.
 */
export function nextOpenKey(entries: readonly GridEntry[], openKey: string, lastIndex: number): string | null {
  if (entries.some((e) => e.key === openKey)) return openKey;
  if (entries.length === 0) return null;
  const index = Math.min(Math.max(0, lastIndex), entries.length - 1);
  return entries[index]!.key;
}
