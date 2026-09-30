import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, NETWORK_ERROR, type UploadResult } from '../src/api';
import { MAX_ATTEMPTS, RETRY_DELAYS_MS, UploadQueue, backoffDelay, type QueueItem } from '../src/uploadQueue';

const quota = { remainingInWindow: 9, remainingTotal: 149, resetsAt: null };
const ok = (id = 'p'): UploadResult => ({ id, quota, duplicate: false });
const netErr = () => new ApiError(0, NETWORK_ERROR, 'rede');
const blob = () => new Blob(['x']);

function setup(upload: (photo: Blob, id: string) => Promise<UploadResult>) {
  let n = 0;
  const sent: UploadResult[] = [];
  const failed: ApiError[] = [];
  let items: readonly QueueItem[] = [];
  const queue = new UploadQueue({
    upload,
    onChange: (next) => (items = next),
    onSent: (r) => sent.push(r),
    onFailed: (e) => failed.push(e),
    newId: () => `id-${++n}`,
  });
  return { queue, sent, failed, items: () => items };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('backoffDelay', () => {
  it('1s, 2s, 4s, 8s e depois para (máx. 5 tentativas)', () => {
    expect(MAX_ATTEMPTS).toBe(5);
    expect([1, 2, 3, 4].map(backoffDelay)).toEqual([1000, 2000, 4000, 8000]);
    expect(backoffDelay(5)).toBeNull();
    expect(backoffDelay(0)).toBeNull();
  });
});

describe('UploadQueue', () => {
  it('envia e marca como enviada, liberando o blob', async () => {
    const upload = vi.fn(async () => ok('p1'));
    const { queue, sent, items } = setup(upload);
    queue.enqueue(blob());
    await vi.runAllTimersAsync();
    expect(upload).toHaveBeenCalledWith(expect.any(Blob), 'id-1');
    expect(items()[0]).toMatchObject({ status: 'sent', attempts: 1, blob: null });
    expect(sent).toHaveLength(1);
    expect(queue.pendingCount()).toBe(0);
  });

  it('falha de rede: repete com backoff e sempre o mesmo clientUploadId', async () => {
    const ids: string[] = [];
    const times: number[] = [];
    const upload = vi.fn(async (_b: Blob, id: string) => {
      ids.push(id);
      times.push(Date.now());
      if (ids.length < 3) throw netErr();
      return ok();
    });
    const { queue, items } = setup(upload);
    queue.enqueue(blob());
    await vi.advanceTimersByTimeAsync(0);
    expect(items()[0]?.status).toBe('waiting_retry');
    await vi.runAllTimersAsync();
    expect(ids).toEqual(['id-1', 'id-1', 'id-1']);
    expect(times[1]! - times[0]!).toBe(RETRY_DELAYS_MS[0]);
    expect(times[2]! - times[1]!).toBe(RETRY_DELAYS_MS[1]);
    expect(items()[0]).toMatchObject({ status: 'sent', attempts: 3 });
  });

  it('desiste após 5 tentativas e marca como falhou', async () => {
    const upload = vi.fn(async () => {
      throw netErr();
    });
    const { queue, failed, items } = setup(upload);
    queue.enqueue(blob());
    await vi.runAllTimersAsync();
    expect(upload).toHaveBeenCalledTimes(5);
    expect(items()[0]).toMatchObject({ status: 'failed', attempts: 5 });
    expect(failed[0]?.code).toBe(NETWORK_ERROR);
    expect(queue.pendingCount()).toBe(0);
  });

  it('5xx também é repetido', async () => {
    let calls = 0;
    const { queue, items } = setup(async () => {
      if (++calls === 1) throw new ApiError(503, 'http_503', 'x');
      return ok();
    });
    queue.enqueue(blob());
    await vi.runAllTimersAsync();
    expect(items()[0]?.status).toBe('sent');
  });

  it.each([
    [429, 'rate_limited'],
    [429, 'quota_exceeded'],
    [429, 'total_quota_exceeded'],
    [413, 'file_too_large'],
    [415, 'unsupported_media_type'],
    [422, 'invalid_image'],
    [403, 'upload_closed'],
    [401, 'unauthorized'],
    [400, 'invalid_image'],
    [507, 'insufficient_storage'],
  ])('%i %s não é repetido automaticamente', async (status, code) => {
    const upload = vi.fn(async () => {
      throw new ApiError(status, code, 'x', status === 429 ? 60 : undefined);
    });
    const { queue, failed, items } = setup(upload);
    queue.enqueue(blob());
    await vi.runAllTimersAsync();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(items()[0]).toMatchObject({ status: 'failed', attempts: 1 });
    expect(failed[0]).toMatchObject({ status, code });
  });

  it('retry manual reenvia com o mesmo clientUploadId e zera as tentativas', async () => {
    const ids: string[] = [];
    let fail = true;
    const { queue, items } = setup(async (_b, id) => {
      ids.push(id);
      if (fail) throw new ApiError(429, 'rate_limited', 'x', 60);
      return ok();
    });
    queue.enqueue(blob());
    await vi.runAllTimersAsync();
    fail = false;
    queue.retry('id-1');
    await vi.runAllTimersAsync();
    expect(ids).toEqual(['id-1', 'id-1']);
    expect(items()[0]).toMatchObject({ status: 'sent', attempts: 1 });
  });

  it('envia uma por vez, na ordem, e uma foto em backoff não trava as outras', async () => {
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const { queue, items } = setup(async (_b, id) => {
      order.push(id);
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 100));
      active--;
      if (id === 'id-1' && order.filter((x) => x === 'id-1').length === 1) throw netErr();
      return ok(id);
    });
    queue.enqueue(blob());
    queue.enqueue(blob());
    queue.enqueue(blob());
    await vi.runAllTimersAsync();
    expect(maxActive).toBe(1);
    expect(order).toEqual(['id-1', 'id-2', 'id-3', 'id-1']);
    expect(items().map((i) => i.status)).toEqual(['sent', 'sent', 'sent']);
  });

  it('retryAllFailed recoloca todas as que falharam', async () => {
    let online = false;
    const { queue, items } = setup(async () => {
      if (!online) throw netErr();
      return ok();
    });
    queue.enqueue(blob());
    queue.enqueue(blob());
    await vi.runAllTimersAsync();
    expect(items().map((i) => i.status)).toEqual(['failed', 'failed']);
    online = true;
    queue.retryAllFailed();
    await vi.runAllTimersAsync();
    expect(items().map((i) => i.status)).toEqual(['sent', 'sent']);
  });

  it('discard remove foto em espera e cancela o retry pendente', async () => {
    const upload = vi.fn(async () => {
      throw netErr();
    });
    const { queue, items } = setup(upload);
    queue.enqueue(blob());
    await vi.advanceTimersByTimeAsync(0);
    expect(items()[0]?.status).toBe('waiting_retry');
    queue.discard('id-1');
    await vi.runAllTimersAsync();
    expect(items()).toHaveLength(0);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('restore reaproveita o clientUploadId salvo e não duplica', async () => {
    const ids: string[] = [];
    const { queue } = setup(async (_b, id) => {
      ids.push(id);
      return ok();
    });
    expect(queue.restore({ clientUploadId: 'salvo', blob: blob(), createdAt: 1 })).not.toBeNull();
    expect(queue.restore({ clientUploadId: 'salvo', blob: blob(), createdAt: 1 })).toBeNull();
    await vi.runAllTimersAsync();
    expect(ids).toEqual(['salvo']);
  });

  it('persiste ao enfileirar e remove do store ao enviar', async () => {
    const saved: string[] = [];
    const removed: string[] = [];
    const queue = new UploadQueue({
      upload: async () => ok(),
      onChange: () => undefined,
      newId: () => 'x',
      store: {
        save: async (item) => void saved.push(item.clientUploadId),
        remove: async (id) => void removed.push(id),
      },
    });
    queue.enqueue(blob());
    await vi.runAllTimersAsync();
    expect(saved).toEqual(['x']);
    expect(removed).toEqual(['x']);
  });

  it('save lento no store: o remove só acontece depois do save (não sobra pendente fantasma)', async () => {
    const log: string[] = [];
    const queue = new UploadQueue({
      upload: async () => ok(),
      onChange: () => undefined,
      newId: () => 'x',
      store: {
        save: async () => {
          await new Promise((r) => setTimeout(r, 500));
          log.push('save');
        },
        remove: async () => void log.push('remove'),
      },
    });
    queue.enqueue(blob());
    await vi.runAllTimersAsync();
    expect(queue.getItems()[0]?.status).toBe('sent');
    expect(log).toEqual(['save', 'remove']);
  });
});

describe('UploadQueue.forget', () => {
  it('remove da lista só fotos já enviadas', async () => {
    let fail = true;
    const { queue, items } = setup(async () => {
      if (fail) throw new ApiError(422, 'invalid_image', 'x');
      return ok();
    });
    queue.enqueue(blob());
    await vi.runAllTimersAsync();
    queue.forget('id-1');
    expect(items()).toHaveLength(1);
    fail = false;
    queue.enqueue(blob());
    await vi.runAllTimersAsync();
    queue.forget('id-2');
    expect(items().map((i) => i.clientUploadId)).toEqual(['id-1']);
  });
});
