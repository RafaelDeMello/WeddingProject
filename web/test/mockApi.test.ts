import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError, NETWORK_ERROR } from '../src/api';
import { createMockApi } from '../src/mockApi';

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
    expect(err).toMatchObject({ status: 429, code: 'rate_limited', retryAfterSeconds: 9 * 60 });
    clock += 9 * 60_000 + 1;
    await expect(api.uploadPhoto(photo(), 'd')).resolves.toMatchObject({ duplicate: false });
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
    control.scenario = 'rate_limited';
    await expect(api.uploadPhoto(photo(), 'a')).rejects.toMatchObject({ status: 429, retryAfterSeconds: 420 });
    control.scenario = 'upload_closed';
    await expect(api.uploadPhoto(photo(), 'a')).rejects.toMatchObject({ status: 403, code: 'upload_closed' });
    control.scenario = 'server_error';
    await expect(api.uploadPhoto(photo(), 'a')).rejects.toMatchObject({ status: 500 });
    control.scenario = 'network_down';
    await expect(api.uploadPhoto(photo(), 'a')).rejects.toMatchObject({ status: 0, code: NETWORK_ERROR });
  });
});
