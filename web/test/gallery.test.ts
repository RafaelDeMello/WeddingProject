import { describe, expect, it } from 'vitest';
import { ApiError, NETWORK_ERROR, type GalleryItem, type GalleryUpdates } from '../src/api';
import {
  UPDATE_OVERLAP_MS,
  applyPage,
  beginDelete,
  deleteOutcome,
  finishDelete,
  applyUpdates,
  drainUpdates,
  initialGalleryState,
  mergeGrid,
  nextOpenKey,
  sinceWithOverlap,
  type LocalPhoto,
} from '../src/gallery';

const T0 = Date.parse('2026-10-03T22:00:00.000Z');
const iso = (offsetSec: number) => new Date(T0 + offsetSec * 1000).toISOString();
const OPENS = '2026-10-03T03:00:00.000Z';

function item(id: string, offsetSec: number, extra: Partial<GalleryItem> = {}): GalleryItem {
  return {
    id,
    guestName: 'Ana',
    createdAt: iso(offsetSec),
    thumbUrl: `/t/${id}`,
    photoUrl: `/p/${id}`,
    mine: false,
    ...extra,
  };
}

const ids = (items: readonly { id: string }[]) => items.map((i) => i.id);

describe('páginas', () => {
  it('primeira página: ordena mais recentes primeiro e usa serverTime como primeiro since', () => {
    const s = applyPage(initialGalleryState(), { items: [item('a', 1), item('c', 3), item('b', 2)], nextCursor: 'k1', serverTime: iso(100) }, OPENS);
    expect(ids(s.items)).toEqual(['c', 'b', 'a']);
    expect(s).toMatchObject({ nextCursor: 'k1', firstPageLoaded: true, lastServerTime: iso(100) });
  });

  it('sem serverTime: usa o createdAt mais recente; galeria vazia: a abertura do evento', () => {
    expect(applyPage(initialGalleryState(), { items: [item('a', 1), item('b', 5)], nextCursor: null }, OPENS).lastServerTime).toBe(iso(5));
    expect(applyPage(initialGalleryState(), { items: [], nextCursor: null }, OPENS).lastServerTime).toBe(OPENS);
  });

  it('páginas seguintes acrescentam sem duplicar e não mexem no since', () => {
    let s = applyPage(initialGalleryState(), { items: [item('d', 4), item('c', 3)], nextCursor: 'k1', serverTime: iso(100) }, OPENS);
    s = applyPage(s, { items: [item('c', 3), item('b', 2), item('a', 1)], nextCursor: null, serverTime: iso(200) }, OPENS);
    expect(ids(s.items)).toEqual(['d', 'c', 'b', 'a']);
    expect(s.nextCursor).toBeNull();
    expect(s.lastServerTime).toBe(iso(100));
  });

  it('página atrasada não traz de volta uma foto já removida', () => {
    let s = applyPage(initialGalleryState(), { items: [item('a', 1)], nextCursor: 'k', serverTime: iso(10) }, OPENS);
    s = applyUpdates(s, { added: [], removedIds: ['b'], serverTime: iso(20), hasMore: false });
    s = applyPage(s, { items: [item('b', 0)], nextCursor: null }, OPENS);
    expect(ids(s.items)).toEqual(['a']);
  });
});

