import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, NETWORK_ERROR, type UploadResult } from '../src/api';
import {
  clearPending,
  pendingStoreFor,
  restorePending,
  type PendingRecord,
  type PendingStorage,
} from '../src/pendingStore';
import { UploadQueue } from '../src/uploadQueue';

/** Mesmo contrato do IndexedDB, em memória. */
function memoryStorage(): PendingStorage & { records: Map<string, PendingRecord> } {
  const records = new Map<string, PendingRecord>();
  return {
    records,
    loadAll: async () => [...records.values()],
    put: async (r) => void records.set(r.clientUploadId, r),
    delete: async (id) => void records.delete(id),
  };
}

const quota = { remainingInWindow: 9, remainingTotal: 149, resetsAt: null };
const ok: UploadResult = { id: 'p', quota, duplicate: false };
const blob = () => new Blob(['foto']);

function queueFor(storage: PendingStorage, guestId: string, upload: (b: Blob, id: string) => Promise<UploadResult>) {
  let n = 0;
  return new UploadQueue({
    upload,
    onChange: () => undefined,
    store: pendingStoreFor(storage, guestId),
    newId: () => `${guestId}-foto-${++n}`,
  });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('pendentes após a sessão cair (401)', () => {
  it('a sessão nova reenvia as pendentes da antiga, com o mesmo clientUploadId, e marca o novo dono', async () => {
    const storage = memoryStorage();

    // Sessão antiga: a foto fica pendente (sem rede) e a sessão cai.
    const antiga = queueFor(storage, 'guest-antigo', async () => {
      throw new ApiError(0, NETWORK_ERROR, 'sem rede');
    });
    antiga.enqueue(blob());
    await vi.runAllTimersAsync();
    antiga.dispose();
    expect([...storage.records.values()]).toMatchObject([{ clientUploadId: 'guest-antigo-foto-1', guestId: 'guest-antigo' }]);

    // Sessão nova no mesmo aparelho.
    const enviados: string[] = [];
    const nova = queueFor(storage, 'guest-novo', async (_b, id) => {
      enviados.push(id);
      return ok;
    });
    const count = await restorePending(storage, 'guest-novo', nova);
    expect(count).toBe(1);
    // Enquanto não sai, a pendente já pertence ao convidado novo.
    expect(storage.records.get('guest-antigo-foto-1')?.guestId).toBe('guest-novo');

    await vi.runAllTimersAsync();
    expect(enviados).toEqual(['guest-antigo-foto-1']);
    expect(storage.records.size).toBe(0);
  });

  it('restaurar duas vezes (StrictMode) não duplica o envio', async () => {
    const storage = memoryStorage();
    await storage.put({ clientUploadId: 'x', guestId: 'g', blob: blob(), createdAt: 1 });
    const enviados: string[] = [];
    const queue = queueFor(storage, 'g', async (_b, id) => {
      enviados.push(id);
      return ok;
    });
    await Promise.all([restorePending(storage, 'g', queue), restorePending(storage, 'g', queue)]);
    await vi.runAllTimersAsync();
    expect(enviados).toEqual(['x']);
  });

  it('reenvia na ordem em que as fotos foram tiradas e ignora registros sem imagem', async () => {
    const storage = memoryStorage();
    await storage.put({ clientUploadId: 'b', guestId: 'g', blob: blob(), createdAt: 20 });
    await storage.put({ clientUploadId: 'a', guestId: 'outro', blob: blob(), createdAt: 10 });
    await storage.put({ clientUploadId: 'vazio', guestId: 'g', blob: new Blob([]), createdAt: 5 });
    const enviados: string[] = [];
    const queue = queueFor(storage, 'g', async (_b, id) => {
      enviados.push(id);
      return ok;
    });
    await restorePending(storage, 'g', queue);
    await vi.runAllTimersAsync();
    expect(enviados).toEqual(['a', 'b']);
  });

  it('"Não é você?" apaga só as pendentes de quem saiu', async () => {
    const storage = memoryStorage();
    await storage.put({ clientUploadId: 'minha', guestId: 'eu', blob: blob(), createdAt: 1 });
    await storage.put({ clientUploadId: 'dela', guestId: 'ela', blob: blob(), createdAt: 2 });
    await clearPending(storage, 'eu');
    expect([...storage.records.keys()]).toEqual(['dela']);
  });

  it('IndexedDB indisponível: segue sem restaurar, sem erro', async () => {
    const storage: PendingStorage = {
      loadAll: () => Promise.reject(new Error('privado')),
      put: () => Promise.reject(new Error('privado')),
      delete: () => Promise.reject(new Error('privado')),
    };
    const queue = queueFor(storage, 'g', async () => ok);
    await expect(restorePending(storage, 'g', queue)).resolves.toBe(0);
    await expect(clearPending(storage, 'g')).resolves.toBeUndefined();
  });
});
