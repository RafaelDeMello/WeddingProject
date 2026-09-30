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

export interface GalleryItem {
  id: string;
  guestName: string;
  /** ISO 8601. */
  createdAt: string;
  /** Mesma origem; o cookie de sessão autoriza. */
  thumbUrl: string;
  photoUrl: string;
  /** Foto do próprio convidado. */
  mine: boolean;
}

export interface GalleryPage {
  /** Mais recentes primeiro. */
  items: GalleryItem[];
  nextCursor: string | null;
  /** Relógio do servidor no momento da consulta: o primeiro `since` das atualizações. */
  serverTime?: string;
}

export interface GalleryUpdates {
  added: GalleryItem[];
  /** Fotos ocultadas pela moderação. */
  removedIds: string[];
  /** Próximo `since` (o cliente aplica a sobreposição). */
  serverTime: string;
  /** Há mais mudanças: consultar de novo na hora com o novo serverTime. */
  hasMore: boolean;
}

export interface Api {
  getEvent(): Promise<EventInfo>;
  createGuest(slug: string, name: string): Promise<GuestSession>;
  /** Lança ApiError 401 `unauthorized` se não houver sessão. */
  getMe(): Promise<GuestSession>;
  logout(): Promise<void>;
  uploadPhoto(photo: Blob, clientUploadId: string): Promise<UploadResult>;
  getGallery(cursor: string | null, limit: number): Promise<GalleryPage>;
  getGalleryUpdates(since: string): Promise<GalleryUpdates>;
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

/** Códigos de 429 do servidor (server/src/quota.ts e rateLimit.ts). */
export const TOTAL_QUOTA_EXCEEDED = 'total_quota_exceeded';
export const QUOTA_EXCEEDED = 'quota_exceeded';
export const RATE_LIMITED = 'rate_limited';

export const TOTAL_QUOTA_MESSAGE = 'Você já enviou o máximo de fotos.';

function minutesText(retryAfterSeconds: number | undefined): string {
  if (!retryAfterSeconds) return 'alguns minutos';
  return `${Math.max(1, Math.ceil(retryAfterSeconds / 60))} min`;
}

/** Mensagem da cota por janela, a partir de retryAfterSeconds. */
export function rateLimitMessage(retryAfterSeconds: number | undefined): string {
  return `Você atingiu o limite, tente novamente em ${minutesText(retryAfterSeconds)}.`;
}

export function isTotalQuotaError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 429 && err.code === TOTAL_QUOTA_EXCEEDED;
}

/** Texto amigável para mostrar ao convidado. Nunca manda procurar os noivos. */
export function errorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return GENERIC_MESSAGE;
  if (err.code === NETWORK_ERROR) return 'Sem conexão. Verifique a internet.';
  switch (err.status) {
    case 429:
      // O total não volta a liberar: nunca "tente em X min" (o retryAfter vai até o fim do evento).
      if (err.code === TOTAL_QUOTA_EXCEEDED) return TOTAL_QUOTA_MESSAGE;
      if (err.code === RATE_LIMITED) {
        return `Muitos acessos desta rede agora. Tente novamente em ${minutesText(err.retryAfterSeconds)}.`;
      }
      return rateLimitMessage(err.retryAfterSeconds);
    case 413:
      return 'A foto é grande demais.';
    case 415:
      return 'Formato de imagem não suportado.';
    case 422:
      return 'Não foi possível ler essa imagem.';
    case 507:
      return 'Não foi possível salvar agora. Tente novamente mais tarde.';
    default:
      return err.status >= 500 ? GENERIC_MESSAGE : err.message;
  }
}

/**
 * Oferecer "Tentar de novo" manual? Não quando repetir não tem como dar certo:
 * total esgotado, arquivo recusado (400/413/415/422) ou sessão/evento (401/403/404).
 */
export function canRetryManually(err: unknown): boolean {
  if (!(err instanceof ApiError)) return true;
  if (err.code === NETWORK_ERROR || err.status >= 500) return true;
  return err.status === 429 && err.code !== TOTAL_QUOTA_EXCEEDED;
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
    async getGallery(cursor, limit) {
      const params = new URLSearchParams({ limit: String(limit) });
      if (cursor) params.set('cursor', cursor);
      return (await request<GalleryPage>(`/api/gallery?${params}`, { method: 'GET' }, JSON_TIMEOUT_MS)).body;
    },
    async getGalleryUpdates(since) {
      const params = new URLSearchParams({ since });
      const body = (await request<GalleryUpdates>(`/api/gallery/updates?${params}`, { method: 'GET' }, JSON_TIMEOUT_MS))
        .body;
      return { ...body, hasMore: body.hasMore === true };
    },
  };
}

/** Grupos de endpoints que podem ser simulados. */
export type MockPart = 'session' | 'photos' | 'gallery';

/**
 * VITE_MOCK_API: `true` simula tudo; senão, partes separadas por vírgula
 * (`photos`, `gallery`, `session`) — o resto vai para a API real.
 */
export function parseMockParts(value: string | undefined): ReadonlySet<MockPart> {
  const raw = (value ?? '').trim().toLowerCase();
  if (raw === 'true' || raw === 'all') return new Set<MockPart>(['session', 'photos', 'gallery']);
  const valid: MockPart[] = ['session', 'photos', 'gallery'];
  return new Set(raw.split(',').map((p) => p.trim()).filter((p): p is MockPart => valid.includes(p as MockPart)));
}

// Mock só no `vite dev`: o build de produção nunca simula, mesmo com um .env.local esquecido,
// e o minificador descarta o código do mock (import.meta.env.DEV vira `false`).
export const mockParts: ReadonlySet<MockPart> = import.meta.env.DEV
  ? parseMockParts(import.meta.env.VITE_MOCK_API)
  : new Set();

const mock = import.meta.env.DEV && mockParts.size > 0 ? createMockApi() : null;
const http = createHttpApi();

/** Controle do mock (cenários, galeria, status do evento); null fora do modo mock. */
export const mockControl = mock?.control ?? null;

function pick<K extends keyof Api>(part: MockPart, keys: K[]): Pick<Api, K> {
  const source = mock !== null && mockParts.has(part) ? mock.api : http;
  return Object.fromEntries(keys.map((k) => [k, source[k]])) as Pick<Api, K>;
}

export const api: Api = {
  ...pick('session', ['getEvent', 'createGuest', 'getMe', 'logout']),
  ...pick('photos', ['uploadPhoto']),
  ...pick('gallery', ['getGallery', 'getGalleryUpdates']),
};
