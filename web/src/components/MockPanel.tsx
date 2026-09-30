import { useState } from 'react';
import { mockControl, mockMode, type EventStatus } from '../api';
import { UPLOAD_SCENARIOS, type UploadScenario } from '../mockApi';

interface Props {
  onEventStatusChange(): void;
}

/** Painel de desenvolvimento, só aparece com VITE_MOCK_API. */
export function MockPanel({ onEventStatusChange }: Props) {
  const [scenario, setScenario] = useState<UploadScenario>(mockControl?.scenario ?? 'success');
  const [status, setStatus] = useState<EventStatus>(mockControl?.eventStatus ?? 'open');
  if (!mockControl) return null;
  const control = mockControl;

  return (
    <details className="mock-panel">
      <summary>Mock ({mockMode === 'all' ? 'API toda' : 'só upload'})</summary>
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
      {mockMode === 'all' && (
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
    </details>
  );
}
