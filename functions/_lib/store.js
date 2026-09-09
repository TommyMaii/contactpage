// Everything that touches KV lives here, plus the prize roll itself.

import { HttpError } from './http.js';
import { newId, newWinId, newClaimCode, secureRandom } from './ids.js';

export const KEYS = {
  settings: 'settings',
  prizes: 'prizes',
  image: (id) => `img:${id}`,
  ticket: (code) => `ticket:${code}`,
  win: (id) => `win:${id}`,
  claim: (claimCode) => `claim:${claimCode}`,
  rate: (subject, bucket) => `rate:${subject}:${bucket}`,
  screen: (name) => `screen:${name}`,
};

export const RARITIES = [
  { id: 'common', label: 'Common', color: '#8ea3b8' },
  { id: 'uncommon', label: 'Uncommon', color: '#4fd18b' },
  { id: 'rare', label: 'Rare', color: '#4aa8ff' },
  { id: 'epic', label: 'Epic', color: '#c07bff' },
  { id: 'legendary', label: 'Legendary', color: '#ffc53d' },
];

const RARITY_IDS = new Set(RARITIES.map((r) => r.id));

export const DEFAULT_SETTINGS = {
  storeName: 'Hatamon',
  caseName: 'Event Case',
  tagline: 'Thanks for your purchase! Open your case and see what you pulled.',
  claimNote: 'Show this screen to a Hatamon staff member to collect your prize.',
  // 'screen': the reel plays on /display.html at the table and the phone just
  // says "watch the screen". 'phone': the reel plays on the customer's phone.
  caseMode: 'screen',
  // Screen mode: staff hand the prize over as soon as it shows on the
  // display, so pulls are marked collected automatically.
  autoCollect: true,
  requireTicket: false,
  showOdds: false,
  maxOpensPerHour: 1,
  live: true,
  closedMessage: 'The case is closed right now. Come find us at the table!',
};

export function db(env) {
  const kv = env.HATAMON;
  if (!kv) {
    throw new HttpError(
      503,
      'KV namespace "HATAMON" is not bound to this deployment. See README.md.',
    );
  }
  return kv;
}

/* ---------------------------------------------------------------- settings */

export async function getSettings(env) {
  const stored = await db(env).get(KEYS.settings, 'json');
  return { ...DEFAULT_SETTINGS, ...(stored || {}) };
}

export async function saveSettings(env, patch) {
  const current = await getSettings(env);
  const next = {
    ...current,
    storeName: str(patch.storeName, current.storeName, 40),
    caseName: str(patch.caseName, current.caseName, 40),
    tagline: str(patch.tagline, current.tagline, 200),
    claimNote: str(patch.claimNote, current.claimNote, 200),
    closedMessage: str(patch.closedMessage, current.closedMessage, 200),
    caseMode: patch.caseMode === 'phone' || patch.caseMode === 'screen' ? patch.caseMode : current.caseMode,
    autoCollect: bool(patch.autoCollect, current.autoCollect),
    requireTicket: bool(patch.requireTicket, current.requireTicket),
    showOdds: bool(patch.showOdds, current.showOdds),
    live: bool(patch.live, current.live),
    maxOpensPerHour: clamp(patch.maxOpensPerHour, current.maxOpensPerHour, 1, 100),
  };
  await db(env).put(KEYS.settings, JSON.stringify(next));
  return next;
}

/* ------------------------------------------------------------------ prizes */

export async function getPrizes(env) {
  const stored = await db(env).get(KEYS.prizes, 'json');
  return Array.isArray(stored) ? stored.map(normalizePrize) : [];
}

export async function savePrizes(env, list) {
  if (!Array.isArray(list)) throw new HttpError(400, 'Expected an array of prizes.');
  if (list.length > 200) throw new HttpError(400, 'That is a lot of prizes — cap is 200.');
  const cleaned = list.map(normalizePrize);
  await db(env).put(KEYS.prizes, JSON.stringify(cleaned));
  return cleaned;
}

function normalizePrize(raw = {}) {
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 32) : newId(),
    name: str(raw.name, 'Unnamed prize', 60),
    subtitle: str(raw.subtitle, '', 80),
    rarity: RARITY_IDS.has(raw.rarity) ? raw.rarity : 'common',
    imageId: typeof raw.imageId === 'string' ? raw.imageId.slice(0, 32) : '',
    weight: clamp(raw.weight, 1, 0, 1e6),
    // -1 means unlimited.
    stock: raw.stock === -1 || raw.stock === '-1' ? -1 : clamp(raw.stock, 0, 0, 1e6),
    active: bool(raw.active, true),
  };
}

/** Prizes that can actually come out of the case right now. */
export function drawablePrizes(prizes) {
  return prizes.filter(
    (p) => p.active && p.weight > 0 && (p.stock === -1 || p.stock > 0),
  );
}

export function oddsFor(prizes) {
  const pool = drawablePrizes(prizes);
  const total = pool.reduce((sum, p) => sum + p.weight, 0);
  const odds = new Map();
  for (const p of pool) odds.set(p.id, total > 0 ? p.weight / total : 0);
  return odds;
}