describe('updates', () => {
  const base = () => applyPage(initialGalleryState(), { items: [item('b', 2), item('a', 1)], nextCursor: null, serverTime: iso(10) }, OPENS);

  it('since = último serverTime menos 30 s', () => {
    expect(UPDATE_OVERLAP_MS).toBe(30_000);
    expect(sinceWithOverlap(iso(100))).toBe(iso(70));
  });

  it('added entra ordenado; repetido pela sobreposição não duplica', () => {
    let s = applyUpdates(base(), { added: [item('c', 3)], removedIds: [], serverTime: iso(20), hasMore: false });
    s = applyUpdates(s, { added: [item('c', 3)], removedIds: [], serverTime: iso(30), hasMore: false });
    expect(ids(s.items)).toEqual(['c', 'b', 'a']);
    expect(s.lastServerTime).toBe(iso(30));
  });

  it('removedIds some da grade na hora', () => {
    const s = applyUpdates(base(), { added: [], removedIds: ['b', 'nem-estava'], serverTime: iso(20), hasMore: false });
    expect(ids(s.items)).toEqual(['a']);
  });

  it('foto reexibida volta como added', () => {
    let s = applyUpdates(base(), { added: [], removedIds: ['b'], serverTime: iso(20), hasMore: false });
    s = applyUpdates(s, { added: [item('b', 2)], removedIds: [], serverTime: iso(30), hasMore: false });
    expect(ids(s.items)).toEqual(['b', 'a']);
    expect(s.removed.has('b')).toBe(false);
  });

  it('hasMore: consulta de novo na hora com o novo serverTime (menos 30 s)', async () => {
    const calls: string[] = [];
    const responses: GalleryUpdates[] = [
      { added: [item('c', 3)], removedIds: [], serverTime: iso(40), hasMore: true },
      { added: [item('d', 4)], removedIds: ['a'], serverTime: iso(60), hasMore: true },
      { added: [], removedIds: [], serverTime: iso(90), hasMore: false },
    ];
    const s = await drainUpdates(base(), async (since) => {
      calls.push(since);
      return responses[calls.length - 1]!;
    });
    expect(calls).toEqual([iso(10 - 30), iso(40 - 30), iso(60 - 30)]);
    expect(ids(s.items)).toEqual(['d', 'c', 'b']);
    expect(s.lastServerTime).toBe(iso(90));
  });

  it('rajada maior que o limite dentro de 30 s: não trava, avança até o fim', async () => {
    // Servidor simulado: devolve no máx. 2 mudanças com createdAt > since; hasMore com serverTime = corte.
    const all = [item('c', 11), item('d', 12), item('e', 13), item('f', 14), item('g', 15)];
    const calls: string[] = [];
    const s = await drainUpdates(base(), async (since) => {
      calls.push(since);
      const pending = all.filter((i) => Date.parse(i.createdAt) > Date.parse(since));
      const page = pending.slice(0, 2);
      const hasMore = pending.length > 2;
      return { added: page, removedIds: [], serverTime: hasMore ? page[1]!.createdAt : iso(20), hasMore };
    });
    expect(ids(s.items)).toEqual(['g', 'f', 'e', 'd', 'c', 'b', 'a']);
    expect(s.lastServerTime).toBe(iso(20));
    // Sempre com sobreposição; só a rodada depois de uma resposta sem novidade usa o corte exato.
    expect(calls).toEqual([iso(10 - 30), iso(12 - 30), iso(12), iso(14 - 30), iso(14)]);
  });

  it('com a sobreposição avançando, ela é mantida em toda rodada', async () => {
    const calls: string[] = [];
    await drainUpdates(base(), async (since) => {
      calls.push(since);
      return calls.length === 1
        ? { added: [item('c', 90)], removedIds: [], serverTime: iso(100), hasMore: true }
        : { added: [], removedIds: [], serverTime: iso(200), hasMore: false };
    });
    expect(calls).toEqual([iso(10 - 30), iso(100 - 30)]);
  });

  it('serverTime nunca volta: lote repetido pela sobreposição não recua o corte', () => {
    let s = applyUpdates(base(), { added: [item('e', 14)], removedIds: [], serverTime: iso(14), hasMore: true });
    s = applyUpdates(s, { added: [item('c', 11)], removedIds: [], serverTime: iso(12), hasMore: true });
    expect(s.lastServerTime).toBe(iso(14));
  });

  it('sem hasMore: uma consulta só', async () => {
    let calls = 0;
    await drainUpdates(base(), async () => {
      calls++;
      return { added: [], removedIds: [], serverTime: iso(20), hasMore: false };
    });
    expect(calls).toBe(1);
  });

  it('hasMore eterno para no limite de rodadas', async () => {
    let calls = 0;
    await drainUpdates(
      base(),
      async () => ({ added: [], removedIds: [], serverTime: iso(20 + calls++), hasMore: true }),
      5,
    );
    expect(calls).toBe(5);
  });

  it('antes da primeira página não consulta updates', async () => {
    let calls = 0;
    await drainUpdates(initialGalleryState(), async () => {
      calls++;
      return { added: [], removedIds: [], serverTime: iso(0), hasMore: false };
    });
    expect(calls).toBe(0);
  });
});

describe('fotos do próprio convidado', () => {
  const local = (id: string, createdAt: number, extra: Partial<LocalPhoto> = {}): LocalPhoto => ({
    clientUploadId: id,
    url: `blob:${id}`,
    createdAt,
    status: 'sending',
    error: null,
    serverId: null,
    ...extra,
  });

  it('aparecem na frente, mais recentes primeiro', () => {
    const { entries } = mergeGrid([item('x', 1)], [local('l1', 1), local('l2', 2)], new Set());
    expect(entries.map((e) => e.key)).toEqual(['local-l2', 'local-l1', 'srv-x']);
  });

  it('enviada mas ainda não na galeria: continua a local', () => {
    const { entries, superseded } = mergeGrid([item('x', 1)], [local('l1', 1, { status: 'sent', serverId: 'p1' })], new Set());
    expect(entries.map((e) => e.key)).toEqual(['local-l1', 'srv-x']);
    expect(superseded).toEqual([]);
  });

  it('quando o item real chega, substitui a local sem duplicar', () => {
    const { entries, superseded } = mergeGrid(
      [item('p1', 5, { mine: true }), item('x', 1)],
      [local('l1', 1, { status: 'sent', serverId: 'p1' })],
      new Set(),
    );
    expect(entries.map((e) => e.key)).toEqual(['srv-p1', 'srv-x']);
    expect(superseded).toEqual(['l1']);
  });

  it('própria foto removida pela moderação também sai', () => {
    const { entries, superseded } = mergeGrid([], [local('l1', 1, { status: 'sent', serverId: 'p1' })], new Set(['p1']));
    expect(entries).toEqual([]);
    expect(superseded).toEqual(['l1']);
  });
});

