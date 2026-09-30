// Fotos ainda não enviadas ficam no IndexedDB para serem reenviadas ao reabrir a página.
// Tudo é "melhor esforço": se o IndexedDB falhar (ex.: navegação privada), a fila segue só em memória.
import type { QueueStore } from './uploadQueue';

const DB_NAME = 'weddingrafessa';
const STORE = 'pendingPhotos';

interface PendingRecord {
  clientUploadId: string;
  guestId: string;
  blob: Blob;
  createdAt: number;
}

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

/** Store da fila para um convidado: cada foto fica marcada com o guestId de quem tirou. */
export function pendingStoreFor(guestId: string): QueueStore {
  return {
    async save(item) {
      const record: PendingRecord = { ...item, guestId };
      await run('readwrite', (store) => store.put(record));
    },
    async remove(clientUploadId) {
      await run('readwrite', (store) => store.delete(clientUploadId));
    },
  };
}

/** Fotos pendentes deste convidado (outro convidado no mesmo celular não reenvia as dele). */
export async function loadPending(guestId: string): Promise<PendingRecord[]> {
  try {
    const records = await run<PendingRecord[]>('readonly', (store) => store.index('guestId').getAll(guestId));
    return records.filter((r) => r.blob instanceof Blob && r.blob.size > 0).sort((a, b) => a.createdAt - b.createdAt);
  } catch {
    return [];
  }
}

/** Apaga as pendentes deste convidado (ex.: "Não é você?" confirmado). */
export async function clearPending(guestId: string): Promise<void> {
  try {
    const records = await loadPending(guestId);
    await Promise.all(records.map((r) => run('readwrite', (store) => store.delete(r.clientUploadId))));
  } catch {
    // melhor esforço
  }
}
