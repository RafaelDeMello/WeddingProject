import { useEffect, useState } from 'react';

type Health = 'carregando' | 'ok' | 'erro';

export function App() {
  const [health, setHealth] = useState<Health>('carregando');

  useEffect(() => {
    fetch('/api/health')
      .then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
      .then((body: { ok?: boolean }) => setHealth(body.ok ? 'ok' : 'erro'))
      .catch(() => setHealth('erro'));
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 16 }}>
      <h1>Fotos do casamento</h1>
      <p>Em construção. Servidor: {health}</p>
    </main>
  );
}
