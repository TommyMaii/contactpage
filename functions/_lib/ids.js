// ID / code generation. All randomness comes from the Web Crypto CSPRNG.

// Crockford-ish alphabet: no 0/O/1/I/L/U to keep hand-typed codes unambiguous.
const HUMAN_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function pick(alphabet, length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  // Reject-free mapping is not needed here: the modulo bias over a 30/36 char
  // alphabet is negligible for codes of this length and non-cryptographic use.
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

/** Opaque lowercase id for prizes, images, wins. */
export function newId(length = 12) {
  return pick(ID_ALPHABET, length);
}

/**
 * Win ids sort chronologically as strings (zero-padded ms timestamp + random
 * tail), so one KV key doubles as the listing index.
 */
export function newWinId() {
  return `${String(Date.now()).padStart(14, '0')}${pick(ID_ALPHABET, 6)}`;
}

/** Ticket code printed on a QR slip, e.g. "H7QF-3MTX". */
export function newTicketCode() {
  return `${pick(HUMAN_ALPHABET, 4)}-${pick(HUMAN_ALPHABET, 4)}`;
}

/** Short code the winner shows to staff at the table, e.g. "K4P9T2". */
export function newClaimCode() {
  return pick(HUMAN_ALPHABET, 6);
}

/** Normalise anything a customer types or a QR carries into canonical form. */
export function normalizeCode(raw) {
  if (typeof raw !== 'string') return '';
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cleaned.length !== 8) return cleaned;
  return `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`;
}

/** Uniform float in [0, 1) from the CSPRNG. */
export function secureRandom() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] / 2 ** 32;
}
