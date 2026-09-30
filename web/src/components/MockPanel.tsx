import { useState } from 'react';
import { mockControl, mockParts, type EventStatus } from '../api';
import { GALLERY_SEEDS, UPLOAD_SCENARIOS, type GallerySeed, type UploadScenario } from '../mockApi';
import { MOCK_REFRESH_EVENT } from '../useGallery';

interface Props {
  onEventStatusChange(): void;
}

/** Galeria: consulta updates na hora em vez de esperar os 15 s. */
function refreshGallery() {
  window.dispatchEvent(new Event(MOCK_REFRESH_EVENT));
}

/** Painel de desenvolvimento, só aparece com VITE_MOCK_API. */
export function MockPanel({ onEventStatusChange }: Props) {
  const [scenario, setScenario] = useState<UploadScenario>(mockControl?.scenario ?? 'success');
  const [status, setStatus] = useState<EventStatus>(mockControl?.eventStatus ?? 'open');
  const [seed, setSeed] = useState<GallerySeed>('few');
  const [last, setLast] = useState<string | null>(null);
  if (!mockControl) return null;
  const control = mockControl;

  return (
    <details className="mock-panel">
      <summary>Mock ({[...mockParts].join(', ')})</summary>
      {mockParts.has('photos') && (
        <label>
          Upload
          <select
            value={scenario}
            onChange={(e) => {
              const value = e.target.value as UploadScenario;
              control.scenario = value;
              setScenario(value);
            }}
          >
            {UPLOAD_SCENARIOS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {mockParts.has('session') && (
        <label>
          Evento
          <select
            value={status}
            onChange={(e) => {
              const value = e.target.value as EventStatus;
              control.eventStatus = value;
              setStatus(value);
              onEventStatusChange();
            }}
          >
            <option value="not_open">Ainda não abriu</option>
            <option value="open">Aberto</option>
            <option value="closed">Encerrado</option>
          </select>
        </label>
      )}
      {mockParts.has('gallery') && (
        <fieldset>
          <legend>Galeria</legend>
          <label>
            Início (recarrega a tela)
            <select
              value={seed}
              onChange={(e) => {
                const value = e.target.value as GallerySeed;
                control.seedGallery(value);
                setSeed(value);
                onEventStatusChange();
              }}
            >
              {GALLERY_SEEDS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => {
              control.addOthers(1);
              refreshGallery();
            }}
          >
            Chegou foto de outro convidado
          </button>
          <button
            type="button"
            onClick={() => {
              control.addOthers(45);
              refreshGallery();
            }}
          >
            Chegaram 45 fotos (hasMore)
          </button>
          <button
            type="button"
            onClick={() => {
              setLast(control.hideNewest());
              refreshGallery();
            }}
          >
            Moderar: remover a mais recente
          </button>
          <button
            type="button"
            onClick={() => {
              setLast(control.unhideLast());
              refreshGallery();
            }}
          >
            Reexibir a última removida
          </button>
          {last && <small>última: {last.slice(0, 8)}</small>}
        </fieldset>
      )}
    </details>
  );
}
