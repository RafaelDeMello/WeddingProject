// API simulada para desenvolver o front sem backend (VITE_MOCK_API=true)
// ou sem o endpoint de upload (VITE_MOCK_API=photos).
import { uuidv4 } from './uuid';
import { ApiError, networkError, type Api, type EventStatus, type GuestSession, type Quota } from './api';

export type UploadScenario =
  | 'success' // 201 (ou 200 se o clientUploadId já foi recebido)
  | 'network_flaky' // cada foto falha 2 tentativas por rede e depois passa (exercita o retry)
  | 'network_down' // toda tentativa falha por rede
  | 'server_error' // 500 em toda tentativa
  | 'rate_limited' // 429 com retryAfterSeconds
  | 'upload_closed'; // 403 upload_closed

export const UPLOAD_SCENARIOS: { value: UploadScenario; label: string }[] = [
  { value: 'success', label: 'Sucesso (201)' },
  { value: 'network_flaky', label: 'Rede instável (falha 2x)' },
  { value: 'network_down', label: 'Sem rede' },
  { value: 'server_error', label: 'Erro 500' },
  { value: 'rate_limited', label: 'Limite (429)' },
  { value: 'upload_closed', label: 'Encerrado (403)' },
];

export interface MockOptions {
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
  latencyMs?: number;
  perWindow?: number;
  windowMinutes?: number;
  total?: number;
  slug?: string;
}

export interface MockControl {
  scenario: UploadScenario;
  eventStatus: EventStatus;
  /** Quantas vezes o upload foi chamado (inclui repetições). */
  uploadCalls: number;
}

export function createMockApi(options: MockOptions = {}): { api: Api; control: MockControl } {
  const now = options.now ?? (() => Date.now());
  const latencyMs = options.latencyMs ?? 400;
  const delay = options.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const perWindow = options.perWindow ?? 10;
  const windowMinutes = options.windowMinutes ?? 10;
  const total = options.total ?? 150;
  const slug = options.slug ?? 'dev123';
  const windowMs = windowMinutes * 60_000;

  const control: MockControl = { scenario: 'success', eventStatus: 'open', uploadCalls: 0 };
  let guest: { guestId: string; name: string } | null = null;
  // Chave: `<dono>:<clientUploadId>`. No modo photos o guest é do servidor real e o mock não o conhece: um dono só.
  const photos = new Map<string, { id: string; createdAt: number; owner: string }>();
  const owner = () => guest?.guestId ?? 'sem-sessao-mock';
  const flakyAttempts = new Map<string, number>();

  function quota(): Quota {
    const at = now();
    const mine = [...photos.values()].filter((p) => p.owner === owner());
    const inWindow = mine.filter((p) => p.createdAt > at - windowMs);
    const remainingTotal = Math.max(0, total - mine.length);
    const oldest = Math.min(...inWindow.map((p) => p.createdAt));
    return {
      remainingInWindow: Math.max(0, Math.min(perWindow - inWindow.length, remainingTotal)),
      remainingTotal,
      resetsAt: inWindow.length ? new Date(oldest + windowMs).toISOString() : null,
    };
  }

  function session(): GuestSession {
    if (!guest) throw new ApiError(401, 'unauthorized', 'Sessão inválida. Informe seu nome novamente.');
    return { ...guest, quota: quota() };
  }

  function closedError(): ApiError {
    return new ApiError(403, 'upload_closed', 'O envio de fotos já foi encerrado.');
  }

  function rateLimited(retryAfterSeconds: number): ApiError {
    const seconds = Math.max(1, Math.ceil(retryAfterSeconds));
    return new ApiError(429, 'rate_limited', 'Limite de fotos atingido.', seconds);
  }

  const api: Api = {
    async getEvent() {
      await delay(latencyMs);
      const opensAt = new Date(now() - 3_600_000).toISOString();
      const closesAt = new Date(now() + 3 * 86_400_000).toISOString();
      return {
        name: 'Casamento (mock)',
        status: control.eventStatus,
        opensAt,
        closesAt,
        limits: { perWindow, windowMinutes, total },
      };
    },

    async createGuest(requestedSlug, name) {
      await delay(latencyMs);
      if (requestedSlug !== slug) throw new ApiError(404, 'event_not_found', 'Evento não encontrado.');
      if (control.eventStatus !== 'open') {
        throw new ApiError(
          403,
          'upload_closed',
          control.eventStatus === 'not_open' ? 'O envio de fotos ainda não abriu.' : 'O envio de fotos já foi encerrado.',
        );
      }
      const trimmed = name.trim();
      if (!trimmed || [...trimmed].length > 40) {
        throw new ApiError(400, 'validation_error', 'Informe um nome de 1 a 40 caracteres.');
      }
      if (!guest) guest = { guestId: uuidv4(), name: trimmed };
      return session();
    },

    async getMe() {
      await delay(latencyMs);
      return session();
    },

    async logout() {
      await delay(latencyMs);
      guest = null;
    },

    async uploadPhoto(photo, clientUploadId) {
      control.uploadCalls += 1;
      await delay(latencyMs);
      if (!(photo instanceof Blob) || photo.size === 0) {
        throw new ApiError(400, 'invalid_image', 'Arquivo de imagem inválido.');
      }

      switch (control.scenario) {
        case 'network_down':
          throw networkError();
        case 'network_flaky': {
          const attempt = (flakyAttempts.get(clientUploadId) ?? 0) + 1;
          flakyAttempts.set(clientUploadId, attempt);
          if (attempt <= 2) throw networkError();
          break;
        }
        case 'server_error':
          throw new ApiError(500, 'internal_error', 'Erro interno.');
        case 'rate_limited':
          throw rateLimited(7 * 60);
        case 'upload_closed':
          throw closedError();
        case 'success':
          break;
      }

      // Idempotência: mesmo clientUploadId → 200 com a foto existente, sem contar de novo.
      const existing = photos.get(`${owner()}:${clientUploadId}`);
      if (existing) return { id: existing.id, quota: quota(), duplicate: true };

      const current = quota();
      if (current.remainingInWindow <= 0) {
        const resetsAt = current.resetsAt ? Date.parse(current.resetsAt) : now() + windowMs;
        throw rateLimited(current.remainingTotal <= 0 ? windowMs / 1000 : (resetsAt - now()) / 1000);
      }
      const created = { id: uuidv4(), createdAt: now() };
      photos.set(`${owner()}:${clientUploadId}`, { ...created, owner: owner() });
      return { id: created.id, quota: quota(), duplicate: false };
    },
  };

  return { api, control };
}
