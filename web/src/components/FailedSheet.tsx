import { useEffect, useRef } from 'react';
import { canRetryManually, errorMessage, type ApiError } from '../api';

interface Props {
  url: string | null;
  error: ApiError | null;
  onRetry(): void;
  onDiscard(): void;
  onClose(): void;
}

/** Ações de uma foto do convidado que falhou ao enviar. */
export function FailedSheet({ url, error, onRetry, onDiscard, onClose }: Props) {
  const firstButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    firstButton.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const retryable = canRetryManually(error);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="failed-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="failed-title">Esta foto não foi enviada</h2>
        {url && <img className="sheet-photo" src={url} alt="" />}
        <p className="error">{errorMessage(error)}</p>
        <div className="sheet-actions">
          {retryable && (
            <button ref={firstButton} type="button" className="primary" onClick={onRetry}>
              Tentar de novo
            </button>
          )}
          <button ref={retryable ? undefined : firstButton} type="button" className="secondary" onClick={onDiscard}>
            Descartar
          </button>
          <button type="button" className="link" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}
