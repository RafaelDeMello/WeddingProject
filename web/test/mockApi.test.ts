import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError, NETWORK_ERROR } from '../src/api';
import { MOCK_UPDATES_LIMIT, createMockApi } from '../src/mockApi';
import { applyPage, drainUpdates, initialGalleryState, sinceWithOverlap } from '../src/gallery';

let clock = 0;
const photo = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' });

function setup() {
  return createMockApi({ now: () => clock, delay: async () => undefined, perWindow: 3, windowMinutes: 10, total: 5 });
}

beforeEach(() => {
  clock = Date.parse('2026-10-03T20:00:00-03:00');
});

describe('mockApi', () => {
  it('sem sessão, /me dá 401; depois de createGuest, devolve o guest', async () => {
    const { api } = setup();
    await expect(api.getMe()).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    const created = await api.createGuest('dev123', ' Ana ');
    expect(created.name).toBe('Ana');
    await expect(api.getMe()).resolves.toMatchObject({ guestId: created.guestId });
    await api.logout();
    await expect(api.getMe()).rejects.toBeInstanceOf(ApiError);
  });

  it('slug errado → 404; evento fechado → 403 upload_closed', async () => {
    const { api, control } = setup();
    await expect(api.createGuest('outro', 'Ana')).rejects.toMatchObject({ status: 404, code: 'event_not_found' });
    control.eventStatus = 'closed';
    await expect(api.createGuest('dev123', 'Ana')).rejects.toMatchObject({ status: 403, code: 'upload_closed' });
  });

  it('sucesso → 201; mesmo clientUploadId → duplicate sem contar na cota', async () => {
    const { api } = setup();
    const first = await api.uploadPhoto(photo(), 'a');
    expect(first.duplicate).toBe(false);
    expect(first.quota.remainingInWindow).toBe(2);
    const again = await api.uploadPhoto(photo(), 'a');
    expect(again).toMatchObject({ id: first.id, duplicate: true });
    expect(again.quota.remainingInWindow).toBe(2);
  });

  it('cota da janela esgotada → 429 com retryAfterSeconds até a foto mais antiga sair', async () => {
    const { api } = setup();
    await api.uploadPhoto(photo(), 'a');
    clock += 60_000;
    await api.uploadPhoto(photo(), 'b');
    await api.uploadPhoto(photo(), 'c');
    const err = await api.uploadPhoto(photo(), 'd').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 429, code: 'quota_exceeded', retryAfterSeconds: 9 * 60 });
    clock += 9 * 60_000 + 1;
    await expect(api.uploadPhoto(photo(), 'd')).resolves.toMatchObject({ duplicate: false });
  });

  it('cota é por convidado: trocar de pessoa ("Não é você?") zera a cota', async () => {
    const { api } = setup();
    await api.createGuest('dev123', 'Ana');
    await api.uploadPhoto(photo(), 'a');
    await api.uploadPhoto(photo(), 'b');
    await api.logout();
    const outra = await api.createGuest('dev123', 'Bia');
    expect(outra.quota).toMatchObject({ remainingInWindow: 3, remainingTotal: 5, resetsAt: null });
    // Mesmo clientUploadId de outra pessoa não é tratado como duplicado.
    await expect(api.uploadPhoto(photo(), 'a')).resolves.toMatchObject({ duplicate: false });
  });

  it('cenário rede instável: falha 2 vezes por foto e depois passa', async () => {
    const { api, control } = setup();
    control.scenario = 'network_flaky';
    await expect(api.uploadPhoto(photo(), 'a')).rejects.toMatchObject({ code: NETWORK_ERROR });
    await expect(api.uploadPhoto(photo(), 'a')).rejects.toMatchObject({ code: NETWORK_ERROR });
    await expect(api.uploadPhoto(photo(), 'a')).resolves.toMatchObject({ duplicate: false });
    expect(control.uploadCalls).toBe(3);
  });

  it('cenários 429, 403, 500 e sem rede', async () => {
    const { api, control } = setup();
    control.scenario = 'quota_exceeded';
    await expect(api.uploadPhoto(photo(), 'a')).rejects.toMatchObject({ status: 429, code: 'quota_exceeded', retryAfterSeconds: 420 });
    control.scenario = 'total_quota_exceeded';
    await expect(api.uploadPhoto(photo(), 'a')).rejects.toMatchObject({ status: 429, code: 'total_quota_exceeded' });
    control.scenario = 'rate_limited';
    await expect(api.uploadPhoto(photo(), 'a')).rejects.toMatchObject({ status: 429, code: 'rate_limited' });
    for (const [scenario, status] of [['file_too_large', 413], ['unsupported_media_type', 415], ['invalid_image', 422], ['insufficient_storage', 507]] as const) {
      control.scenario = scenario;
      await expect(api.uploadPhoto(photo(), 'a')).rejects.toMatchObject({ status, code: scenario });
    }
    control.scenario = 'upload_closed';
    await expect(api.uploadPhoto(photo(), 'a')).rejects.toMatchObject({ status: 403, code: 'upload_closed' });
    control.scenario = 'server_error';
    await expect(api.uploadPhoto(photo(), 'a')).rejects.toMatchObject({ status: 500 });
    control.scenario = 'network_down';
    await expect(api.uploadPhoto(photo(), 'a')).rejects.toMatchObject({ status: 0, code: NETWORK_ERROR });
  });
});

