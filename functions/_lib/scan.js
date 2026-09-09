// One spin per scan. The display's QR embeds a key that rotates every
// WINDOW_MS; a key is HMAC-signed so it needs no storage, and each
// (key, phone) pair may open the case once. Refreshing the page re-sends the
// same key from the same phone and is refused; scanning again yields a new key.

import { signingKey } from './auth.js';

export const WINDOW_MS = 20_000;
// A printed sign has no rotating key; treat it as a key that changes every
// 10 minutes so a refresh cannot re-roll, but a later purchase can.
const SIGN_WINDOW_MS = 10 * 60_000;

const encoder = new TextEncoder();

function b64url(bytes) {
  let bin = '';
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sign(env, screen, window) {
  const key = await signingKey(env);
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`scan:${screen}:${window}`));
  return b64url(mac).slice(0, 12);
}

/** The key the display should show right now, plus when it rotates. */
export async function currentScanKey(env, screen, now = Date.now()) {
  const window = Math.floor(now / WINDOW_MS);
  return {
    key: `${window.toString(36)}.${await sign(env, screen, window)}`,
    rotatesIn: WINDOW_MS - (now % WINDOW_MS),
  };
}

/**
 * Validate a key from a phone. Accepts the current window and the previous
 * one, so someone who scanned right before a rotation is not turned away.
 * Returns the spin id to bind to the phone, or null if the key is stale/fake.
 */
export async function verifyScanKey(env, screen, raw, now = Date.now()) {
  if (typeof raw !== 'string') return null;
  const [windowText, sig] = raw.split('.');
  const window = parseInt(windowText, 36);
  if (!Number.isFinite(window) || !sig) return null;
  const current = Math.floor(now / WINDOW_MS);
  if (window !== current && window !== current - 1) return null;
  const expected = await sign(env, screen, window);
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0 ? `scan:${screen}:${window}` : null;
}

/** Spin id for an open without a key (printed sign or a typed-in URL). */
export function signSpinId(now = Date.now()) {
  return `sign:${Math.floor(now / SIGN_WINDOW_MS)}`;
}
