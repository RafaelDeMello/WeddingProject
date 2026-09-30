// API simulada para desenvolver o front sem backend. VITE_MOCK_API=true simula tudo;
// partes separadas por vírgula (photos, gallery, session) simulam só essas.
import {
  ApiError,
  QUOTA_EXCEEDED,
  RATE_LIMITED,
  TOTAL_QUOTA_EXCEEDED,
  networkError,
  type Api,
  type EventStatus,
  type GalleryItem,
  type GuestSession,
  type Quota,
} from './api';
import { uuidv4 } from './uuid';

export type UploadScenario =
  | 'success' // 201 (ou 200 se o clientUploadId já foi recebido)
  | 'network_flaky' // cada foto falha 2 tentativas por rede e depois passa (exercita o retry)
  | 'network_down' // toda tentativa falha por rede
  | 'server_error' // 500 em toda tentativa
  | 'quota_exceeded' // 429 cota da janela, com retryAfterSeconds
  | 'total_quota_exceeded' // 429 cota total (não volta a liberar)
  | 'rate_limited' // 429 limite por IP
  | 'file_too_large' // 413
  | 'unsupported_media_type' // 415
  | 'invalid_image' // 422
  | 'insufficient_storage' // 507
  | 'upload_closed'; // 403 upload_closed

export const UPLOAD_SCENARIOS: { value: UploadScenario; label: string }[] = [
  { value: 'success', label: 'Sucesso (201)' },
  { value: 'network_flaky', label: 'Rede instável (falha 2x)' },
  { value: 'network_down', label: 'Sem rede' },
  { value: 'server_error', label: 'Erro 500' },
  { value: 'quota_exceeded', label: 'Cota da janela (429)' },
  { value: 'total_quota_exceeded', label: 'Cota total (429)' },
  { value: 'rate_limited', label: 'Limite por rede (429)' },
  { value: 'file_too_large', label: 'Grande demais (413)' },
  { value: 'unsupported_media_type', label: 'Formato (415)' },
  { value: 'invalid_image', label: 'Imagem inválida (422)' },
  { value: 'insufficient_storage', label: 'Sem espaço (507)' },
  { value: 'upload_closed', label: 'Encerrado (403)' },
];

export type GallerySeed = 'empty' | 'few' | 'many';

export const GALLERY_SEEDS: { value: GallerySeed; label: string; count: number }[] = [
  { value: 'empty', label: 'Vazia', count: 0 },
  { value: 'few', label: '12 fotos', count: 12 },
  { value: 'many', label: '95 fotos (paginação)', count: 95 },
];

/** Máximo de mudanças por resposta de /updates (acima disso, hasMore). */
export const MOCK_UPDATES_LIMIT = 20;

export interface MockOptions {
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
  latencyMs?: number;
  perWindow?: number;
  windowMinutes?: number;
  total?: number;
  slug?: string;
  gallerySeed?: GallerySeed;
}

export interface MockControl {
  scenario: UploadScenario;
  eventStatus: EventStatus;
  /** Quantas vezes o upload foi chamado (inclui repetições). */
  uploadCalls: number;
  /** Recria a galeria (vazia, poucas, muitas). */
  seedGallery(seed: GallerySeed): void;
  /** Fotos de outros convidados chegando (entram na próxima consulta de updates). */
  addOthers(count: number): void;
  /** Moderação: oculta a foto visível mais recente (ou a de `id`). Devolve o id ocultado. */
  hideNewest(id?: string): string | null;
  /** Moderação: reexibe a última ocultada. */
  unhideLast(): string | null;
}

interface MockPhoto {
  id: string;
  ownerId: string;
  guestName: string;
  createdAt: number;
  hiddenAt: number | null;
  /** Última mudança (criação, ocultação ou reexibição): é o que /updates usa. */
  changedAt: number;
  thumbUrl: string;
  photoUrl: string;
}

const OTHER_NAMES = ['Ana', 'Bruno', 'Carla', 'Diego', 'Eduarda', 'Felipe', 'Gabi', 'Heitor', 'Isa', 'João', 'Lara', 'Marcos', 'Nina', 'Otávio', 'Paula', 'Rafa'];
const SWATCHES = ['#8FA878', '#EFC4B8', '#C9D6B8', '#F2B98E', '#B8912F', '#4F6B40'];

