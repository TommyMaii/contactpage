// Shared between the phone page and the big-screen display: prize cards, the
// reel animation with ticks, confetti, and the rarity helpers.

export const ITEM_WIDTH = 132;
export const ITEM_GAP = 12;
export const STEP = ITEM_WIDTH + ITEM_GAP;
export const SPIN_MS = 6200;

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function makeRarityLookup(rarities) {
  const byId = new Map((rarities || []).map((r) => [r.id, r]));
  return {
    color: (id) => (byId.get(id) || {}).color || '#8ea3b8',
    label: (id) => (byId.get(id) || {}).label || id,
  };
}

/* --------------------------------------------------------------- cards */

export function itemNode(prize, rarity, { withOdds = false } = {}) {
  const node = document.createElement('div');
  node.className = 'item';
  node.style.setProperty('--item-color', rarity.color(prize.rarity));

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

/**
 * Build a reel strip client-side: `pool` filler with the winner at a fixed
 * index. Used by the display, which only receives the winner.
 */
export function buildReel(pool, winner, length = 56, winnerIndex = 48) {
  const filler = pool.length ? pool : [winner];
  const reel = [];
  for (let i = 0; i < length; i++) {
    reel.push(i === winnerIndex ? winner : filler[Math.floor(Math.random() * filler.length)]);
  }
  return { reel, winnerIndex };
}

/* --------------------------------------------------------------- sounds */

let audioCtx;
export function tick(pitch = 880, volume = 0.04) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  try {
    audioCtx = audioCtx || new Ctx();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.value = pitch;
    gain.gain.setValueAtTime(volume, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.06);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.07);
  } catch {
    /* audio is a nicety, never a blocker */
  }
}

/** Browsers only allow audio after a user gesture; call this from a click. */
export function unlockAudio() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  try {
    audioCtx = audioCtx || new Ctx();
    audioCtx.resume();
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------- confetti */

export function confettiBurst(canvas, color, count = 130) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  ctx.scale(dpr, dpr);
  canvas.classList.remove('hidden');

  const colors = [color, '#ffffff', '#f5c542', '#4aa8ff'];
  const pieces = Array.from({ length: count }, () => ({
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

/* ------------------------------------------------------------- the spin */

/**
 * Fill `track` (inside `reelEl`) with `reel` and scroll it so `winnerIndex`
 * lands under the centre marker. Resolves when the animation finishes.
 */
export function spinReel(reelEl, track, reel, winnerIndex, rarity) {
  track.replaceChildren(...reel.map((prize) => itemNode(prize, rarity)));

  const reelWidth = reelEl.clientWidth;
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
  const markerX = reelEl.getBoundingClientRect().left + reelWidth / 2;
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
