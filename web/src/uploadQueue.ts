// Fila de envio: uma foto por vez, retry com backoff exponencial, sempre com o mesmo clientUploadId.
import { ApiError, isRetryable, type UploadResult } from './api';

/** Espera antes da 2ª, 3ª, 4ª e 5ª tentativa. */
export const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000] as const;
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

/** Espera antes da próxima tentativa, dado quantas já falharam; null se acabaram as tentativas. */
export function backoffDelay(failedAttempts: number): number | null {
  if (failedAttempts < 1 || failedAttempts >= MAX_ATTEMPTS) return null;
  return RETRY_DELAYS_MS[failedAttempts - 1] ?? null;
}

export type UploadStatus = 'queued' | 'sending' | 'waiting_retry' | 'sent' | 'failed';

export interface QueueItem {
  clientUploadId: string;
  /** null depois de enviada, para liberar memória. */
  blob: Blob | null;
  status: UploadStatus;
  attempts: number;
  createdAt: number;
  error: ApiError | null;
  nextRetryAt: number | null;
}

/** Persistência opcional (IndexedDB) das fotos ainda não enviadas. */
export interface QueueStore {
  save(item: { clientUploadId: string; blob: Blob; createdAt: number }): Promise<void>;
  remove(clientUploadId: string): Promise<void>;
}

export interface QueueDeps {
  upload(photo: Blob, clientUploadId: string): Promise<UploadResult>;
  onChange(items: readonly QueueItem[]): void;
  onSent?(result: UploadResult, item: QueueItem): void;
  /** Erro que não será repetido automaticamente (429, 401, 403...). */
  onFailed?(error: ApiError, item: QueueItem): void;
  store?: QueueStore;
  newId?: () => string;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class UploadQueue {
  private items: QueueItem[] = [];
  private timers = new Map<string, unknown>();
  private busy = false;
  /** Gravações em andamento no store: o remove espera o save da mesma foto terminar. */
  private saving = new Map<string, Promise<void>>();
  private readonly newId: () => string;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: QueueDeps) {
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.now = deps.now ?? (() => Date.now());
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  getItems(): readonly QueueItem[] {
    return this.items;
  }

  /** Fotos que ainda vão (ou podem) ser enviadas. */
  pendingCount(): number {
    return this.items.filter((i) => i.status === 'queued' || i.status === 'sending' || i.status === 'waiting_retry')
      .length;
  }

  enqueue(blob: Blob): QueueItem {
    return this.add({ clientUploadId: this.newId(), blob, createdAt: this.now() }, true);
  }

  /** Recoloca na fila uma foto salva antes (ex.: IndexedDB após reabrir a página). */
  restore(saved: { clientUploadId: string; blob: Blob; createdAt: number }): QueueItem | null {
    if (this.items.some((i) => i.clientUploadId === saved.clientUploadId)) return null;
    return this.add(saved, false);
  }

  /** Tentar de novo manualmente: zera as tentativas e mantém o mesmo clientUploadId. */
  retry(clientUploadId: string): void {
    const item = this.find(clientUploadId);
    if (!item || item.blob === null || (item.status !== 'failed' && item.status !== 'waiting_retry')) return;
    this.cancelTimer(clientUploadId);
    this.update(item, { status: 'queued', attempts: 0, error: null, nextRetryAt: null });
    this.pump();
  }

  retryAllFailed(): void {
    for (const item of this.items) {
      if (item.status === 'failed' || item.status === 'waiting_retry') this.retry(item.clientUploadId);
    }
  }

  /** Descarta uma foto que não foi enviada. */
  discard(clientUploadId: string): void {
    const item = this.find(clientUploadId);
    if (!item || item.status === 'sending' || item.status === 'sent') return;
    this.cancelTimer(clientUploadId);
    this.items = this.items.filter((i) => i !== item);
    this.unpersist(clientUploadId);
    this.emit();
  }

  /** Para os timers (ex.: ao desmontar). Envios em andamento terminam normalmente. */
  dispose(): void {
    for (const handle of this.timers.values()) this.clearTimer(handle);
    this.timers.clear();
  }

  private add(saved: { clientUploadId: string; blob: Blob; createdAt: number }, persist: boolean): QueueItem {
    const item: QueueItem = {
      clientUploadId: saved.clientUploadId,
      blob: saved.blob,
      status: 'queued',
      attempts: 0,
      createdAt: saved.createdAt,
      error: null,
      nextRetryAt: null,
    };
    this.items = [...this.items, item];
    if (persist && this.deps.store) {
      const saving = this.deps.store.save(saved).catch(() => undefined);
      this.saving.set(saved.clientUploadId, saving);
    }
    this.emit();
    this.pump();
    return item;
  }

  private unpersist(clientUploadId: string): void {
    const store = this.deps.store;
    if (!store) return;
    const saving = this.saving.get(clientUploadId) ?? Promise.resolve();
    this.saving.delete(clientUploadId);
    void saving.then(() => store.remove(clientUploadId)).catch(() => undefined);
  }

  private find(clientUploadId: string): QueueItem | undefined {
    return this.items.find((i) => i.clientUploadId === clientUploadId);
  }

  /** Itens são imutáveis para o React perceber a mudança. */
  private update(item: QueueItem, patch: Partial<QueueItem>): QueueItem {
    const next = { ...item, ...patch };
    this.items = this.items.map((i) => (i.clientUploadId === item.clientUploadId ? next : i));
    this.emit();
    return next;
  }

  private emit(): void {
    this.deps.onChange(this.items);
  }

  private cancelTimer(clientUploadId: string): void {
    const handle = this.timers.get(clientUploadId);
    if (handle !== undefined) this.clearTimer(handle);
    this.timers.delete(clientUploadId);
  }

  /** Envia uma foto por vez, na ordem; fotos esperando retry não travam as outras. */
  private pump(): void {
    if (this.busy) return;
    const next = this.items.find((i) => i.status === 'queued');
    if (!next || next.blob === null) return;
    this.busy = true;
    void this.send(next, next.blob).finally(() => {
      this.busy = false;
      this.pump();
    });
  }

  private async send(queued: QueueItem, blob: Blob): Promise<void> {
    let item = this.update(queued, { status: 'sending', attempts: queued.attempts + 1, nextRetryAt: null });
    try {
      const result = await this.deps.upload(blob, item.clientUploadId);
      item = this.update(this.find(item.clientUploadId) ?? item, { status: 'sent', blob: null, error: null });
      this.unpersist(item.clientUploadId);
      this.deps.onSent?.(result, item);
    } catch (err) {
      const error = err instanceof ApiError ? err : new ApiError(0, 'unknown_error', 'Falha ao enviar.');
      const current = this.find(item.clientUploadId) ?? item;
      const wait = isRetryable(error) ? backoffDelay(current.attempts) : null;
      if (wait === null) {
        item = this.update(current, { status: 'failed', error });
        this.deps.onFailed?.(error, item);
        return;
      }
      this.update(current, { status: 'waiting_retry', error, nextRetryAt: this.now() + wait });
      const id = current.clientUploadId;
      this.timers.set(
        id,
        this.setTimer(() => {
          this.timers.delete(id);
          const waiting = this.find(id);
          if (waiting?.status !== 'waiting_retry') return;
          this.update(waiting, { status: 'queued', nextRetryAt: null });
          this.pump();
        }, wait),
      );
    }
  }
}
