// Fotos ainda não enviadas ficam no IndexedDB para serem reenviadas ao reabrir a página.
// Tudo é "melhor esforço": se o IndexedDB falhar (ex.: navegação privada), a fila segue só em memória.
import type { QueueStore, UploadQueue } from './uploadQueue';

export interface PendingRecord {
  clientUploadId: string;
  guestId: string;
  blob: Blob;
  createdAt: number;
}

/** Armazenamento das pendentes (IndexedDB no navegador; em memória nos testes). */
export interface PendingStorage {
  loadAll(): Promise<PendingRecord[]>;
  put(record: PendingRecord): Promise<void>;
  delete(clientUploadId: string): Promise<void>;
}

/** Store da fila para um convidado: cada foto fica marcada com o guestId de quem tirou. */
export function pendingStoreFor(storage: PendingStorage, guestId: string): QueueStore {
  return {
    save: (item) => storage.put({ ...item, guestId }),
    remove: (clientUploadId) => storage.delete(clientUploadId),
  };
}

/**
 * Sessão nova no aparelho: reenvia as pendentes desta sessão e também as de uma sessão
 * anterior que caiu (401, cookie expirado), passando-as para o convidado atual.
 * O "Não é você?" apaga as pendentes antes de sair, então não sobram fotos de outra pessoa.
 * Mesmo clientUploadId: se a foto já tinha chegado ao servidor, ele não duplica.
 */
export async function restorePending(
  storage: PendingStorage,
  guestId: string,
  queue: Pick<UploadQueue, 'restore'>,
): Promise<number> {
  let records: PendingRecord[];
  try {
    records = await storage.loadAll();
  } catch {
    return 0;
  }
  const valid = records
    .filter((r) => r.blob instanceof Blob && r.blob.size > 0)
    .sort((a, b) => a.createdAt - b.createdAt);
  let restored = 0;
  for (const record of valid) {
    if (record.guestId !== guestId) {
      await storage.put({ ...record, guestId }).catch(() => undefined);
    }
    if (queue.restore({ clientUploadId: record.clientUploadId, blob: record.blob, createdAt: record.createdAt })) {
      restored++;
    }
  }
  return restored;
}

/** Apaga as pendentes deste convidado (ex.: "Não é você?" confirmado). */
export async function clearPending(storage: PendingStorage, guestId: string): Promise<void> {
  try {
    const records = await storage.loadAll();
    await Promise.all(records.filter((r) => r.guestId === guestId).map((r) => storage.delete(r.clientUploadId)));
  } catch {
    // melhor esforço
  }
}

// ---------- IndexedDB ----------

const DB_NAME = 'weddingrafessa';
const STORE = 'pendingPhotos';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB indisponível'));
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE, { keyPath: 'clientUploadId' });
        store.createIndex('guestId', 'guestId');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch((err: unknown) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

async function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const idbPendingStorage: PendingStorage = {
  loadAll: () => run<PendingRecord[]>('readonly', (store) => store.getAll()),
  put: async (record) => {
    await run('readwrite', (store) => store.put(record));
  },
  delete: async (clientUploadId) => {
    await run('readwrite', (store) => store.delete(clientUploadId));
  },
};
