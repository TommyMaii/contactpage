// Customer flow: unlock with a ticket, spin the reel, show the claim code.

const ITEM_WIDTH = 132;
const ITEM_GAP = 12;
const STEP = ITEM_WIDTH + ITEM_GAP;
const SPIN_MS = 6200;
const STORAGE_KEY = 'hatamon:lastWin';

const el = (id) => document.getElementById(id);
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const screens = {
  loading: el('screen-loading'),
  closed: el('screen-closed'),
  ticket: el('screen-ticket'),
  ready: el('screen-ready'),
  open: el('screen-open'),
  error: el('screen-error'),
};

const state = {
  config: null,
  ticket: '',
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

function rarityColor(rarity) {
  const found = (state.config?.rarities || []).find((r) => r.id === rarity);
  return found ? found.color : '#8ea3b8';
}

function rarityLabel(rarity) {
  const found = (state.config?.rarities || []).find((r) => r.id === rarity);
  return found ? found.label : rarity;
}

function normalizeTicket(raw) {
  const cleaned = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return cleaned.length > 4 ? `${cleaned.slice(0, 4)}-${cleaned.slice(4, 8)}` : cleaned;
}

/* ------------------------------------------------------------ item render */

function itemNode(prize, { withOdds = false } = {}) {
  const node = document.createElement('div');
  node.className = 'item';
  node.style.setProperty('--item-color', rarityColor(prize.rarity));

  const art = document.createElement('div');
  art.className = 'item__art';
  if (prize.image) {
    const img = document.createElement('img');
    img.src = prize.image;
    img.alt = '';
    img.loading = 'lazy';
    art.append(img);
  } else {
    art.classList.add('item__art--blank');
    art.textContent = (prize.name || '?').slice(0, 1).toUpperCase();
  }

  const name = document.createElement('div');
  name.className = 'item__name';
  name.textContent = prize.name;

  node.append(art, name);

  if (withOdds && typeof prize.odds === 'number') {
    const odds = document.createElement('div');
    odds.className = 'odds';
    odds.textContent = `${prize.odds}%`;
    node.append(odds);
  }
  return node;
}

/* ----------------------------------------------------------------- sounds */

let audioCtx;
function tick(pitch = 880) {
  if (!window.AudioContext && !window.webkitAudioContext) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.value = pitch;
    gain.gain.setValueAtTime(0.04, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.06);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.07);
  } catch {
    /* audio is a nicety, never a blocker */
  }
}

/* --------------------------------------------------------------- confetti */

function confettiBurst(color) {
  const canvas = el('confetti');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  ctx.scale(dpr, dpr);
  canvas.classList.remove('hidden');

  const colors = [color, '#ffffff', '#f5c542', '#4aa8ff'];
  const pieces = Array.from({ length: 130 }, () => ({
    x: window.innerWidth / 2 + (Math.random() - 0.5) * 160,
    y: window.innerHeight * 0.42,
    vx: (Math.random() - 0.5) * 12,
    vy: -Math.random() * 13 - 4,
    size: Math.random() * 7 + 4,
    spin: (Math.random() - 0.5) * 0.35,
    angle: Math.random() * Math.PI,
    color: colors[Math.floor(Math.random() * colors.length)],
  }));

  const started = performance.now();
  (function frame(now) {
    const elapsed = now - started;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    for (const p of pieces) {
      p.vy += 0.34;
      p.x += p.vx;
      p.y += p.vy;
      p.angle += p.spin;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = Math.max(0, 1 - elapsed / 2600);
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      ctx.restore();
    }
    if (elapsed < 2600) {
      requestAnimationFrame(frame);
    } else {
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      canvas.classList.add('hidden');
    }
  })(started);
}

/* -------------------------------------------------------------- the spin */

function renderReel(reel) {
  const track = el('reel-track');
  track.replaceChildren(...reel.map((prize) => itemNode(prize)));
  return track;
}

