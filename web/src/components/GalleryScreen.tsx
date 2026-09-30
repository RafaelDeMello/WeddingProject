import { useEffect, useRef, type ReactNode } from 'react';
import type { GridEntry } from '../gallery';

interface Props {
  eventName: string;
  guestName: string;
  loggingOut: boolean;
  onLogout(): void;
  entries: readonly GridEntry[];
  firstPageLoaded: boolean;
  hasMorePages: boolean;
  loadingPage: boolean;
  loadError: string | null;
  onLoadMore(): void;
  onRetryLoad(): void;
  onOpen(key: string): void;
  onFailedTap(clientUploadId: string): void;
  /** Tile a destacar (a pílula de status leva às fotos com falha). */
  attentionKey: string | null;
  /** Pílula de cota ou mensagem de limite. */
  quota: ReactNode;
  statusPill: ReactNode;
  notice: string | null;
  takeDisabled: boolean;
  onTakePhoto(): void;
}

const timeFormat = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });

function Tile({
  entry,
  attention,
  onOpen,
  onFailedTap,
}: {
  entry: GridEntry;
  attention: boolean;
  onOpen(key: string): void;
  onFailedTap(id: string): void;
}) {
  const className = attention ? 'tile is-attention' : 'tile';
  if (entry.kind === 'server') {
    const { item } = entry;
    const time = timeFormat.format(new Date(item.createdAt));
    return (
      <button type="button" id={`tile-${entry.key}`} className={className} onClick={() => onOpen(entry.key)}>
        <img src={item.thumbUrl} alt={`Foto de ${item.guestName} às ${time}`} loading="lazy" decoding="async" />
        {item.mine && <span className="tile-badge tile-badge-mine">sua</span>}
      </button>
    );
  }
  const { local } = entry;
  const failed = local.status === 'failed';
  const label =
    local.status === 'sent' ? 'Enviada ✓' : failed ? 'Falhou' : local.status === 'waiting_retry' ? 'Tentando…' : 'Enviando…';
  return (
    <button
      type="button"
      id={`tile-${entry.key}`}
      className={`${className} tile-local tile-${local.status}`}
      onClick={() => (failed ? onFailedTap(local.clientUploadId) : onOpen(entry.key))}
      aria-label={failed ? 'Sua foto: falhou ao enviar. Toque para ver as opções.' : `Sua foto: ${label}`}
    >
      <img src={local.url} alt="" decoding="async" />
      <span className={`tile-badge tile-badge-${failed ? 'failed' : local.status === 'sent' ? 'sent' : 'sending'}`}>
        {label}
      </span>
    </button>
  );
}

export function GalleryScreen(props: Props) {
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasMorePages, loadingPage, onLoadMore } = props;

  // Rolagem infinita: carrega a próxima página quando o fim da grade se aproxima.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMorePages || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (records) => {
        if (records.some((r) => r.isIntersecting) && !loadingPage) onLoadMore();
      },
      { rootMargin: '800px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMorePages, loadingPage, onLoadMore]);

  const empty = props.firstPageLoaded && props.entries.length === 0;

  return (
    <main className="gallery-page">
      <header className="gallery-header">
        <h1 className="title-script gallery-title">{props.eventName}</h1>
        <div className="gallery-greeting">
          <span className="greeting">
            Olá, <strong>{props.guestName}</strong>
          </span>
          <button type="button" className="link" onClick={props.onLogout} disabled={props.loggingOut}>
            Não é você?
          </button>
        </div>
        <div className="divider" aria-hidden="true" />
      </header>

      {props.notice && <p className="banner gallery-notice">{props.notice}</p>}

      {empty && (
        <div className="card gallery-empty">
          <div className="ornament" aria-hidden="true" />
          <p className="lead">Ainda não há fotos. Que tal a primeira?</p>
        </div>
      )}

      {props.entries.length > 0 && (
        <ul className="grid" aria-label="Fotos da festa">
          {props.entries.map((entry) => (
            <li key={entry.key}>
              <Tile
                entry={entry}
                attention={props.attentionKey === entry.key}
                onOpen={props.onOpen}
                onFailedTap={props.onFailedTap}
              />
            </li>
          ))}
        </ul>
      )}

      <div ref={sentinel} className="grid-sentinel" aria-hidden="true" />
      {props.loadError ? (
        <div className="gallery-status">
          <p className="error">{props.loadError}</p>
          <button type="button" className="secondary" onClick={props.onRetryLoad}>
            Tentar de novo
          </button>
        </div>
      ) : (
        (loadingPage || !props.firstPageLoaded) && <p className="gallery-status">Carregando fotos…</p>
      )}
      {/* Sem IntersectionObserver (navegador antigo): botão manual. */}
      {hasMorePages && !loadingPage && typeof IntersectionObserver === 'undefined' && (
        <div className="gallery-status">
          <button type="button" className="secondary" onClick={onLoadMore}>
            Ver mais fotos
          </button>
        </div>
      )}

      <footer className="gallery-bar">
        <div className="gallery-bar-row">
          {props.quota}
          {props.statusPill}
        </div>
        <button type="button" className="primary take-photo" disabled={props.takeDisabled} onClick={props.onTakePhoto}>
          Tirar foto
        </button>
      </footer>
    </main>
  );
}
