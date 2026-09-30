// Liga a lógica pura da galeria (gallery.ts) à API e ao ciclo de vida da tela.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, errorMessage, mockControl } from './api';
import {
  PAGE_SIZE,
  POLL_INTERVAL_MS,
  applyPage,
  drainUpdatesInto,
  initialGalleryState,
  type GalleryState,
} from './gallery';

/** Evento que o painel do mock dispara para consultar updates na hora (só em dev com mock). */
export const MOCK_REFRESH_EVENT = 'mock:gallery-refresh';

interface Options {
  /** Primeiro `since` se o servidor não mandar serverTime e a galeria estiver vazia. */
  fallbackSince: string;
  onUnauthorized(error: ApiError): void;
}

export interface GalleryHandle {
  state: GalleryState;
  loadingPage: boolean;
  /** Erro da primeira página (as consultas periódicas falham em silêncio e tentam de novo). */
  error: string | null;
  loadMore(): void;
  /** Consulta updates agora (ex.: logo depois de um envio). */
  refresh(): void;
  retry(): void;
}

export function useGallery({ fallbackSince, onUnauthorized }: Options): GalleryHandle {
  const [state, setState] = useState<GalleryState>(initialGalleryState);
  const stateRef = useRef(state);
  const [loadingPage, setLoadingPage] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadingRef = useRef(false);
  const refreshing = useRef(false);
  const refreshAgain = useRef(false);
  const mounted = useRef(true);
  const onUnauthorizedRef = useRef(onUnauthorized);
  onUnauthorizedRef.current = onUnauthorized;

  const box = useRef({
    get: () => stateRef.current,
    set: (next: GalleryState) => {
      stateRef.current = next;
      if (mounted.current) setState(next);
    },
  }).current;

  const handleError = useCallback((err: unknown): boolean => {
    if (err instanceof ApiError && err.status === 401) {
      onUnauthorizedRef.current(err);
      return true;
    }
    return false;
  }, []);

  const loadMore = useCallback(() => {
    const current = stateRef.current;
    if (loadingRef.current || (current.firstPageLoaded && current.nextCursor === null)) return;
    loadingRef.current = true;
    setLoadingPage(true);
    const cursor = current.firstPageLoaded ? current.nextCursor : null;
    api
      .getGallery(cursor, PAGE_SIZE)
      .then((page) => {
        box.set(applyPage(stateRef.current, page, fallbackSince));
        if (mounted.current) setError(null);
      })
      .catch((err: unknown) => {
        if (!handleError(err) && mounted.current) setError(errorMessage(err));
      })
      .finally(() => {
        loadingRef.current = false;
        if (mounted.current) setLoadingPage(false);
      });
  }, [box, fallbackSince, handleError]);

  const refresh = useCallback(() => {
    if (!stateRef.current.firstPageLoaded) return;
    // Uma consulta por vez; pedidos no meio do caminho viram mais uma rodada no fim.
    if (refreshing.current) {
      refreshAgain.current = true;
      return;
    }
    refreshing.current = true;
    const run = async () => {
      do {
        refreshAgain.current = false;
        try {
          await drainUpdatesInto(box, (since) => api.getGalleryUpdates(since));
        } catch (err) {
          handleError(err);
          return;
        }
      } while (refreshAgain.current && mounted.current);
    };
    void run().finally(() => {
      refreshing.current = false;
    });
  }, [box, handleError]);

  // Primeira página.
  useEffect(() => {
    mounted.current = true;
    loadMore();
    return () => {
      mounted.current = false;
    };
  }, [loadMore]);

  // Updates a cada 15 s, só com a aba visível; ao voltar para a aba, consulta na hora.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      if (document.visibilityState === 'hidden') return;
      timer = setTimeout(() => {
        refresh();
        schedule();
      }, POLL_INTERVAL_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState !== 'hidden') refresh();
      schedule();
    };
    schedule();
    document.addEventListener('visibilitychange', onVisibility);
    const onMockRefresh = () => refresh();
    if (mockControl) window.addEventListener(MOCK_REFRESH_EVENT, onMockRefresh);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      if (mockControl) window.removeEventListener(MOCK_REFRESH_EVENT, onMockRefresh);
    };
  }, [refresh]);

  const retry = useCallback(() => {
    setError(null);
    loadMore();
  }, [loadMore]);

  return { state, loadingPage, error, loadMore, refresh, retry };
}
