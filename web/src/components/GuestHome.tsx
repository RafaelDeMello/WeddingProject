import { useEffect, useRef, useState } from 'react';
import { api, errorMessage, isRetryable, rateLimitMessage, type ApiError, type GuestSession, type Quota } from '../api';
import { clearPending, loadPending, pendingStoreFor } from '../pendingStore';
import { UploadQueue, type QueueItem } from '../uploadQueue';
import { CameraView } from './CameraView';
import { PhotoPreview } from './PhotoPreview';
import { UploadList } from './UploadList';

interface Props {
  session: GuestSession;
  onLoggedOut(): void;
  /** Sessão perdida (401) ou evento encerrado (403): o App recarrega o estado. */
  onSessionError(error: ApiError): void;
}

function secondsUntil(iso: string | null): number | undefined {
  if (!iso) return undefined;
  return Math.max(1, Math.ceil((Date.parse(iso) - Date.now()) / 1000));
}

export function GuestHome({ session, onLoggedOut, onSessionError }: Props) {
  const [quota, setQuota] = useState<Quota>(session.quota);
  const [items, setItems] = useState<readonly QueueItem[]>([]);
  const [captured, setCaptured] = useState<Blob | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  // "Foto enviada ✓" por ~2 s a cada envio concluído (a tela já voltou para a câmera).
  const [toastKey, setToastKey] = useState(0);
  const [toastVisible, setToastVisible] = useState(false);

  // Callbacks da fila leem sempre a versão atual das props.
  const onSessionErrorRef = useRef(onSessionError);
  onSessionErrorRef.current = onSessionError;

  const [queue] = useState(
    () =>
      new UploadQueue({
        upload: (photo, id) => api.uploadPhoto(photo, id),
        onChange: setItems,
        onSent: (result) => {
          setQuota(result.quota);
          setToastKey((k) => k + 1);
        },
        store: pendingStoreFor(session.guestId),
        onFailed: (error) => {
          if (error.status === 401 || error.code === 'upload_closed') onSessionErrorRef.current(error);
          else if (error.status === 429) setNotice(rateLimitMessage(error.retryAfterSeconds));
        },
      }),
  );

  useEffect(() => () => queue.dispose(), [queue]);

  useEffect(() => {
    if (toastKey === 0) return;
    setToastVisible(true);
    const timer = setTimeout(() => setToastVisible(false), 2000);
    return () => clearTimeout(timer);
  }, [toastKey]);

  // Reabriu a página: reenvia o que ficou pendente (mesmo clientUploadId → o servidor não duplica).
  useEffect(() => {
    let cancelled = false;
    void loadPending(session.guestId).then((records) => {
      if (!cancelled) records.forEach((record) => queue.restore(record));
    });
    return () => {
      cancelled = true;
    };
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

  const pending = items.filter((i) => i.status !== 'sent' && i.status !== 'failed').length;
  const remaining = Math.max(0, quota.remainingInWindow - pending);
  const limitReached = remaining <= 0;
  const limitMessage =
    quota.remainingTotal - pending <= 0
      ? 'Você já enviou o máximo de fotos. Muito obrigado!'
      : rateLimitMessage(secondsUntil(quota.resetsAt));

  function send() {
    if (!captured) return;
    queue.enqueue(captured);
    setCaptured(null);
    setNotice(null);
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
      await clearPending(session.guestId);
      onLoggedOut();
    } catch (err) {
      // Sem apagar o cookie, a próxima pessoa entraria com a sessão desta.
      setNotice(`Não foi possível sair: ${errorMessage(err)}`);
      setLoggingOut(false);
    }
  }

  const failed = items.filter((i) => i.status === 'failed').length;
  const sent = items.filter((i) => i.status === 'sent').length;
  const statusParts = [
    pending > 0 ? `${pending} enviando` : null,
    failed > 0 ? `${failed} ${failed === 1 ? 'falhou' : 'falharam'}` : null,
  ].filter(Boolean);
  const statusText =
    statusParts.length > 0 ? statusParts.join(' · ') : sent > 0 ? `${sent} ${sent === 1 ? 'enviada' : 'enviadas'} ✓` : null;

  const topBar = (
    <div className="topbar">
      <div className="topbar-row">
        <span className="greeting">
          Olá, <strong>{session.name}</strong>
        </span>
        <button type="button" className="link" onClick={logout} disabled={loggingOut}>
          Não é você?
        </button>
      </div>
      {limitReached ? (
        <p className="banner">{limitMessage}</p>
      ) : (
        <p className="pill pill-quota">
          <span className="num">{remaining}</span> {remaining === 1 ? 'foto restante' : 'fotos restantes'}
        </p>
      )}
      {notice && !limitReached && <p className="banner">{notice}</p>}
    </div>
  );

  // Toque na pílula leva à lista de envios, abaixo da câmera.
  const statusPill = statusText && (
    <button
      type="button"
      className={failed > 0 ? 'pill pill-status pill-status-failed' : 'pill pill-status'}
      onClick={() =>
        document.getElementById('envios')?.scrollIntoView({
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        })
      }
    >
      {statusText}
    </button>
  );

  return (
    <main className="guest-home">
      <CameraView
        disabled={limitReached || captured !== null}
        hidden={captured !== null}
        onCapture={setCaptured}
        topBar={topBar}
        statusPill={statusPill}
      />
      {captured && <PhotoPreview photo={captured} onSend={send} onRetake={() => setCaptured(null)} />}

      {toastVisible && (
        <p key={toastKey} className="toast" role="status">
          Foto enviada ✓
        </p>
      )}

      <UploadList
        items={items}
        onRetry={(id) => {
          setNotice(null);
          queue.retry(id);
        }}
        onDiscard={(id) => queue.discard(id)}
      />
    </main>
  );
}
