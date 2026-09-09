// Customer flow. Two modes, chosen by staff in the admin panel:
//  - 'screen': scanning auto-opens the case on the shop's display; this page
//    says "watch the screen" and reveals the claim code once the reel is done.
//  - 'phone':  the reel plays right here after a tap.

import {
  SPIN_MS,
  buildReel,
  confettiBurst,
  itemNode,
  makeRarityLookup,
  spinReel,
  tick,
} from './reel.js';

const STORAGE_KEY = 'hatamon:lastWin';
const WATCH_REVEAL_MS = SPIN_MS + 2500;

const el = (id) => document.getElementById(id);

const screens = {
  loading: el('screen-loading'),
  closed: el('screen-closed'),
  ticket: el('screen-ticket'),
  ready: el('screen-ready'),
  open: el('screen-open'),
  watch: el('screen-watch'),
  error: el('screen-error'),
};

const state = {
  config: null,
  rarity: makeRarityLookup([]),
  ticket: '',
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
  toastTimer = setTimeout(() => node.classList.remove('is-visible'), 3600);
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
  const handout = state.config?.settings.caseMode === 'screen' && state.config?.settings.autoCollect;
  el('claim-note').textContent = handout
    ? 'Grab your prize from the counter — this code is your receipt.'
    : state.config?.settings.claimNote || '';

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

/* ------------------------------------------------------------- open flows */

async function requestOpen() {
  return api('/api/open', {
    method: 'POST',
    body: JSON.stringify({ ticket: state.ticket, screen: state.screen }),
  });
}

function handleOpenError(error) {
  state.spinning = false;
  el('case-button').disabled = false;
  const already = error.data && error.data.code === 'ticket_used';
  if (already && error.data.win) {
    el('reel').classList.add('hidden');
    showResult(error.data.win, { celebrate: false });
    toast('That ticket was already opened — here is your pull.');
    return;
  }
  showError(error.message);
}

/** Phone mode: tap, spin here, reveal. */
async function openOnPhone() {
  if (state.spinning) return;
  state.spinning = true;
  el('case-button').disabled = true;

  try {
    const data = await requestOpen();
    localStorage.setItem(STORAGE_KEY, data.win.id);

    show('open');
    el('reel').classList.remove('hidden');
    el('result').classList.add('hidden');
    // Let layout settle before animating, or the first frame jumps.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await spinReel(el('reel'), el('reel-track'), data.reel, data.winnerIndex, state.rarity);
    showResult(data.win);
  } catch (error) {
    handleOpenError(error);
  }
}

/** Screen mode: open immediately, point at the display, reveal later. */
async function openOnScreen() {
  if (state.spinning) return;
  state.spinning = true;
  show('watch');

  try {
    const data = await requestOpen();
    localStorage.setItem(STORAGE_KEY, data.win.id);

    // Give the display time to play the reel before spoiling it on the phone.
    const seconds = Math.ceil(WATCH_REVEAL_MS / 1000);
    const counter = el('watch-count');
    let left = seconds;
    counter.textContent = left;
    const timer = setInterval(() => {
      left -= 1;
      counter.textContent = Math.max(0, left);
      if (left <= 0) clearInterval(timer);
    }, 1000);

    await new Promise((resolve) => setTimeout(resolve, WATCH_REVEAL_MS));
    el('reel').classList.add('hidden');
    showResult(data.win, { celebrate: false });
  } catch (error) {
    handleOpenError(error);
  }
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
  state.screen = params.get('screen') || 'main';
}

async function restoreLastWin() {
  const id = localStorage.getItem(STORAGE_KEY);
  if (!id) return false;
  try {
    const { win } = await api(`/api/win/${encodeURIComponent(id)}`);
    el('reel').classList.add('hidden');
    showResult(win, { celebrate: false });
    return true;
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return false;
  }
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
    openOnScreen();
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

  // Without limits every scan is a fresh pull, so never replay an old one.
  if (state.config.settings.limitOpens && (await restoreLastWin())) return;
  routeToStart();

  if (state.ticket) el('ticket-input').value = state.ticket;
}

el('case-button').addEventListener('click', openOnPhone);

el('ticket-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const value = normalizeTicket(el('ticket-input').value);
  if (value.length < 9) {
    toast('Ticket codes look like XXXX-XXXX.', true);
    return;
  }
  state.ticket = value;
  if (isScreenMode()) openOnScreen();
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

// Unused import guard: buildReel is used by the display, kept here so the
// shared module tree-shakes identically in both pages.
void buildReel;

boot();
