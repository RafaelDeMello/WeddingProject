import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  errorMessage,
  isRetryable,
  isTotalQuotaError,
  type ApiError,
  type GuestSession,
  type Quota,
  type UploadResult,
} from '../api';
import { mergeGrid, nextOpenKey, type GridEntry, type LocalPhoto } from '../gallery';
import { clearPending, idbPendingStorage, pendingStoreFor, restorePending } from '../pendingStore';
import { quotaView } from '../quota';
import { UploadQueue, type QueueItem } from '../uploadQueue';
import { useGallery } from '../useGallery';
import { CameraView } from './CameraView';
import { ConfirmDeleteSheet } from './ConfirmDeleteSheet';
import { FailedSheet } from './FailedSheet';
import { GalleryScreen } from './GalleryScreen';
import { PhotoPreview } from './PhotoPreview';
import { PhotoViewer } from './PhotoViewer';

interface Props {
  session: GuestSession;
  eventName: string;
  /** Abertura do evento: primeiro `since` da galeria se o servidor não mandar serverTime. */
  eventOpensAt: string;
  onLoggedOut(): void;
  /** Sessão perdida (401) ou evento encerrado (403): o App recarrega o estado. */
  onSessionError(error: ApiError): void;
}

type Screen = 'gallery' | 'camera';