function spin(track, winnerIndex) {
  const reelWidth = el('reel').clientWidth;
  const jitter = (Math.random() - 0.5) * (ITEM_WIDTH * 0.62);
  const target = reelWidth / 2 - (winnerIndex * STEP + ITEM_WIDTH / 2) + jitter;
  const start = reelWidth / 2 - ITEM_WIDTH / 2;

  track.style.transform = `translateX(${start}px)`;

  if (reduceMotion) {
    track.style.transform = `translateX(${target}px)`;
    return Promise.resolve();
  }

  const animation = track.animate(
    [{ transform: `translateX(${start}px)` }, { transform: `translateX(${target}px)` }],
    { duration: SPIN_MS, easing: 'cubic-bezier(0.09, 0.72, 0.13, 1)', fill: 'forwards' },
  );

  // Click once per item that passes the marker, so the reel sounds like it slows.
  let lastIndex = -1;
  const markerX = el('reel').getBoundingClientRect().left + reelWidth / 2;
  (function watch() {
    const trackLeft = track.getBoundingClientRect().left;
    const index = Math.round((markerX - trackLeft - ITEM_WIDTH / 2) / STEP);
    if (index !== lastIndex) {
      if (lastIndex !== -1) tick(760 + Math.min(index, 40) * 6);
      lastIndex = index;
    }
    if (animation.playState === 'running') requestAnimationFrame(watch);
  })();

  return animation.finished.catch(() => {});
}

function showResult(win) {
  const color = rarityColor(win.prize.rarity);
  const card = el('result-card');
  card.style.setProperty('--win-color', color);

  const badge = el('result-rarity');
  badge.textContent = rarityLabel(win.prize.rarity);
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
  el('claim-note').textContent = state.config?.settings.claimNote || '';

  el('result').classList.remove('hidden');
  if (['epic', 'legendary', 'rare'].includes(win.prize.rarity)) confettiBurst(color);
  tick(1320);
}

async function openCase() {
  if (state.spinning) return;
  state.spinning = true;
  el('case-button').disabled = true;

  try {
    const data = await api('/api/open', {
      method: 'POST',
      body: JSON.stringify({ ticket: state.ticket }),
    });

    show('open');
    el('result').classList.add('hidden');
    const track = renderReel(data.reel);
    // Let layout settle before animating, or the first frame jumps.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await spin(track, data.winnerIndex);

    localStorage.setItem(STORAGE_KEY, data.win.id);
    showResult(data.win);
  } catch (error) {
    state.spinning = false;
    el('case-button').disabled = false;
    const already = error.data && error.data.code === 'ticket_used';
    if (already && error.data.win) {
      show('open');
      el('reel').classList.add('hidden');
      showResult(error.data.win);
      toast('That ticket was already opened — here is your pull.');
      return;
    }
    showError(error.message);
  }
}

function showError(message) {
  el('error-message').textContent = message;
  show('error');
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
    ...prizes.map((prize) => itemNode(prize, { withOdds: state.config.settings.showOdds })),
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

function ticketFromUrl() {
  const params = new URLSearchParams(location.search);
  return normalizeTicket(params.get('c') || params.get('t') || params.get('ticket') || '');
}

async function restoreLastWin() {
  const id = localStorage.getItem(STORAGE_KEY);
  if (!id) return false;
  try {
    const { win } = await api(`/api/win/${encodeURIComponent(id)}`);
    show('open');
    el('reel').classList.add('hidden');
    showResult(win);
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
  show('ready');
}

async function boot() {
  try {
    state.config = await api('/api/case');
  } catch (error) {
    showError(error.message);
    return;
  }

  applyBranding(state.config.settings);
  renderShowcase(state.config.prizes);
  state.ticket = ticketFromUrl();

  if (await restoreLastWin()) return;
  routeToStart();

  // A ticket in the QR link skips straight to the case.
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
  show('ready');
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
