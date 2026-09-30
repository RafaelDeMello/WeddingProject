import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, errorMessage, type ApiError, type EventInfo, type GuestSession } from './api';
import { GuestHome } from './components/GuestHome';
import { MockPanel } from './components/MockPanel';
import { NameForm } from './components/NameForm';
import { slugFromPath } from './slug';


type State =
  | { kind: 'loading' }
  | { kind: 'load_error'; message: string }
  | { kind: 'not_found' }
  | { kind: 'event'; event: EventInfo; session: GuestSession | null };

const dateFormat = new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'America/Sao_Paulo',
});

export function App() {
  const slug = slugFromPath(window.location.pathname);
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const event = await api.getEvent();
      let session: GuestSession | null = null;
      if (event.status === 'open') {
        try {
          session = await api.getMe();
        } catch (err) {
          if ((err as ApiError).status !== 401) throw err;
        }
      }
      setState({ kind: 'event', event, session });
    } catch (err) {
      setState({ kind: 'load_error', message: errorMessage(err) });
    }
  }, []);

  useEffect(() => {
    if (slug) void load();
  }, [slug, load]);

  // 404 do slug vira tela própria; 401 recarrega evento e sessão.
  // 403 upload_closed confere o evento sem desmontar a tela: se ainda estiver aberto, a fila continua.
  const onServerError = useCallback(
    (err: ApiError) => {
      if (err.status === 404) return setState({ kind: 'not_found' });
      if (err.status !== 403) return void load();
      api
        .getEvent()
        .then((event) => {
          if (event.status !== 'open') setState((s) => (s.kind === 'event' ? { ...s, event } : s));
        })
        .catch(() => undefined);
    },
    [load],
  );

  const mockPanel = <MockPanel onEventStatusChange={() => void load()} />;

  if (!slug) {
    return (
      <Message title="Link incompleto">
        Escaneie o QR Code que está na sua mesa para enviar fotos.
      </Message>
    );
  }

  switch (state.kind) {
    case 'loading':
      return (
        <>
          <Message title="Carregando…" />
          {mockPanel}
        </>
      );
    case 'load_error':
      return (
        <>
          <Message title="Não foi possível carregar">
            <p>{state.message}</p>
            <button type="button" className="primary" onClick={() => void load()}>
              Tentar de novo
            </button>
          </Message>
          {mockPanel}
        </>
      );
    case 'not_found':
      return (
        <Message title="Evento não encontrado">
          Confira se você escaneou o QR Code da mesa do casamento.
        </Message>
      );
    case 'event': {
      const { event, session } = state;
      let content;
      if (event.status === 'not_open') {
        content = (
          <Message title={event.name}>
            O envio de fotos abre em {dateFormat.format(new Date(event.opensAt))}. Volte nesse horário!
          </Message>
        );
      } else if (event.status === 'closed') {
        content = (
          <Message title={event.name}>O envio de fotos foi encerrado. Obrigado por participar!</Message>
        );
      } else if (!session) {
        content = (
          <main>
            <NameForm
              slug={slug}
              eventName={event.name}
              onSession={(s) => setState({ kind: 'event', event, session: s })}
              onEventError={onServerError}
            />
          </main>
        );
      } else {
        content = (
          <GuestHome
            key={session.guestId}
            session={session}
            onLoggedOut={() => setState({ kind: 'event', event, session: null })}
            onSessionError={onServerError}
          />
        );
      }
      return (
        <>
          {content}
          {mockPanel}
        </>
      );
    }
  }
}

function Message({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <main className="message">
      <h1>{title}</h1>
      {children && <div>{children}</div>}
    </main>
  );
}
