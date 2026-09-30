import { errorMessage } from '../api';
import type { QueueItem } from '../uploadQueue';

interface Props {
  items: readonly QueueItem[];
  onRetry(clientUploadId: string): void;
  onDiscard(clientUploadId: string): void;
}

const timeFormat = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });

function statusText(item: QueueItem): string {
  switch (item.status) {
    case 'queued':
      return 'Na fila…';
    case 'sending':
      return item.attempts > 1 ? `Enviando… (tentativa ${item.attempts})` : 'Enviando…';
    case 'waiting_retry':
      return 'Falhou, tentando de novo em instantes…';
    case 'sent':
      return 'Enviada ✓';
    case 'failed':
      return `Falhou: ${errorMessage(item.error)}`;
  }
}

export function UploadList({ items, onRetry, onDiscard }: Props) {
  const sent = items.filter((i) => i.status === 'sent').length;
  // Enviadas viram só um contador; na lista ficam as que ainda precisam de atenção + as 3 últimas enviadas.
  const recentSent = items.filter((i) => i.status === 'sent').slice(-3);
  const visible = items.filter((i) => i.status !== 'sent' || recentSent.includes(i)).reverse();
  if (items.length === 0) return null;

  return (
    <section className="uploads">
      <h2>{sent === 1 ? '1 foto enviada' : `${sent} fotos enviadas`}</h2>
      <ul>
        {visible.map((item) => (
          <li key={item.clientUploadId} className={`upload upload-${item.status}`}>
            <span className="upload-time">{timeFormat.format(item.createdAt)}</span>
            <span className="upload-status">{statusText(item)}</span>
            {(item.status === 'failed' || item.status === 'waiting_retry') && (
              <span className="upload-actions">
                <button type="button" className="small" onClick={() => onRetry(item.clientUploadId)}>
                  Tentar de novo
                </button>
                {item.status === 'failed' && (
                  <button type="button" className="small link" onClick={() => onDiscard(item.clientUploadId)}>
                    Descartar
                  </button>
                )}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
