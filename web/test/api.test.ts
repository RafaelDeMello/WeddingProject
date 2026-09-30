import { describe, expect, it } from 'vitest';
import {
  ApiError,
  NETWORK_ERROR,
  createHttpApi,
  errorMessage,
  isRetryable,
  parseApiError,
  parseMockMode,
  rateLimitMessage,
} from '../src/api';

const quota = { remainingInWindow: 9, remainingTotal: 149, resetsAt: '2026-10-03T20:10:00.000Z' };

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

describe('parseApiError', () => {
  it('lê code e message do formato { error }', () => {
    const err = parseApiError(403, { error: { code: 'upload_closed', message: 'Encerrado.' } });
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 403, code: 'upload_closed', message: 'Encerrado.' });
    expect(err.retryAfterSeconds).toBeUndefined();
  });

  it('lê retryAfterSeconds de dentro de error no 429', () => {
    const err = parseApiError(429, { error: { code: 'rate_limited', message: 'x', retryAfterSeconds: 420 } });
    expect(err.retryAfterSeconds).toBe(420);
  });

  it('usa o header Retry-After se o corpo não trouxer', () => {
    expect(parseApiError(429, { error: { code: 'rate_limited', message: 'x' } }, '90').retryAfterSeconds).toBe(90);
  });

  it('corpo fora do formato vira erro genérico com o status', () => {
    for (const body of [null, 'texto', { erro: 1 }, { error: 'x' }, { error: { code: 5 } }]) {
      const err = parseApiError(502, body);
      expect(err.code).toBe('http_502');
      expect(err.message).toBeTruthy();
    }
  });
});

describe('isRetryable', () => {
  it('repete falha de rede e 5xx, exceto 507', () => {
    expect(isRetryable(new ApiError(0, NETWORK_ERROR, 'x'))).toBe(true);
    expect(isRetryable(new ApiError(500, 'internal_error', 'x'))).toBe(true);
    expect(isRetryable(new ApiError(502, 'http_502', 'x'))).toBe(true);
    expect(isRetryable(new ApiError(507, 'insufficient_storage', 'x'))).toBe(false);
  });

  it('não repete 4xx', () => {
    for (const status of [400, 401, 403, 404, 413, 415, 429]) {
      expect(isRetryable(new ApiError(status, 'x', 'x'))).toBe(false);
    }
  });
});

describe('mensagens', () => {
  it('429 em minutos, arredondando para cima', () => {
    expect(rateLimitMessage(420)).toBe('Você atingiu o limite, tente novamente em 7 min.');
    expect(rateLimitMessage(61)).toBe('Você atingiu o limite, tente novamente em 2 min.');
    expect(rateLimitMessage(5)).toBe('Você atingiu o limite, tente novamente em 1 min.');
    expect(rateLimitMessage(undefined)).toMatch(/alguns minutos/);
  });

  it('errorMessage usa a mensagem do servidor, exceto 429 e rede', () => {
    expect(errorMessage(new ApiError(403, 'upload_closed', 'Encerrado.'))).toBe('Encerrado.');
    expect(errorMessage(new ApiError(429, 'rate_limited', 'x', 120))).toMatch(/2 min/);
    expect(errorMessage(new ApiError(0, NETWORK_ERROR, 'x'))).toMatch(/conexão/i);
    expect(errorMessage(new Error('boom'))).toBeTruthy();
  });
});

describe('parseMockMode', () => {
  it('true → all, photos → photos, resto → off', () => {
    expect(parseMockMode('true')).toBe('all');
    expect(parseMockMode('photos')).toBe('photos');
    expect(parseMockMode(undefined)).toBe('off');
    expect(parseMockMode('false')).toBe('off');
  });
});

describe('createHttpApi', () => {
  it('POST /api/guests envia JSON e devolve a sessão', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const api = createHttpApi(async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(201, { guestId: 'g1', name: 'Ana', quota });
    });
    await expect(api.createGuest('abc', 'Ana')).resolves.toEqual({ guestId: 'g1', name: 'Ana', quota });
    expect(calls[0]?.url).toBe('/api/guests');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ slug: 'abc', name: 'Ana' });
  });

  it('upload envia multipart com photo e clientUploadId; 201 → duplicate false', async () => {
    let form: FormData | undefined;
    const api = createHttpApi(async (_url, init) => {
      form = init?.body as FormData;
      return jsonResponse(201, { id: 'p1', quota });
    });
    const result = await api.uploadPhoto(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }), 'cid-1');
    expect(result).toEqual({ id: 'p1', quota, duplicate: false });
    expect(form?.get('clientUploadId')).toBe('cid-1');
    expect(form?.get('photo')).toBeInstanceOf(Blob);
  });

  it('upload 200 (idempotente) → duplicate true', async () => {
    const api = createHttpApi(async () => jsonResponse(200, { id: 'p1', quota }));
    expect((await api.uploadPhoto(new Blob(['x']), 'cid-1')).duplicate).toBe(true);
  });

  it('erro HTTP vira ApiError com retryAfterSeconds', async () => {
    const api = createHttpApi(async () =>
      jsonResponse(
        429,
        { error: { code: 'rate_limited', message: 'Limite.', retryAfterSeconds: 300 } },
        { 'Retry-After': '300' },
      ),
    );
    await expect(api.uploadPhoto(new Blob(['x']), 'c')).rejects.toMatchObject({
      status: 429,
      code: 'rate_limited',
      retryAfterSeconds: 300,
    });
  });

  it('401 em /api/me vira ApiError unauthorized', async () => {
    const api = createHttpApi(async () => jsonResponse(401, { error: { code: 'unauthorized', message: 'Sem sessão.' } }));
    await expect(api.getMe()).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
  });

  it('fetch rejeitado vira network_error', async () => {
    const api = createHttpApi(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(api.getEvent()).rejects.toMatchObject({ status: 0, code: NETWORK_ERROR });
  });

  it('resposta não-JSON (502 do proxy) vira http_502', async () => {
    const api = createHttpApi(async () => new Response('<html>Bad Gateway</html>', { status: 502 }));
    await expect(api.getEvent()).rejects.toMatchObject({ status: 502, code: 'http_502' });
  });
});
