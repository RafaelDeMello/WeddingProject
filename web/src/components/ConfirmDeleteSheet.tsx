import { useEffect, useRef } from 'react';

interface Props {
  url: string;
  onConfirm(): void;
  onCancel(): void;
}

/** Confirmação antes de apagar a própria foto da galeria. */
export function ConfirmDeleteSheet({ url, onConfirm, onCancel }: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Foco em "Cancelar": apagar exige um toque deliberado.
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="sheet-backdrop" onClick={onCancel}>
      <div
        className="sheet card"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-title"
        aria-describedby="delete-desc"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="delete-title">Apagar esta foto da galeria?</h2>
        <img className="sheet-photo" src={url} alt="" />
        <p id="delete-desc">Ela continua contando no seu limite de fotos.</p>
        <div className="sheet-actions">
          <button type="button" className="danger" onClick={onConfirm}>
            Apagar
          </button>
          <button ref={cancelRef} type="button" className="secondary" onClick={onCancel}>
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}