describe('visualizador e moderação', () => {
  const entries = mergeGrid([item('c', 3), item('b', 2), item('a', 1)], [], new Set()).entries;

  it('foto aberta continua aberta enquanto existir', () => {
    expect(nextOpenKey(entries, 'srv-b', 1)).toBe('srv-b');
  });

  it('foto aberta removida: segue para a que ocupou o lugar, ou a anterior no fim', () => {
    const semB = entries.filter((e) => e.key !== 'srv-b');
    expect(nextOpenKey(semB, 'srv-b', 1)).toBe('srv-a');
    const semA = entries.filter((e) => e.key !== 'srv-a');
    expect(nextOpenKey(semA, 'srv-a', 2)).toBe('srv-b');
  });

  it('grade vazia: fecha', () => {
    expect(nextOpenKey([], 'srv-a', 0)).toBeNull();
  });
});

describe('apagar minha foto (remoção otimista)', () => {
  const base = () =>
    applyPage(
      initialGalleryState(),
      { items: [item('c', 3, { mine: true }), item('b', 2), item('a', 1)], nextCursor: null, serverTime: iso(10) },
      OPENS,
    );

  it('some da grade na hora', () => {
    const s = beginDelete(base(), 'c');
    expect(ids(s.items)).toEqual(['b', 'a']);
    expect(s.deleting.has('c')).toBe(true);
  });

  it('enquanto apaga, updates e páginas (sobreposição) não trazem de volta', () => {
    let s = beginDelete(base(), 'c');
    s = applyUpdates(s, { added: [item('c', 3, { mine: true })], removedIds: [], serverTime: iso(20), hasMore: false });
    s = applyPage(s, { items: [item('c', 3, { mine: true })], nextCursor: null }, OPENS);
    expect(ids(s.items)).toEqual(['b', 'a']);
  });

  it('sucesso: continua fora, mesmo com resposta atrasada de updates trazendo como added', () => {
    let s = finishDelete(beginDelete(base(), 'c'), 'c', 'deleted');
    expect(s.deleting.size).toBe(0);
    s = applyUpdates(s, { added: [item('c', 3, { mine: true })], removedIds: [], serverTime: iso(20), hasMore: false });
    expect(ids(s.items)).toEqual(['b', 'a']);
  });

  it('404 conta como apagada; outras falhas voltam a foto', () => {
    expect(deleteOutcome(null)).toBe('deleted');
    expect(deleteOutcome(new ApiError(404, 'not_found', 'x'))).toBe('deleted');
    for (const err of [new ApiError(0, NETWORK_ERROR, 'x'), new ApiError(500, 'x', 'x'), new ApiError(401, 'unauthorized', 'x')]) {
      expect(deleteOutcome(err)).toBe('failed');
    }
  });

  it('falhou: a foto volta no mesmo lugar', () => {
    const s = finishDelete(beginDelete(base(), 'c'), 'c', 'failed');
    expect(ids(s.items)).toEqual(['c', 'b', 'a']);
    expect(s.deleting.size).toBe(0);
  });

  it('falhou mas a moderação removeu no meio: não volta', () => {
    let s = beginDelete(base(), 'c');
    s = applyUpdates(s, { added: [], removedIds: ['c'], serverTime: iso(20), hasMore: false });
    s = finishDelete(s, 'c', 'failed');
    expect(ids(s.items)).toEqual(['b', 'a']);
  });

  it('falhou: volta com a versão mais nova recebida durante o apagamento', () => {
    let s = beginDelete(base(), 'c');
    s = applyUpdates(s, { added: [item('c', 3, { mine: true, guestName: 'Ana Maria' })], removedIds: [], serverTime: iso(20), hasMore: false });
    s = finishDelete(s, 'c', 'failed');
    expect(s.items[0]).toMatchObject({ id: 'c', guestName: 'Ana Maria' });
  });

  it('foto local já enviada (item real ainda não chegou): some enquanto apaga, volta se falhar', () => {
    const local: LocalPhoto = { clientUploadId: 'l1', url: 'blob:l1', createdAt: 5, status: 'sent', error: null, serverId: 'p1' };
    let s = beginDelete(base(), 'p1');
    expect(s.deleting.get('p1')).toBeNull();
    let grid = mergeGrid(s.items, [local], new Set([...s.removed, ...s.deleted]), new Set(s.deleting.keys()));
    expect(grid.entries.map((e) => e.key)).not.toContain('local-l1');
    expect(grid.superseded).toEqual([]);

    const failed = finishDelete(s, 'p1', 'failed');
    grid = mergeGrid(failed.items, [local], new Set([...failed.removed, ...failed.deleted]), new Set(failed.deleting.keys()));
    expect(grid.entries[0]!.key).toBe('local-l1');

    s = finishDelete(s, 'p1', 'deleted');
    grid = mergeGrid(s.items, [local], new Set([...s.removed, ...s.deleted]), new Set(s.deleting.keys()));
    expect(grid.superseded).toEqual(['l1']);
  });

  it('apagar duas vezes a mesma foto não faz nada', () => {
    const once = beginDelete(base(), 'c');
    expect(beginDelete(once, 'c')).toBe(once);
  });
});
