// Página de moderação (ferramenta de emergência). JS puro, sem build e sem nada inline (CSP: script-src 'self').
// Nomes de convidado são conteúdo de usuário: só entram na página como texto (textContent) ou atributo, nunca como HTML.
(() => {
  'use strict';

  const API = '/api/admin';
  // Sempre URLs absolutas a partir de location.origin: se a página foi aberta por um link com usuário:senha na URL,
  // o baseURI herda essas credenciais e o fetch relativo é recusado pelo navegador.
  const url = (path) => new URL(path, location.origin).href;
  const PAGE_SIZE = 60;
  const AUTO_REFRESH_MS = 30_000;

  const grid = document.getElementById('grid');
  const countsEl = document.getElementById('counts');
  const statusEl = document.getElementById('status');
  const emptyEl = document.getElementById('empty');
  const moreBtn = document.getElementById('more');
  const refreshBtn = document.getElementById('refresh');

  const dateFormat = new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Sao_Paulo',
  });

  /** id → { el, button, hidden } */
  const cards = new Map();
  let nextCursor = null;
  let counts = { total: 0, hidden: 0 };
  let busy = false;

  function setStatus(message) {
    statusEl.textContent = message || '';
  }

  async function api(path, init) {
    let res;
    try {
      res = await fetch(url(API + path), { credentials: 'same-origin', ...init });
    } catch {
      throw new Error('Sem conexão com o servidor.');
    }
    if (res.status === 401) throw new Error('Sessão expirada. Recarregue a página e entre de novo.');
    if (!res.ok) {
      let message = `Erro ${res.status}.`;
      try {
        const body = await res.json();
        if (body && body.error && body.error.message) message = body.error.message;
      } catch {
        // corpo vazio ou não-JSON
      }
      throw new Error(message);
    }
    return res.json();
  }

  function renderCounts() {
    const visible = counts.total - counts.hidden;
    countsEl.textContent = `${counts.total} ${counts.total === 1 ? 'foto' : 'fotos'} · ${visible} visíveis · ${counts.hidden} ocultas`;
    emptyEl.hidden = counts.total > 0;
  }

  function applyState(card, hidden) {
    card.hidden = hidden;
    card.el.classList.toggle('is-hidden', hidden);
    card.button.textContent = hidden ? 'Reexibir' : 'Ocultar';
  }

  function createCard(photo) {
    const el = document.createElement('li');
    el.className = 'card';

    const link = document.createElement('a');
    link.className = 'thumb';
    link.href = url(photo.photoUrl);
    link.target = '_blank';
    link.rel = 'noopener';
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = url(photo.thumbUrl);
    img.alt = `Foto de ${photo.guestName}`;
    link.append(img);

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'Oculta';

    const meta = document.createElement('div');
    meta.className = 'meta';
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = photo.guestName;
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = dateFormat.format(new Date(photo.createdAt));
    meta.append(who, when);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toggle';

    el.append(link, badge, meta, button);
    const card = { el, button, hidden: photo.hidden };
    applyState(card, photo.hidden);
    button.addEventListener('click', () => toggle(photo.id));
    return card;
  }

  async function toggle(id) {
    const card = cards.get(id);
    if (!card || card.button.disabled) return;
    const wanted = !card.hidden;
    card.button.disabled = true;
    setStatus('');
    try {
      await api(`/photos/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hidden: wanted }),
      });
      counts.hidden += wanted ? 1 : -1;
      applyState(card, wanted);
      renderCounts();
    } catch (err) {
      setStatus(err.message);
    } finally {
      card.button.disabled = false;
    }
  }

  function resetGrid() {
    cards.clear();
    grid.replaceChildren();
  }

  /** Atualiza o topo da lista: novas fotos entram no começo; as que já estão na tela só têm o estado atualizado. */
  async function refresh() {
    if (busy) return;
    busy = true;
    refreshBtn.disabled = true;
    try {
      const data = await api(`/photos?limit=${PAGE_SIZE}`);
      counts = data.counts;

      const known = data.items.some((item) => cards.has(item.id));
      if (cards.size > 0 && !known) {
        // Entraram mais fotos do que cabem numa página desde a última vez: recomeça do topo.
        resetGrid();
        nextCursor = null;
      }
      if (cards.size === 0) nextCursor = data.nextCursor;

      // De trás para frente: cada foto nova vai para o começo e a ordem (mais recente primeiro) se mantém.
      for (let i = data.items.length - 1; i >= 0; i--) {
        const photo = data.items[i];
        const existing = cards.get(photo.id);
        if (existing) {
          applyState(existing, photo.hidden);
        } else {
          const card = createCard(photo);
          cards.set(photo.id, card);
          grid.prepend(card.el);
        }
      }
      moreBtn.hidden = nextCursor === null;
      renderCounts();
      setStatus('');
    } catch (err) {
      setStatus(err.message);
    } finally {
      busy = false;
      refreshBtn.disabled = false;
    }
  }

  async function loadMore() {
    if (busy || nextCursor === null) return;
    busy = true;
    moreBtn.disabled = true;
    try {
      const data = await api(`/photos?limit=${PAGE_SIZE}&cursor=${encodeURIComponent(nextCursor)}`);
      counts = data.counts;
      for (const photo of data.items) {
        if (cards.has(photo.id)) continue;
        const card = createCard(photo);
        cards.set(photo.id, card);
        grid.append(card.el);
      }
      nextCursor = data.nextCursor;
      moreBtn.hidden = nextCursor === null;
      renderCounts();
      setStatus('');
    } catch (err) {
      setStatus(err.message);
    } finally {
      busy = false;
      moreBtn.disabled = false;
    }
  }

  refreshBtn.addEventListener('click', () => void refresh());
  moreBtn.addEventListener('click', () => void loadMore());

  // Atualização periódica (só com a aba visível).
  setInterval(() => {
    if (document.visibilityState === 'visible') void refresh();
  }, AUTO_REFRESH_MS);

  void refresh();
})();
