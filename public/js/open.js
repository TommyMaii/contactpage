// Customer flow. The QR on the display carries a key (?k=) that is good for
// one spin per phone; a refresh shows the pull you already made. Modes:
//  - 'screen': opens as soon as the page loads; the reel plays here AND on
//    the shop display.
//  - 'phone':  tap the case to open; the reel plays here only.

import { confettiBurst, itemNode, makeRarityLookup, spinReel, tick } from './reel.js';

const el = (id) => document.getElementById(id);

const screens = {
  loading: el('screen-loading'),
  closed: el('screen-closed'),
  ticket: el('screen-ticket'),
  ready: el('screen-ready'),
  open: el('screen-open'),
  rescan: el('screen-rescan'),
  error: el('screen-error'),
};

const state = {
  config: null,
  rarity: makeRarityLookup([]),
  ticket: '',
  key: '',
  screen: 'main',
  spinning: false,
};

/* ------------------------------------------------------------------ utils */

function show(name) {
  for (const [key, node] of Object.entries(screens)) {
    node.classList.toggle('hidden', key !== name);
  }
}

let toastTimer;
function toast(message, isError = false) {
  const node = el('toast');
  node.textContent = message;
  node.classList.toggle('is-error', isError);
  node.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('is-visible'), 4200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    const error = new Error(data.error || `Request failed (${response.status})`);
    error.data = data;
    throw error;
  }
  return data;
}

function normalizeTicket(raw) {
  const cleaned = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return cleaned.length > 4 ? `${cleaned.slice(0, 4)}-${cleaned.slice(4, 8)}` : cleaned;
}

function isScreenMode() {
  return state.config?.settings.caseMode === 'screen';
}

/* ----------------------------------------------------------------- result */

function showResult(win, { celebrate = true } = {}) {
  const settings = state.config?.settings || {};
  const color = state.rarity.color(win.prize.rarity);
  const card = el('result-card');
  card.style.setProperty('--win-color', color);

  const badge = el('result-rarity');
  badge.textContent = state.rarity.label(win.prize.rarity);
  badge.className = `pill rarity-${win.prize.rarity}`;

  const art = el('result-art');
  art.style.setProperty('--win-color', color);
  if (win.prize.image) {
    const img = document.createElement('img');
    img.src = win.prize.image;
    img.alt = win.prize.name;
    art.replaceChildren(img);
  } else {
    const glyph = document.createElement('span');
    glyph.textContent = (win.prize.name || '?').slice(0, 1).toUpperCase();
    art.replaceChildren(glyph);
  }

  el('result-name').textContent = win.prize.name;
  el('result-subtitle').textContent = win.prize.subtitle || '';
  el('claim-code').textContent = win.claimCode;
  const handout = isScreenMode() && settings.autoCollect;
  el('claim-note').textContent = handout
    ? 'Grab your prize from the counter — this code is your receipt.'
    : settings.claimNote || '';

  show('open');
  el('result').classList.remove('hidden');
  if (celebrate) {
    if (['epic', 'legendary', 'rare'].includes(win.prize.rarity)) {
      confettiBurst(el('confetti'), color);
    }
    tick(1320);
  }
}

function showError(message) {
  el('error-message').textContent = message;
  show('error');
}

/* -------------------------------------------------------------- the open */

async function openCase() {
  if (state.spinning) return;
  state.spinning = true;
  el('case-button').disabled = true;

  try {
    const data = await api('/api/open', {
      method: 'POST',
      body: JSON.stringify({ ticket: state.ticket, screen: state.screen, key: state.key }),
    });

    show('open');
    el('reel').classList.remove('hidden');
    el('result').classList.add('hidden');
    el('open-hint').classList.toggle('hidden', !data.onScreen);
    // Let layout settle before animating, or the first frame jumps.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await spinReel(el('reel'), el('reel-track'), data.reel, data.winnerIndex, state.rarity);
    showResult(data.win);
  } catch (error) {
    handleOpenError(error);
  }
}

function handleOpenError(error) {
  state.spinning = false;
  el('case-button').disabled = false;
  const data = error.data || {};

  // Same scan, same phone: show what they already pulled.
  if ((data.code === 'already' || data.code === 'ticket_used') && data.win) {
    el('reel').classList.add('hidden');
    el('open-hint').classList.add('hidden');
    showResult(data.win, { celebrate: false });
    toast('This is your pull from this scan. Scan the QR again for a new one.');
    return;
  }
  if (data.code === 'rescan' || data.code === 'already') {
    show('rescan');
    return;
  }
  showError(error.message);
}

/* --------------------------------------------------------------- startup */

function renderShowcase(prizes) {
  const grid = el('showcase-grid');
  const showcase = el('showcase');
  if (!prizes.length) {
    showcase.classList.add('hidden');
    return;
  }
  showcase.classList.remove('hidden');
  grid.replaceChildren(
    ...prizes.map((prize) =>
      itemNode(prize, state.rarity, { withOdds: state.config.settings.showOdds }),
    ),
  );
}

function applyBranding(settings) {
  document.title = `${settings.storeName} — Open Your Case`;
  for (const node of document.querySelectorAll('[data-store-name]')) {
    node.textContent = settings.storeName;
  }
  el('ready-tagline').textContent = settings.tagline;
  el('closed-message').textContent = settings.closedMessage;
  document.querySelector('[data-case-name]').textContent = settings.caseName;
}

function readUrl() {
  const params = new URLSearchParams(location.search);
  state.ticket = normalizeTicket(params.get('c') || params.get('t') || params.get('ticket') || '');
  state.key = params.get('k') || '';
  state.screen = params.get('screen') || 'main';
}

function routeToStart() {
  const settings = state.config.settings;
  if (!settings.live) {
    show('closed');
    return;
  }
  if (settings.requireTicket && !state.ticket) {
    show('ticket');
    return;
  }
  if (isScreenMode()) {
    openCase();
    return;
  }
  show('ready');
}

async function boot() {
  try {
    state.config = await api('/api/case');
  } catch (error) {
    showError(error.message);
    return;
  }

  state.rarity = makeRarityLookup(state.config.rarities);
  applyBranding(state.config.settings);
  renderShowcase(state.config.prizes);
  readUrl();
  routeToStart();

  if (state.ticket) el('ticket-input').value = state.ticket;
}

el('case-button').addEventListener('click', openCase);

el('ticket-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const value = normalizeTicket(el('ticket-input').value);
  if (value.length < 9) {
    toast('Ticket codes look like XXXX-XXXX.', true);
    return;
  }
  state.ticket = value;
  if (isScreenMode()) openCase();
  else show('ready');
});

el('ticket-input').addEventListener('input', (event) => {
  event.target.value = normalizeTicket(event.target.value);
});

el('error-retry').addEventListener('click', () => {
  el('reel').classList.remove('hidden');
  state.spinning = false;
  el('case-button').disabled = false;
  routeToStart();
});

boot();
