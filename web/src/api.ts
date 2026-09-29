// Todas as chamadas à API passam por aqui. Contrato: AGENTS.md → "API".
import { createMockApi } from './mockApi';

export type EventStatus = 'not_open' | 'open' | 'closed';

export interface EventInfo {
  name: string;
  status: EventStatus;
  opensAt: string;
  closesAt: string;
  limits: { perWindow: number; windowMinutes: number; total: number };
}

export interface Quota {
  remainingInWindow: number;
  remainingTotal: number;
  /** Quando a foto mais antiga da janela deixa de contar; null se não há fotos na janela. */
  resetsAt: string | null;
}

export interface GuestSession {
  guestId: string;
  name: string;
  quota: Quota;
}

export interface UploadResult {
  id: string;
  quota: Quota;
  /** true quando o servidor respondeu 200: o clientUploadId já tinha sido recebido. */
  duplicate: boolean;
}

export interface Api {
  getEvent(): Promise<EventInfo>;
  createGuest(slug: string, name: string): Promise<GuestSession>;
  /** Lança ApiError 401 `unauthorized` se não houver sessão. */
  getMe(): Promise<GuestSession>;
  logout(): Promise<void>;
  uploadPhoto(photo: Blob, clientUploadId: string): Promise<UploadResult>;
}

/** Código usado quando a requisição nem chegou a ter resposta (sem rede, timeout). */
export const NETWORK_ERROR = 'network_error';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const GENERIC_MESSAGE = 'Algo deu errado. Tente novamente.';

/** Converte uma resposta de erro `{ error: { code, message, retryAfterSeconds? } }` em ApiError. */
export function parseApiError(status: number, body: unknown, retryAfterHeader?: string | null): ApiError {
  const error =
    typeof body === 'object' && body !== null && 'error' in body
      ? (body as { error: unknown }).error
      : undefined;
  const fields = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};

  const code = typeof fields.code === 'string' && fields.code ? fields.code : `http_${status}`;
  const message = typeof fields.message === 'string' && fields.message ? fields.message : GENERIC_MESSAGE;

  let retryAfter: number | undefined;
  if (typeof fields.retryAfterSeconds === 'number' && Number.isFinite(fields.retryAfterSeconds)) {
    retryAfter = fields.retryAfterSeconds;
  } else if (retryAfterHeader && /^\d+$/.test(retryAfterHeader.trim())) {
    retryAfter = Number(retryAfterHeader.trim());
  }
  return new ApiError(status, code, message, retryAfter === undefined ? undefined : Math.max(1, retryAfter));
}

export function networkError(): ApiError {
  return new ApiError(0, NETWORK_ERROR, 'Sem conexão com o servidor.');
}

/** Vale a pena repetir automaticamente? Só falha de rede e erro do servidor (5xx, exceto disco cheio). */
export function isRetryable(err: unknown): boolean {
  if (!(err instanceof ApiError)) return true;
  if (err.code === NETWORK_ERROR) return true;
  return err.status >= 500 && err.status !== 507;
}

/** Mensagem do 429 conforme a spec, a partir de retryAfterSeconds. */
export function rateLimitMessage(retryAfterSeconds: number | undefined): string {
  if (!retryAfterSeconds) return 'Você atingiu o limite, tente novamente em alguns minutos.';
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `Você atingiu o limite, tente novamente em ${minutes} min.`;
}

/** Texto amigável para mostrar ao convidado. */
export function errorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return GENERIC_MESSAGE;
  if (err.status === 429) return rateLimitMessage(err.retryAfterSeconds);
  if (err.code === NETWORK_ERROR) return 'Sem conexão. Verifique a internet.';
  return err.message;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const JSON_TIMEOUT_MS = 15_000;
/** 4G fraco no salão: foto de ~300 KB pode demorar, mas não deve ficar presa para sempre. */
const UPLOAD_TIMEOUT_MS = 60_000;

export function createHttpApi(fetchImpl: FetchLike = (input, init) => fetch(input, init)): Api {
  async function request<T>(path: string, init: RequestInit, timeoutMs: number): Promise<{ status: number; body: T }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(path, { credentials: 'same-origin', ...init, signal: controller.signal });
    } catch {
      throw networkError();
    } finally {
      clearTimeout(timer);
    }

    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // Corpo vazio ou não-JSON (ex.: 502 do proxy): trata pelo status.
    }
    if (!res.ok) throw parseApiError(res.status, body, res.headers.get('Retry-After'));
    return { status: res.status, body: body as T };
  }

  const jsonPost = (body: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  return {
    async getEvent() {
      return (await request<EventInfo>('/api/event', { method: 'GET' }, JSON_TIMEOUT_MS)).body;
    },
    async createGuest(slug, name) {
      return (await request<GuestSession>('/api/guests', jsonPost({ slug, name }), JSON_TIMEOUT_MS)).body;
    },
    async getMe() {
      return (await request<GuestSession>('/api/me', { method: 'GET' }, JSON_TIMEOUT_MS)).body;
    },
    async logout() {
      await request('/api/session/logout', jsonPost({}), JSON_TIMEOUT_MS);
    },
    async uploadPhoto(photo, clientUploadId) {
      const form = new FormData();
      form.append('clientUploadId', clientUploadId);
      form.append('photo', photo, 'photo.jpg');
      const { status, body } = await request<{ id: string; quota: Quota }>(
        '/api/photos',
        { method: 'POST', body: form },
        UPLOAD_TIMEOUT_MS,
      );
      return { id: body.id, quota: body.quota, duplicate: status === 200 };
    },
  };
}

export type MockMode = 'off' | 'all' | 'photos';

/** VITE_MOCK_API=true → tudo simulado; =photos → só o upload simulado. */
export function parseMockMode(value: string | undefined): MockMode {
  if (value === 'true') return 'all';
  if (value === 'photos') return 'photos';
  return 'off';
}

export const mockMode: MockMode = parseMockMode(import.meta.env.VITE_MOCK_API);

const mock = mockMode === 'off' ? null : createMockApi();
const http = createHttpApi();

/** Controle do mock (cenário de upload, status do evento); null fora do modo mock. */
export const mockControl = mock?.control ?? null;

export const api: Api =
  mock === null ? http : mockMode === 'all' ? mock.api : { ...http, uploadPhoto: mock.api.uploadPhoto };
