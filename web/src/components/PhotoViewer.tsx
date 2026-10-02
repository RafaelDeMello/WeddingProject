import { useEffect, useRef, useState, type TouchEvent } from 'react';
import type { GridEntry } from '../gallery';

interface Props {
  entries: readonly GridEntry[];
  openKey: string;
  /** Nome do convidado atual (para as fotos locais, que ainda não têm guestName do servidor). */
  myName: string;
  /** Aviso no rodapé (ex.: a foto aberta foi removida pela moderação e ele pulou para outra). */
  notice: string | null;
  onNavigate(key: string): void;
  onClose(): void;
  /** "Apagar minha foto": só aparece nas fotos do convidado já enviadas. */
  onDelete(entry: GridEntry): void;
}

const timeFormat = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const SWIPE_MIN_PX = 50;

function describe(entry: GridEntry, myName: string) {
  if (entry.kind === 'server') {
    const { item } = entry;
    return {
      photo: item.photoUrl,
      thumb: item.thumbUrl,
      name: item.guestName,
      time: timeFormat.format(new Date(item.createdAt)),
      mine: item.mine,
    };
  }
  const { local } = entry;
  return { photo: local.url, thumb: local.url, name: myName, time: timeFormat.format(local.createdAt), mine: true };
}

/** Dá para apagar: foto sua no servidor, ou local já enviada (id no servidor conhecido). */
function canDelete(entry: GridEntry): boolean {
  return entry.kind === 'server' ? entry.item.mine : entry.local.status === 'sent' && entry.local.serverId !== null;
}

export function PhotoViewer({ entries, openKey, myName, notice, onNavigate, onClose, onDelete }: Props) {
  const index = entries.findIndex((e) => e.key === openKey);
  const entry = entries[index];
  const prev = index > 0 ? entries[index - 1] : undefined;
  const next = index >= 0 && index < entries.length - 1 ? entries[index + 1] : undefined;
  const closeRef = useRef<HTMLButtonElement>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
    // Trava a rolagem da página por trás (classe, não estilo inline: CSP).
    document.documentElement.classList.add('no-scroll');
    return () => document.documentElement.classList.remove('no-scroll');
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      else if (event.key === 'ArrowLeft' && prev) onNavigate(prev.key);
      else if (event.key === 'ArrowRight' && next) onNavigate(next.key);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prev, next, onClose, onNavigate]);

  if (!entry) return null;
  const info = describe(entry, myName);

  function onTouchStart(event: TouchEvent) {
    const t = event.touches[0];
    touchStart.current = t ? { x: t.clientX, y: t.clientY } : null;
  }

  function onTouchEnd(event: TouchEvent) {
    const start = touchStart.current;
    const t = event.changedTouches[0];
    touchStart.current = null;
    if (!start || !t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy)) return;
    if (dx < 0 && next) onNavigate(next.key);
    if (dx > 0 && prev) onNavigate(prev.key);
  }

  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={`Foto de ${info.name}`}>
      <div className="viewer-top">
        <span className="viewer-count">
          <span className="num">{index + 1}</span> de <span className="num">{entries.length}</span>
        </span>
        <button ref={closeRef} type="button" className="viewer-close" onClick={onClose} aria-label="Fechar">
          ✕
        </button>
      </div>

      <div className="viewer-stage" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        {/* Miniatura por baixo enquanto a foto grande carrega. */}
        <img className="viewer-thumb" src={info.thumb} alt="" aria-hidden="true" />
        <img
          key={entry.key}
          className={loadedKey === entry.key ? 'viewer-photo is-loaded' : 'viewer-photo'}
          src={info.photo}
          alt={`Foto de ${info.name} às ${info.time}`}
          onLoad={() => setLoadedKey(entry.key)}
        />
        {prev && (
          <button type="button" className="viewer-nav viewer-prev" onClick={() => onNavigate(prev.key)} aria-label="Foto anterior">
            ‹
          </button>
        )}
        {next && (
          <button type="button" className="viewer-nav viewer-next" onClick={() => onNavigate(next.key)} aria-label="Próxima foto">
            ›
          </button>
        )}
      </div>

      <div className="viewer-caption">
        {notice && (
          <p className="viewer-notice" role="status">
            {notice}
          </p>
        )}
        <p className="viewer-name guest-name">{info.mine ? `${info.name} (você)` : info.name}</p>
        <p className="viewer-time">{info.time}</p>
        {canDelete(entry) && (
          <button type="button" className="viewer-delete" onClick={() => onDelete(entry)}>
            Apagar minha foto
          </button>
        )}
      </div>
    </div>
  );
}
