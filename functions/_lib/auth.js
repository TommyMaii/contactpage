// Admin authentication: a shared password (Cloudflare secret) exchanged for an
// HMAC-signed session cookie. No user accounts — this guards one staff panel.

import { HttpError } from './http.js';

export const COOKIE_NAME = 'hatamon_session';
const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12h — one event day.

const encoder = new TextEncoder();

function b64url(bytes) {
  let bin = '';
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The signing key. SESSION_SECRET is preferred; without it we derive a key from
 * the admin password so a fresh deploy still works (changing the password then
 * invalidates every existing session, which is the behaviour you want anyway).
 */
async function signingKey(env) {
  const material = env.SESSION_SECRET || `derived:${adminPassword(env)}`;
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(material),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

export function adminPassword(env) {
  const password = env.ADMIN_PASSWORD;
  if (!password) {
    throw new HttpError(
      503,
      'ADMIN_PASSWORD is not configured. Set it as a secret on the Pages project.',
    );
  }
  return password;
}

/** Length-independent, timing-safe string comparison. */
export async function constantTimeEquals(a, b) {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(String(a))),
    crypto.subtle.digest('SHA-256', encoder.encode(String(b))),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

async function sign(env, payload) {
  const key = await signingKey(env);
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return b64url(mac);
}

export async function createSessionToken(env) {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = `v1.${expiresAt}`;
  return `${payload}.${await sign(env, payload)}`;
}

export async function isValidSessionToken(env, token) {
  if (typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;
  const expiresAt = Number(parts[1]);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now() / 1000) return false;
  const expected = await sign(env, `v1.${parts[1]}`);
  return constantTimeEquals(expected, parts[2]);
}

export function readCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function sessionCookie(token) {
  const attrs = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  return attrs.join('; ');
}

export function clearedCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** Throws 401 unless the request carries a valid admin session. */
export async function requireAdmin(request, env) {
  const token = readCookie(request, COOKIE_NAME);
  if (!(await isValidSessionToken(env, token))) {
    throw new HttpError(401, 'Please sign in.');
  }
}