/** Imagem de mentira: SVG em data: (a CSP permite data: em img-src; funciona em node nos testes). */
function svgPhoto(n: number, name: string, width: number, height: number): string {
  const bg = SWATCHES[n % SWATCHES.length]!;
  const fg = bg === '#4F6B40' || bg === '#B8912F' ? '#F6F2E9' : '#3A5230';
  const size = Math.round(Math.min(width, height) / 3);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">` +
    `<rect width="100%" height="100%" fill="${bg}"/>` +
    `<circle cx="${width / 2}" cy="${height / 2}" r="${size}" fill="${fg}" fill-opacity="0.12"/>` +
    `<text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="Georgia,serif" font-size="${size * 0.8}" fill="${fg}">${n}</text>` +
    `<text x="50%" y="${height - size * 0.35}" text-anchor="middle" font-family="sans-serif" font-size="${size * 0.28}" fill="${fg}">${name}</text>` +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
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

  let guest: { guestId: string; name: string } | null = null;
  // Chave: `<dono>:<clientUploadId>`. Sem sessão simulada (upload mock com sessão real), um dono só.
  const uploads = new Map<string, { id: string; createdAt: number; owner: string }>();
  const owner = () => guest?.guestId ?? 'sem-sessao-mock';
  const flakyAttempts = new Map<string, number>();

  let gallery: MockPhoto[] = [];
  let photoNumber = 0;
  const hiddenStack: string[] = [];

  function makePhoto(ownerId: string, guestName: string, createdAt: number, blob?: Blob): MockPhoto {
    photoNumber += 1;
    const portrait = photoNumber % 3 !== 0;
    const local = blob && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
    const localUrl = local ? URL.createObjectURL(blob) : null;
    return {
      id: uuidv4(),
      ownerId,
      guestName,
      createdAt,
      hiddenAt: null,
      changedAt: createdAt,
      thumbUrl: localUrl ?? svgPhoto(photoNumber, guestName, 400, 400),
      photoUrl: localUrl ?? svgPhoto(photoNumber, guestName, portrait ? 900 : 1200, portrait ? 1200 : 900),
    };
  }

  function toItem(p: MockPhoto): GalleryItem {
    return {
      id: p.id,
      guestName: p.guestName,
      createdAt: new Date(p.createdAt).toISOString(),
      thumbUrl: p.thumbUrl,
      photoUrl: p.photoUrl,
      mine: p.ownerId === owner(),
    };
  }

  const visibleNewestFirst = () =>
    gallery.filter((p) => p.hiddenAt === null).sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));

  function quota(): Quota {
    const at = now();
    const mine = [...uploads.values()].filter((p) => p.owner === owner());
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

  function requireSession(): void {
    if (!guest) throw new ApiError(401, 'unauthorized', 'Sessão inválida. Informe seu nome novamente.');
  }

  // Mesmos códigos do servidor (server/src/quota.ts e rateLimit.ts).
  function tooMany(code: string, retryAfterSeconds: number): ApiError {
    const seconds = Math.max(1, Math.ceil(retryAfterSeconds));
    return new ApiError(429, code, 'Limite de fotos atingido.', seconds);
  }

  const control: MockControl = {
    scenario: 'success',
    eventStatus: 'open',
    uploadCalls: 0,
    seedGallery(seed) {
      const count = GALLERY_SEEDS.find((s) => s.value === seed)?.count ?? 0;
      const at = now();
      gallery = [];
      hiddenStack.length = 0;
      // Mais antigas antes: a nº 1 é a primeira foto da festa.
      for (let i = count - 1; i >= 0; i--) {
        const name = OTHER_NAMES[i % OTHER_NAMES.length]!;
        gallery.push(makePhoto(`outro-${name}`, name, at - (i + 1) * 90_000));
      }
    },
    addOthers(count) {
      const at = now();
      for (let i = 0; i < count; i++) {
        const name = OTHER_NAMES[(photoNumber + i) % OTHER_NAMES.length]!;
        // Todas no mesmo segundo: força o caso "mais mudanças que o limite dentro de 30 s".
        // 1 ms de diferença entre elas: um corte por `>` não perde fotos empatadas.
        gallery.push(makePhoto(`outro-${name}`, name, at + i));
      }
    },
    hideNewest(id) {
      const target = id ? gallery.find((p) => p.id === id && p.hiddenAt === null) : visibleNewestFirst()[0];
      if (!target) return null;
      target.hiddenAt = now();
      target.changedAt = now();
      hiddenStack.push(target.id);
      return target.id;
    },
    unhideLast() {
      const id = hiddenStack.pop();
      const target = gallery.find((p) => p.id === id);
      if (!target) return null;
      target.hiddenAt = null;
      target.changedAt = now();
      return target.id;
    },
  };
  control.seedGallery(options.gallerySeed ?? 'few');

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
        case 'quota_exceeded':
          throw tooMany(QUOTA_EXCEEDED, 7 * 60);
        case 'total_quota_exceeded':
          throw tooMany(TOTAL_QUOTA_EXCEEDED, 3 * 86_400);
        case 'rate_limited':
          throw tooMany(RATE_LIMITED, 4 * 60);
        case 'file_too_large':
          throw new ApiError(413, 'file_too_large', 'Arquivo grande demais.');
        case 'unsupported_media_type':
          throw new ApiError(415, 'unsupported_media_type', 'Formato não suportado.');
        case 'invalid_image':
          throw new ApiError(422, 'invalid_image', 'Imagem inválida.');
        case 'insufficient_storage':
          throw new ApiError(507, 'insufficient_storage', 'Sem espaço em disco.');
        case 'upload_closed':
          throw new ApiError(403, 'upload_closed', 'O envio de fotos já foi encerrado.');
        case 'success':
          break;
      }

      // Idempotência: mesmo clientUploadId → 200 com a foto existente, sem contar de novo.
      const key = `${owner()}:${clientUploadId}`;
      const existing = uploads.get(key);
      if (existing) return { id: existing.id, quota: quota(), duplicate: true };

      const current = quota();
      if (current.remainingTotal <= 0) throw tooMany(TOTAL_QUOTA_EXCEEDED, 3 * 86_400);
      if (current.remainingInWindow <= 0) {
        const resetsAt = current.resetsAt ? Date.parse(current.resetsAt) : now() + windowMs;
        throw tooMany(QUOTA_EXCEEDED, (resetsAt - now()) / 1000);
      }
      const created = makePhoto(owner(), guest?.name ?? 'Você', now(), photo);
      gallery.push(created);
      uploads.set(key, { id: created.id, createdAt: created.createdAt, owner: owner() });
      return { id: created.id, quota: quota(), duplicate: false };
    },

    async getGallery(cursor, limit) {
      await delay(latencyMs);
      requireSession();
      const visible = visibleNewestFirst();
      const start = cursor ? visible.findIndex((p) => p.id === cursor) + 1 : 0;
      const page = start > 0 || !cursor ? visible.slice(start, start + limit) : [];
      const last = page[page.length - 1];
      const hasNext = start + limit < visible.length;
      return {
        items: page.map(toItem),
        nextCursor: hasNext && last ? last.id : null,
        serverTime: new Date(now()).toISOString(),
      };
    },

    async getGalleryUpdates(since) {
      await delay(latencyMs);
      requireSession();
      const sinceMs = Date.parse(since);
      if (!Number.isFinite(sinceMs)) throw new ApiError(400, 'validation_error', 'since inválido.');
      const changes = gallery
        .filter((p) => p.changedAt > sinceMs)
        .sort((a, b) => a.changedAt - b.changedAt || (a.id < b.id ? -1 : 1));
      const batch = changes.slice(0, MOCK_UPDATES_LIMIT);
      const hasMore = changes.length > MOCK_UPDATES_LIMIT;
      return {
        added: batch.filter((p) => p.hiddenAt === null).map(toItem),
        removedIds: batch.filter((p) => p.hiddenAt !== null).map((p) => p.id),
        // Com hasMore, o corte é a última mudança entregue; senão, o "agora".
        serverTime: new Date(hasMore ? batch[batch.length - 1]!.changedAt : now()).toISOString(),
        hasMore,
      };
    },
  };

  return { api, control };
}