describe('mockApi: cota total', () => {
  it('esgotar o total → 429 total_quota_exceeded (não quota_exceeded)', async () => {
    const { api } = createMockApi({ now: () => clock, delay: async () => undefined, perWindow: 10, total: 2 });
    await api.uploadPhoto(photo(), 'a');
    await api.uploadPhoto(photo(), 'b');
    await expect(api.uploadPhoto(photo(), 'c')).rejects.toMatchObject({ status: 429, code: 'total_quota_exceeded' });
  });
});

describe('mockApi: galeria', () => {
  let t = Date.parse('2026-10-03T22:00:00.000Z');
  const opts = { now: () => t, delay: async () => undefined };

  async function logged(seed: 'empty' | 'few' | 'many') {
    const mock = createMockApi({ ...opts, gallerySeed: seed });
    await mock.api.createGuest('dev123', 'Ana');
    return mock;
  }

  it('sem sessão → 401', async () => {
    const { api } = createMockApi(opts);
    await expect(api.getGallery(null, 30)).rejects.toMatchObject({ status: 401 });
    await expect(api.getGalleryUpdates(new Date(t).toISOString())).rejects.toMatchObject({ status: 401 });
  });

  it('galeria vazia', async () => {
    const { api } = await logged('empty');
    await expect(api.getGallery(null, 30)).resolves.toMatchObject({ items: [], nextCursor: null });
  });

  it('paginação: 95 fotos em páginas de 30, mais recentes primeiro, sem repetir', async () => {
    const { api } = await logged('many');
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await api.getGallery(cursor, 30);
      seen.push(...page.items.map((i) => i.id));
      const times = page.items.map((i) => Date.parse(i.createdAt));
      expect(times).toEqual([...times].sort((a, b) => b - a));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(4);
    expect(new Set(seen).size).toBe(95);
  });

  it('itens com thumbUrl/photoUrl e mine só para as fotos do convidado', async () => {
    const { api } = await logged('few');
    await api.uploadPhoto(photo(), 'minha');
    const { items } = await api.getGallery(null, 30);
    expect(items).toHaveLength(13);
    expect(items.filter((i) => i.mine).map((i) => i.guestName)).toEqual(['Ana']);
    // Fotos dos outros: SVG em data: (a CSP permite); as do convidado usam a própria imagem enviada.
    expect(items.find((i) => !i.mine)!.thumbUrl).toMatch(/^data:image\/svg\+xml/);
  });

  it('updates: added, removedIds (moderação), reexibida volta como added', async () => {
    const mock = await logged('few');
    const first = await mock.api.getGallery(null, 30);
    const since = first.serverTime!;
    t += 1000;
    mock.control.addOthers(1);
    const hidden = mock.control.hideNewest(first.items[0]!.id);
    t += 1000;
    const u1 = await mock.api.getGalleryUpdates(since);
    expect(u1.added).toHaveLength(1);
    expect(u1.removedIds).toEqual([hidden]);
    expect(u1.hasMore).toBe(false);
    t += 1000;
    mock.control.unhideLast();
    const u2 = await mock.api.getGalleryUpdates(u1.serverTime);
    expect(u2.added.map((i) => i.id)).toEqual([hidden]);
  });

  it('rajada acima do limite: hasMore, e o cliente (drainUpdates) recebe todas sem travar', async () => {
    const mock = await logged('empty');
    let state = applyPage(initialGalleryState(), await mock.api.getGallery(null, 30), '2026-10-03T00:00:00.000Z');
    t += 1000;
    mock.control.addOthers(45);
    const u = await mock.api.getGalleryUpdates(sinceWithOverlap(state.lastServerTime!));
    expect(u.added).toHaveLength(MOCK_UPDATES_LIMIT);
    expect(u.hasMore).toBe(true);
    state = await drainUpdates(state, (since) => mock.api.getGalleryUpdates(since));
    expect(state.items).toHaveLength(45);
  });
});