function secondsUntil(iso: string | null): number | undefined {
  if (!iso) return undefined;
  return Math.max(1, Math.ceil((Date.parse(iso) - Date.now()) / 1000));
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function GuestHome({ session, eventName, eventOpensAt, onLoggedOut, onSessionError }: Props) {
  const [screen, setScreen] = useState<Screen>('gallery');
  const [quota, setQuota] = useState<Quota>(session.quota);
  const [items, setItems] = useState<readonly QueueItem[]>([]);
  const [captured, setCaptured] = useState<Blob | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [sentCount, setSentCount] = useState(0);
  // clientUploadId → id no servidor, para trocar a foto local pelo item real da galeria.
  const [serverIds, setServerIds] = useState<ReadonlyMap<string, string>>(new Map());
  const [viewerKey, setViewerKey] = useState<string | null>(null);
  const [viewerNotice, setViewerNotice] = useState<string | null>(null);
  // Foto que pedimos para apagar e ainda estava aberta no visualizador.
  const [confirmDelete, setConfirmDelete] = useState<{ serverId: string; url: string; key: string } | null>(null);
  const deletingKey = useRef<string | null>(null);
  const [failedSheetId, setFailedSheetId] = useState<string | null>(null);
  const [attentionKey, setAttentionKey] = useState<string | null>(null);
  // Aviso curto (~2 s): "Foto enviada ✓" (a tela já voltou para a galeria), "Foto apagada"...
  const [toast, setToast] = useState<{ text: string; key: number } | null>(null);
  const showToast = useCallback((text: string) => setToast((t) => ({ text, key: (t?.key ?? 0) + 1 })), []);

  // Callbacks da fila leem sempre a versão atual das props.
  const onSessionErrorRef = useRef(onSessionError);
  onSessionErrorRef.current = onSessionError;
  const refreshGalleryRef = useRef<() => void>(() => undefined);

  const [queue] = useState(
    () =>
      new UploadQueue({
        upload: (photo, id) => api.uploadPhoto(photo, id),
        onChange: setItems,
        onSent: (result: UploadResult, item: QueueItem) => {
          setQuota(result.quota);
          setServerIds((m) => new Map(m).set(item.clientUploadId, result.id));
          setSentCount((n) => n + 1);
          setToast((t) => ({ text: 'Foto enviada ✓', key: (t?.key ?? 0) + 1 }));
          // O item real entra na galeria logo, sem esperar os 15 s.
          refreshGalleryRef.current();
        },
        store: pendingStoreFor(idbPendingStorage, session.guestId),
        onFailed: (error) => {
          if (error.status === 401 || error.code === 'upload_closed') onSessionErrorRef.current(error);
          // Total esgotado: zera a cota local, e a tela mostra "já enviou o máximo" (nunca "tente em X min").
          else if (isTotalQuotaError(error)) setQuota((q) => ({ ...q, remainingInWindow: 0, remainingTotal: 0 }));
          else if (error.status === 429) setNotice(errorMessage(error));
        },
      }),
  );

  const gallery = useGallery({
    fallbackSince: eventOpensAt,
    onUnauthorized: (err) => onSessionErrorRef.current(err),
  });
  refreshGalleryRef.current = gallery.refresh;

  useEffect(() => () => queue.dispose(), [queue]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2000);
    return () => clearTimeout(timer);
  }, [toast]);

  // Reabriu a página ou a sessão anterior caiu (401): reenvia as pendentes por esta sessão.
  // restore ignora ids já na fila, então rodar duas vezes (StrictMode) não duplica.
  useEffect(() => {
    void restorePending(idbPendingStorage, session.guestId, queue);
  }, [queue, session.guestId]);

  // Voltou a internet: reenvia na hora o que falhou por rede.
  useEffect(() => {
    const retryNetworkFailures = () => {
      for (const item of queue.getItems()) {
        if (item.status === 'failed' && isRetryable(item.error)) queue.retry(item.clientUploadId);
      }
    };
    window.addEventListener('online', retryNetworkFailures);
    return () => window.removeEventListener('online', retryNetworkFailures);
  }, [queue]);

  // Quando a foto mais antiga sai da janela, atualiza a cota com o servidor.
  useEffect(() => {
    const wait = secondsUntil(quota.resetsAt);
    if (wait === undefined) return;
    const timer = setTimeout(() => {
      api
        .getMe()
        .then((me) => {
          setQuota(me.quota);
          setNotice(null);
        })
        .catch((err: ApiError) => {
          if (err.status === 401) onSessionErrorRef.current(err);
        });
    }, wait * 1000 + 500);
    return () => clearTimeout(timer);
  }, [quota.resetsAt]);

  // Object URLs das fotos locais (criados uma vez por foto, liberados quando o item real chega).
  const urls = useRef(new Map<string, string>());
  useEffect(() => {
    const map = urls.current;
    return () => {
      for (const url of map.values()) URL.revokeObjectURL(url);
      map.clear();
    };
  }, []);

  const locals: LocalPhoto[] = items.flatMap((item) => {
    let url = urls.current.get(item.clientUploadId);
    if (!url && item.blob) {
      url = URL.createObjectURL(item.blob);
      urls.current.set(item.clientUploadId, url);
    }
    if (!url) return [];
    return [
      {
        clientUploadId: item.clientUploadId,
        url,
        createdAt: item.createdAt,
        status: item.status,
        error: item.error,
        serverId: serverIds.get(item.clientUploadId) ?? null,
      },
    ];
  });

  const { entries, superseded } = mergeGrid(
    gallery.state.items,
    locals,
    new Set([...gallery.state.removed, ...gallery.state.deleted]),
    new Set(gallery.state.deleting.keys()),
  );

  // O item real chegou (ou a moderação removeu, ou o convidado apagou): a foto local sai sem duplicar.
  const supersededKey = superseded.join(',');
  useEffect(() => {
    if (!supersededKey) return;
    for (const id of supersededKey.split(',')) {
      const url = urls.current.get(id);
      if (url) URL.revokeObjectURL(url);
      urls.current.delete(id);
      queue.forget(id);
    }
  }, [supersededKey, queue]);

  // Visualizador aberto numa foto que sumiu: segue para a vizinha ou fecha.
  // Moderação avisa "não está mais disponível"; a que o próprio convidado apagou, não.
  const lastViewerIndex = useRef(0);
  useEffect(() => {
    if (viewerKey === null) return;
    const index = entries.findIndex((e) => e.key === viewerKey);
    if (index >= 0) {
      lastViewerIndex.current = index;
      return;
    }
    // Sua foto local virou o item real da galeria: continua nela, sem aviso.
    const serverId = viewerKey.startsWith('local-') ? serverIds.get(viewerKey.slice('local-'.length)) : undefined;
    if (serverId && entries.some((e) => e.key === `srv-${serverId}`)) {
      setViewerKey(`srv-${serverId}`);
      return;
    }
    const replacement = nextOpenKey(entries, viewerKey, lastViewerIndex.current);
    const ownDelete = deletingKey.current === viewerKey;
    deletingKey.current = null;
    setViewerKey(replacement);
    setViewerNotice(ownDelete || replacement === null ? null : 'A foto que você via não está mais disponível.');
    if (replacement === null && !ownDelete) setNotice('A foto que você via não está mais disponível.');
  }, [entries, viewerKey, serverIds]);

  const askDelete = useCallback(
    (entry: GridEntry) => {
      const serverId =
        entry.kind === 'server' ? (entry.item.mine ? entry.item.id : null) : entry.local.status === 'sent' ? entry.local.serverId : null;
      if (!serverId) return;
      const url = entry.kind === 'server' ? entry.item.thumbUrl : entry.local.url;
      setConfirmDelete({ serverId, url, key: entry.key });
    },
    [],
  );

  async function confirmDeletion() {
    if (!confirmDelete) return;
    const { serverId, key } = confirmDelete;
    setConfirmDelete(null);
    if (viewerKey === key) deletingKey.current = key;
    // Remoção otimista: some da grade e do visualizador já (o navegador pode ter a imagem em cache).
    const { outcome } = await gallery.deletePhoto(serverId);
    if (outcome === 'deleted') showToast('Foto apagada');
    else showToast('Não foi possível apagar a foto. Tente novamente.');
  }

  const pending = items.filter((i) => i.status === 'queued' || i.status === 'sending' || i.status === 'waiting_retry').length;
  const failedItems = items.filter((i) => i.status === 'failed');
  const { available, suffix, limitMessage } = quotaView(quota, pending, Date.now());
  const limitReached = limitMessage !== null;

  function send() {
    if (!captured) return;
    queue.enqueue(captured);
    setCaptured(null);
    setNotice(null);
    setScreen('gallery');
    window.scrollTo({ top: 0 });
  }

  async function logout() {
    if (loggingOut) return;
    if (
      queue.pendingCount() > 0 &&
      !window.confirm('Ainda há fotos sendo enviadas. Se sair agora, elas não serão enviadas. Sair mesmo assim?')
    ) {
      return;
    }
    setLoggingOut(true);
    try {
      await api.logout();
      queue.dispose();
      await clearPending(idbPendingStorage, session.guestId);
      onLoggedOut();
    } catch (err) {
      // Sem apagar o cookie, a próxima pessoa entraria com a sessão desta.
      setNotice(`Não foi possível sair: ${errorMessage(err)}`);
      setLoggingOut(false);
    }
  }

  // Pílula de status: leva à primeira foto com falha (ou às que estão subindo).
  // Rolar/focar depois que a galeria renderizar (vindo da câmera, ela ainda não existe no clique).
  const [scrollRequest, setScrollRequest] = useState<{ key: string | null; n: number } | null>(null);
  const goToStatus = useCallback(() => {
    setScreen('gallery');
    const target = failedItems[0] ?? items.find((i) => i.status !== 'sent');
    const key = target ? `local-${target.clientUploadId}` : null;
    setAttentionKey(key);
    setScrollRequest((r) => ({ key, n: (r?.n ?? 0) + 1 }));
  }, [failedItems, items]);

  useEffect(() => {
    if (!scrollRequest) return;
    const el = scrollRequest.key ? document.getElementById(`tile-${scrollRequest.key}`) : null;
    if (el) {
      el.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
      el.focus({ preventScroll: true });
    } else {
      window.scrollTo({ top: 0 });
    }
  }, [scrollRequest]);

  useEffect(() => {
    if (!attentionKey) return;
    const timer = setTimeout(() => setAttentionKey(null), 2500);
    return () => clearTimeout(timer);
  }, [attentionKey]);

  const statusParts = [
    pending > 0 ? `${pending} enviando` : null,
    failedItems.length > 0 ? `${failedItems.length} ${failedItems.length === 1 ? 'falhou' : 'falharam'}` : null,
  ].filter(Boolean);
  const statusText =
    statusParts.length > 0
      ? statusParts.join(' · ')
      : sentCount > 0
        ? `${sentCount} ${sentCount === 1 ? 'enviada' : 'enviadas'} ✓`
        : null;

  const statusPill = statusText && (
    <button
      type="button"
      className={failedItems.length > 0 ? 'pill pill-status pill-status-failed' : 'pill pill-status'}
      onClick={goToStatus}
    >
      {statusText}
    </button>
  );

  const quotaNode = limitReached ? (
    <p className="banner">{limitMessage}</p>
  ) : (
    <p className="pill pill-quota">
      <span className="num">{available}</span> {suffix}
    </p>
  );

  const cameraTopBar = (
    <div className="topbar">
      <div className="topbar-row">
        <button type="button" className="link" onClick={() => setScreen('gallery')}>
          ← Galeria
        </button>
        <span className="greeting">
          Olá, <strong>{session.name}</strong>
        </span>
      </div>
      {quotaNode}
      {notice && !limitReached && <p className="banner">{notice}</p>}
    </div>
  );

  const failedItem = failedSheetId ? items.find((i) => i.clientUploadId === failedSheetId) : undefined;

  const openViewer = useCallback((key: string) => {
    setViewerNotice(null);
    setViewerKey(key);
  }, []);
  const closeViewer = useCallback(() => {
    setViewerKey(null);
    setViewerNotice(null);
  }, []);
  const navigateViewer = useCallback((key: string) => {
    setViewerNotice(null);
    setViewerKey(key);
  }, []);

  return (
    <>
      {screen === 'gallery' ? (
        <GalleryScreen
          eventName={eventName}
          guestName={session.name}
          loggingOut={loggingOut}
          onLogout={logout}
          entries={entries}
          firstPageLoaded={gallery.state.firstPageLoaded}
          hasMorePages={!gallery.state.firstPageLoaded || gallery.state.nextCursor !== null}
          loadingPage={gallery.loadingPage}
          loadError={gallery.error}
          onLoadMore={gallery.loadMore}
          onRetryLoad={gallery.retry}
          onOpen={openViewer}
          onFailedTap={setFailedSheetId}
          attentionKey={attentionKey}
          quota={quotaNode}
          statusPill={statusPill}
          notice={notice}
          takeDisabled={limitReached}
          onTakePhoto={() => {
            setNotice(null);
            setScreen('camera');
          }}
        />
      ) : (
        // A câmera só existe nesta tela: ao voltar para a galeria ela é desligada.
        <main className="guest-home">
          <CameraView
            disabled={limitReached || captured !== null}
            hidden={captured !== null}
            onCapture={setCaptured}
            topBar={cameraTopBar}
            statusPill={statusPill}
          />
        </main>
      )}

      {captured && <PhotoPreview photo={captured} onSend={send} onRetake={() => setCaptured(null)} />}

      {viewerKey && (
        <PhotoViewer
          entries={entries}
          openKey={viewerKey}
          myName={session.name}
          notice={viewerNotice}
          onDelete={askDelete}
          onNavigate={navigateViewer}
          onClose={closeViewer}
        />
      )}

      {confirmDelete && (
        <ConfirmDeleteSheet
          url={confirmDelete.url}
          onConfirm={() => void confirmDeletion()}
          onCancel={() => setConfirmDelete(null)}
        />
      )}

      {failedItem && (
        <FailedSheet
          url={urls.current.get(failedItem.clientUploadId) ?? null}
          error={failedItem.error}
          onRetry={() => {
            setNotice(null);
            queue.retry(failedItem.clientUploadId);
            setFailedSheetId(null);
          }}
          onDiscard={() => {
            const url = urls.current.get(failedItem.clientUploadId);
            if (url) URL.revokeObjectURL(url);
            urls.current.delete(failedItem.clientUploadId);
            queue.discard(failedItem.clientUploadId);
            setFailedSheetId(null);
          }}
          onClose={() => setFailedSheetId(null)}
        />
      )}

      {toast && (
        <p key={toast.key} className="toast" role="status">
          {toast.text}
        </p>
      )}
    </>
  );
}
