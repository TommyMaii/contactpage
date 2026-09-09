// Big-screen display. Polls the server for wins queued to this screen and
// plays them one after another: reel → result card → back to idle.

import { buildReel, confettiBurst, itemNode, makeRarityLookup, spinReel, tick, unlockAudio } from './reel.js';

const POLL_MS = 2000;
const RESULT_MS = 8000;
const RESULT_QUEUED_MS = 4000;
const REMEMBER = 60; // recent win ids we have already played

const el = (id) => document.getElementById(id);

const state = {
  config: null,
  rarity: makeRarityLookup([]),
  screen: new URLSearchParams(location.search).get('screen') || 'main',
  seen: [],
  queue: [],
  playing: false,
  muted: false,
  pollTimer: null,
  skip: null, // resolver that cuts the result hold short
  scanUrl: '', // rotating one-spin-per-scan link from the server
};

const views = {
  idle: el('d-idle'),
  closed: el('d-closed'),
  spin: el('d-spin'),
  result: el('d-result'),
};

function show(name) {
  for (const [key, node] of Object.entries(views)) node.classList.toggle('hidden', key !== name);
  // Keep a QR on screen whenever the big one is not visible.
  el('corner').classList.toggle('hidden', name === 'idle' || name === 'closed');
}

async function api(path) {
  const response = await fetch(path, { cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function caseUrl() {
  if (state.scanUrl) return state.scanUrl;
  const url = new URL('/', location.origin);
  if (state.screen !== 'main') url.searchParams.set('screen', state.screen);
  return url.toString();
}

function renderQr() {
  if (typeof qrcode !== 'function') return;
  const qr = qrcode(0, 'M');
  qr.addData(caseUrl());
  qr.make();
  const svg = qr.createSvgTag({ cellSize: 6, margin: 0, scalable: true });
  el('idle-qr').innerHTML = svg;
  el('corner-qr').innerHTML = svg;
}

/* ----------------------------------------------------------------- idle */

function renderIdle() {
  const { settings, prizes } = state.config;
  document.title = `${settings.storeName} — Display`;
  for (const node of document.querySelectorAll('[data-store-name]')) node.textContent = settings.storeName;
  document.querySelector('[data-case-name]').textContent = settings.caseName;
  el('idle-tagline').textContent = settings.tagline;
  el('closed-message').textContent = settings.closedMessage;
  el('status').classList.toggle('is-off', !settings.live);

  renderQr();

  el('idle-grid').replaceChildren(
    ...prizes.map((p) => itemNode(p, state.rarity, { withOdds: settings.showOdds })),
  );
}

async function refreshConfig() {
  // Throws on the first load (the gate shows the error); later refreshes only
  // log, so a blip never blanks a running display.
  try {
    state.config = await api('/api/case');
    state.rarity = makeRarityLookup(state.config.rarities);
    renderIdle();
  } catch (error) {
    if (!state.config) throw error;
    console.warn('config refresh failed', error);
  }
}

/* -------------------------------------------------------------- playback */

function updateQueueBadge() {
  const badge = el('queue');
  const n = state.queue.length;
  badge.classList.toggle('hidden', n === 0);
  badge.textContent = n === 1 ? '1 more waiting' : `${n} more waiting`;
}

function renderResult(win) {
  const color = state.rarity.color(win.prize.rarity);
  el('result-card').style.setProperty('--win-color', color);
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

  // Handing out at the screen: the prize is the headline, the code is a
  // small receipt. Otherwise the code is what they take to the counter.
  const handout = state.config.settings.autoCollect;
  el('claim-label').textContent = handout ? 'Grab it from the counter!' : 'Claim code';
  el('claim-code').classList.toggle('dresult__code--small', handout);
  el('claim-note').textContent = handout ? `Receipt code ${win.claimCode}` : state.config.settings.claimNote;
  if (handout) el('claim-code').textContent = '🎉';
  return color;
}

async function play(win) {
  state.playing = true;
  updateQueueBadge();

  // Pick up setting changes (hand-out mode, new prizes) made since last play.
  await refreshConfig();

  show('spin');
  const pool = state.config.prizes;
  const { reel, winnerIndex } = buildReel(pool, win.prize);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  await spinReel(el('reel'), el('reel-track'), reel, winnerIndex, state.rarity);

  const color = renderResult(win);
  show('result');
  if (!state.muted) tick(1320, 0.06);
  if (['epic', 'legendary', 'rare'].includes(win.prize.rarity)) {
    confettiBurst(el('confetti'), color, 220);
  }

  // Hold the result, counting down; shorter when someone is waiting, and
  // Space skips straight on.
  const counter = el('result-count');
  const hold = state.queue.length ? RESULT_QUEUED_MS : RESULT_MS;
  let skipped = false;
  const skipPromise = new Promise((resolve) => {
    state.skip = () => {
      skipped = true;
      resolve();
    };
  });
  for (let left = Math.ceil(hold / 1000); left > 0 && !skipped; left--) {
    counter.textContent = left;
    await Promise.race([new Promise((resolve) => setTimeout(resolve, 1000)), skipPromise]);
  }
  state.skip = null;

  state.playing = false;
  next();
}

function next() {
  if (state.playing) return;
  const win = state.queue.shift();
  updateQueueBadge();
  if (win) {
    play(win);
    return;
  }
  show(state.config.settings.live ? 'idle' : 'closed');
  // Prize stock may have changed; refresh the idle grid between plays.
  refreshConfig();
}

/* ---------------------------------------------------------------- polling */

async function poll() {
  if (document.hidden) return;
  try {
    const { entries, scanUrl } = await api(`/api/display?screen=${encodeURIComponent(state.screen)}`);
    if (scanUrl && scanUrl !== state.scanUrl) {
      state.scanUrl = scanUrl;
      renderQr();
    }
    for (const entry of entries) {
      const win = entry.win;
      if (!win || state.seen.includes(win.id)) continue;
      state.seen.push(win.id);
      if (state.seen.length > REMEMBER) state.seen.shift();
      state.queue.push(win);
    }
    updateQueueBadge();
    if (!state.playing && state.queue.length) next();
  } catch (error) {
    console.warn('poll failed', error);
  }
}

function startPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(poll, POLL_MS);
  poll();
}

/* ------------------------------------------------------------------ boot */

async function keepAwake() {
  try {
    if ('wakeLock' in navigator) {
      let lock = await navigator.wakeLock.request('screen');
      document.addEventListener('visibilitychange', async () => {
        if (!document.hidden && lock.released) lock = await navigator.wakeLock.request('screen');
      });
    }
  } catch {
    /* not supported or denied; harmless */
  }
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}

el('gate-start').addEventListener('click', async () => {
  unlockAudio();
  const button = el('gate-start');
  const errorBox = el('gate-error');
  button.disabled = true;
  errorBox.classList.add('hidden');
  try {
    await refreshConfig();
  } catch (error) {
    errorBox.textContent = `Can't load the case: ${error.message}`;
    errorBox.classList.remove('hidden');
    button.disabled = false;
    return;
  }
  el('gate').remove();
  // Anything already queued before the display was opened is history, not a
  // show to replay: mark it seen so only new scans play.
  try {
    const { entries, scanUrl } = await api(`/api/display?screen=${encodeURIComponent(state.screen)}`);
    state.seen = entries.map((e) => e.win && e.win.id).filter(Boolean);
    if (scanUrl) {
      state.scanUrl = scanUrl;
      renderQr();
    }
  } catch {
    /* fine */
  }
  show(state.config.settings.live ? 'idle' : 'closed');
  keepAwake();
  startPolling();
});

el('btn-full').addEventListener('click', toggleFullscreen);
el('btn-next').addEventListener('click', () => {
  if (state.skip) state.skip();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'f' || event.key === 'F') toggleFullscreen();
  if ((event.key === ' ' || event.key === 'ArrowRight' || event.key === 'Enter') && state.skip) {
    event.preventDefault();
    state.skip();
  }
  if (event.key === 'm' || event.key === 'M') {
    state.muted = !state.muted;
    el('status').textContent = state.muted ? 'Muted' : 'Live';
    el('status').prepend(Object.assign(document.createElement('span'), { className: 'dot' }));
  }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) poll();
});

// Re-check settings (live switch, new prizes) every minute while idle.
setInterval(() => {
  if (!state.playing && !document.hidden) refreshConfig();
}, 60000);