/** Weighted pick over the drawable pool, using the crypto RNG. */
export function rollPrize(prizes) {
  const pool = drawablePrizes(prizes);
  if (pool.length === 0) return null;
  const total = pool.reduce((sum, p) => sum + p.weight, 0);
  let target = secureRandom() * total;
  for (const prize of pool) {
    target -= prize.weight;
    if (target < 0) return prize;
  }
  return pool[pool.length - 1];
}

/**
 * Build the strip the client scrolls past. The winner sits at a fixed index so
 * the animation is identical every time; the filler is drawn from the same pool
 * so the reel looks honest.
 */
export function buildReel(prizes, winner, length = 56, winnerIndex = 48) {
  const pool = drawablePrizes(prizes);
  const reel = [];
  for (let i = 0; i < length; i++) {
    reel.push(i === winnerIndex ? winner : pool[Math.floor(secureRandom() * pool.length)]);
  }
  return { reel: reel.map((prize) => publicPrize(prize)), winnerIndex };
}

export function publicPrize(prize, odds) {
  const view = {
    id: prize.id,
    name: prize.name,
    subtitle: prize.subtitle,
    rarity: prize.rarity,
    image: prize.imageId ? `/api/img/${prize.imageId}` : null,
  };
  if (typeof odds === 'number') view.odds = Number((odds * 100).toFixed(2));
  return view;
}

/** Decrement stock for a finite prize. Best-effort: KV has no transactions. */
export async function consumeStock(env, prizeId) {
  const prizes = await getPrizes(env);
  const prize = prizes.find((p) => p.id === prizeId);
  if (!prize || prize.stock === -1) return prizes;
  prize.stock = Math.max(0, prize.stock - 1);
  await db(env).put(KEYS.prizes, JSON.stringify(prizes));
  return prizes;
}

/* ----------------------------------------------------------------- tickets */

export async function getTicket(env, code) {
  return db(env).get(KEYS.ticket(code), 'json');
}

export async function putTicket(env, ticket) {
  await db(env).put(KEYS.ticket(ticket.code), JSON.stringify(ticket));
  return ticket;
}

/* -------------------------------------------------------------------- wins */

export async function recordWin(env, { prize, ticketCode, source, collected = false }) {
  const createdAt = Date.now();
  const win = {
    id: newWinId(),
    claimCode: newClaimCode(),
    createdAt,
    prizeId: prize.id,
    prizeName: prize.name,
    prizeSubtitle: prize.subtitle || '',
    rarity: prize.rarity,
    imageId: prize.imageId || '',
    ticketCode: ticketCode || null,
    source: source || 'open',
    redeemed: collected,
    redeemedAt: collected ? createdAt : null,
  };
  await Promise.all([
    db(env).put(KEYS.win(win.id), JSON.stringify(win)),
    db(env).put(KEYS.claim(win.claimCode), win.id),
  ]);
  return win;
}

export async function getWinById(env, id) {
  if (!/^[a-z0-9]{20}$/.test(id || '')) return null;
  return db(env).get(KEYS.win(id), 'json');
}

export async function getWinByClaimCode(env, claimCode) {
  const id = await db(env).get(KEYS.claim(claimCode));
  if (!id) return null;
  return getWinById(env, id);
}

export async function updateWin(env, win) {
  await db(env).put(KEYS.win(win.id), JSON.stringify(win));
  return win;
}

/* ------------------------------------------------------------- big screen */

const SCREEN_QUEUE_MAX = 12;
const SCREEN_ENTRY_TTL_MS = 10 * 60 * 1000;

export function screenName(raw) {
  const name = String(raw || 'main').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24);
  return name || 'main';
}

/** Append a win to the screen's play queue (the display polls this key). */
export async function pushToScreen(env, name, entry) {
  const key = KEYS.screen(name);
  const now = Date.now();
  const current = (await db(env).get(key, 'json')) || [];
  const fresh = current.filter((e) => now - e.ts < SCREEN_ENTRY_TTL_MS);
  fresh.push({ ...entry, ts: now });
  await db(env).put(key, JSON.stringify(fresh.slice(-SCREEN_QUEUE_MAX)), {
    expirationTtl: 3600,
  });
}

export async function readScreen(env, name) {
  const now = Date.now();
  const entries = (await db(env).get(KEYS.screen(name), 'json')) || [];
  return entries.filter((e) => now - e.ts < SCREEN_ENTRY_TTL_MS);
}

/** List every key under a prefix, following KV's cursor. */
export async function listAll(env, prefix, limit = 1000) {
  const keys = [];
  let cursor;
  do {
    const page = await db(env).list({ prefix, cursor, limit: 1000 });
    keys.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor && keys.length < limit);
  return keys.slice(0, limit);
}

/* --------------------------------------------------------------- rate limit */

/** Count opens for `subject` (a device id or an IP) within the current hour. */
export async function checkRateLimit(env, subject, maxPerHour) {
  const bucket = Math.floor(Date.now() / 3_600_000);
  const key = KEYS.rate(subject, bucket);
  const used = Number((await db(env).get(key)) || 0);
  if (used >= maxPerHour) return false;
  await db(env).put(key, String(used + 1), { expirationTtl: 3600 });
  return true;
}

/* ----------------------------------------------------------------- coercion */

function str(value, fallback, max) {
  if (typeof value !== 'string') return fallback;
  return value.trim().slice(0, max);
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function clamp(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}
