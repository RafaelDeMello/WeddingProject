import { describe, expect, it } from 'vitest';
import {
  ApiError,
  NETWORK_ERROR,
  createHttpApi,
  canRetryManually,
  errorMessage,
  isTotalQuotaError,
  isRetryable,
  parseApiError,
  parseMockParts,
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

describe('parseMockParts', () => {
  const parts = (v: string | undefined) => [...parseMockParts(v)].sort();

  it('true simula tudo', () => {
    expect(parts('true')).toEqual(['gallery', 'photos', 'session']);
  });

  it('partes separadas por vírgula, com espaços e maiúsculas', () => {
    expect(parts('gallery')).toEqual(['gallery']);
    expect(parts(' Gallery , photos ')).toEqual(['gallery', 'photos']);
  });

  it('vazio, false ou desconhecido: nada simulado', () => {
    expect(parts(undefined)).toEqual([]);
    expect(parts('false')).toEqual([]);
    expect(parts('abc,')).toEqual([]);
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

describe('erros do upload (códigos reais do servidor)', () => {
  const e = (status: number, code: string, retryAfterSeconds?: number) =>
    new ApiError(status, code, 'mensagem do servidor', retryAfterSeconds);
  // total_quota_exceeded vem com retryAfter até o fim do evento (dias).
  const total = e(429, 'total_quota_exceeded', 3 * 86_400);

  it('429 total_quota_exceeded: "já enviou o máximo", nunca "tente em X min"', () => {
    expect(errorMessage(total)).toBe('Você já enviou o máximo de fotos.');
    expect(errorMessage(total)).not.toMatch(/min/);
    expect(isTotalQuotaError(total)).toBe(true);
    expect(isTotalQuotaError(e(429, 'quota_exceeded', 60))).toBe(false);
  });

  it('429 quota_exceeded: limite da janela em minutos', () => {
    expect(errorMessage(e(429, 'quota_exceeded', 420))).toBe('Você atingiu o limite, tente novamente em 7 min.');
  });

  it('429 rate_limited: limite da rede em minutos', () => {
    expect(errorMessage(e(429, 'rate_limited', 240))).toBe('Muitos acessos desta rede agora. Tente novamente em 4 min.');
  });

  it.each([
    [413, 'file_too_large', 'A foto é grande demais.'],
    [415, 'unsupported_media_type', 'Formato de imagem não suportado.'],
    [422, 'invalid_image', 'Não foi possível ler essa imagem.'],
    [507, 'insufficient_storage', 'Não foi possível salvar agora. Tente novamente mais tarde.'],
    [400, 'missing_photo', 'mensagem do servidor'],
  ])('%i %s → mensagem própria', (status, code, message) => {
    expect(errorMessage(e(status, code))).toBe(message);
  });

  it('nenhuma mensagem manda procurar os noivos', () => {
    for (const status of [400, 401, 403, 413, 415, 422, 429, 500, 502, 507]) {
      expect(errorMessage(e(status, 'x', 60))).not.toMatch(/noiv/i);
    }
  });

  it.each([
    [429, 'total_quota_exceeded'],
    [429, 'quota_exceeded'],
    [429, 'rate_limited'],
    [413, 'file_too_large'],
    [415, 'unsupported_media_type'],
    [422, 'invalid_image'],
    [400, 'validation_error'],
    [507, 'insufficient_storage'],
  ])('%i %s não entra no retry automático', (status, code) => {
    expect(isRetryable(e(status, code, 60))).toBe(false);
  });

  it('"Tentar de novo" manual só onde pode dar certo', () => {
    expect(canRetryManually(e(429, 'quota_exceeded', 60))).toBe(true);
    expect(canRetryManually(e(429, 'rate_limited', 60))).toBe(true);
    expect(canRetryManually(e(507, 'insufficient_storage'))).toBe(true);
    expect(canRetryManually(new ApiError(0, NETWORK_ERROR, 'x'))).toBe(true);
    for (const [status, code] of [
      [429, 'total_quota_exceeded'],
      [413, 'file_too_large'],
      [415, 'unsupported_media_type'],
      [422, 'invalid_image'],
      [400, 'validation_error'],
      [401, 'unauthorized'],
      [403, 'upload_closed'],
    ] as const) {
      expect(canRetryManually(e(status, code))).toBe(false);
    }
  });
});

describe('createHttpApi: galeria', () => {
  it('GET /api/gallery com limit e cursor', async () => {
    const urls: string[] = [];
    const api = createHttpApi(async (url) => {
      urls.push(url);
      return jsonResponse(200, { items: [], nextCursor: null, serverTime: '2026-10-03T22:00:00.000Z' });
    });
    await api.getGallery(null, 30);
    await api.getGallery('abc/+=', 30);
    expect(urls).toEqual(['/api/gallery?limit=30', '/api/gallery?limit=30&cursor=abc%2F%2B%3D']);
  });

  it('GET /api/gallery/updates com since; hasMore ausente vira false', async () => {
    const urls: string[] = [];
    const api = createHttpApi(async (url) => {
      urls.push(url);
      return jsonResponse(200, { added: [], removedIds: [], serverTime: '2026-10-03T22:00:00.000Z' });
    });
    const updates = await api.getGalleryUpdates('2026-10-03T21:59:30.000Z');
    expect(urls).toEqual(['/api/gallery/updates?since=2026-10-03T21%3A59%3A30.000Z']);
    expect(updates.hasMore).toBe(false);
  });
});

describe('createHttpApi: apagar foto', () => {
  it('DELETE /api/gallery/photos/:id; 204 sem corpo resolve', async () => {
    const calls: { url: string; method?: string }[] = [];
    const api = createHttpApi(async (url, init) => {
      calls.push({ url, method: init?.method });
      return new Response(null, { status: 204 });
    });
    await expect(api.deletePhoto('a/b')).resolves.toBeUndefined();
    expect(calls).toEqual([{ url: '/api/gallery/photos/a%2Fb', method: 'DELETE' }]);
  });

  it('404 vira ApiError not_found', async () => {
    const api = createHttpApi(async () => jsonResponse(404, { error: { code: 'not_found', message: 'Foto não encontrada.' } }));
    await expect(api.deletePhoto('x')).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });
});
