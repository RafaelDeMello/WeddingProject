import { useState, type FormEvent } from 'react';
import { api, errorMessage, type ApiError, type GuestSession } from '../api';

interface Props {
  slug: string;
  eventName: string;
  onSession(session: GuestSession): void;
  /** 403/404 do servidor: o estado do evento mudou ou o link está errado. */
  onEventError(error: ApiError): void;
}

export function NameForm({ slug, eventName, onSession, onEventError }: Props) {
  const [name, setName] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (sending) return;
    const trimmed = name.trim();
    if (!trimmed) return setError('Digite seu nome.');
    setSending(true);
    setError(null);
    try {
      onSession(await api.createGuest(slug, trimmed));
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.status === 404) return onEventError(apiErr);
      setError(errorMessage(err));
      if (apiErr.status === 403) onEventError(apiErr);
    } finally {
      setSending(false);
    }
  }

  return (
    <form className="card name-form" onSubmit={submit}>
      <div className="ornament" aria-hidden="true" />
      <h1 className="title-script">{eventName}</h1>
      <div className="divider" aria-hidden="true" />
      <p className="lead">Tire fotos da festa e envie para os noivos. Antes, diga quem você é:</p>
      <label htmlFor="guest-name">Seu nome</label>
      <input
        id="guest-name"
        name="name"
        autoComplete="name"
        autoCapitalize="words"
        enterKeyHint="go"
        maxLength={80}
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={sending}
      />
      {error && <p className="error">{error}</p>}
      <button type="submit" className="primary" disabled={sending}>
        {sending ? 'Entrando…' : 'Continuar'}
      </button>
    </form>
  );
}