describe('mockApi: apagar minha foto', () => {
  let t = Date.parse('2026-10-03T22:00:00.000Z');
  const opts = { now: () => t, delay: async () => undefined, gallerySeed: 'few' as const };

  it('204 na própria foto: some para os outros via removedIds, e a cota não devolve a vaga', async () => {
    const mock = createMockApi(opts);
    await mock.api.createGuest('dev123', 'Ana');
    const sent = await mock.api.uploadPhoto(photo(), 'x');
    const since = new Date(t).toISOString();
    t += 1000;
    await expect(mock.api.deletePhoto(sent.id)).resolves.toBeUndefined();
    // De novo: 204 (idempotente).
    await expect(mock.api.deletePhoto(sent.id)).resolves.toBeUndefined();
    const updates = await mock.api.getGalleryUpdates(since);
    expect(updates.removedIds).toEqual([sent.id]);
    expect((await mock.api.getGallery(null, 30)).items.map((i) => i.id)).not.toContain(sent.id);
    expect((await mock.api.getMe()).quota).toEqual(sent.quota);
  });

  it('404 para foto de outra pessoa ou inexistente; 401 sem sessão', async () => {
    const mock = createMockApi(opts);
    await expect(mock.api.deletePhoto('x')).rejects.toMatchObject({ status: 401 });
    await mock.api.createGuest('dev123', 'Ana');
    const deOutro = (await mock.api.getGallery(null, 30)).items.find((i) => !i.mine)!;
    await expect(mock.api.deletePhoto(deOutro.id)).rejects.toMatchObject({ status: 404 });
    await expect(mock.api.deletePhoto('nao-existe')).rejects.toMatchObject({ status: 404 });
  });

  it('cenários 404 e sem rede', async () => {
    const mock = createMockApi(opts);
    await mock.api.createGuest('dev123', 'Ana');
    const sent = await mock.api.uploadPhoto(photo(), 'x');
    mock.control.deleteScenario = 'not_found';
    await expect(mock.api.deletePhoto(sent.id)).rejects.toMatchObject({ status: 404 });
    mock.control.deleteScenario = 'network_down';
    await expect(mock.api.deletePhoto(sent.id)).rejects.toMatchObject({ code: NETWORK_ERROR });
    // A foto continua lá: nenhum dos dois apagou.
    expect((await mock.api.getGallery(null, 30)).items.map((i) => i.id)).toContain(sent.id);
  });
});
