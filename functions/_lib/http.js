// Small helpers shared by every API route.

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

export function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status || 200,
    headers: { ...JSON_HEADERS, ...(init.headers || {}) },
  });
}

export function fail(status, message, extra = {}) {
  return json({ ok: false, error: message, ...extra }, { status });
}

/** Thrown by handlers to short-circuit with a clean client-facing message. */
export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function bad(message, extra) {
  return new HttpError(400, message, extra);
}

export async function readJson(request) {
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object') throw new Error('not an object');
    return body;
  } catch {
    throw bad('Expected a JSON body.');
  }
}

export function clientIp(request) {
  return (
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for') ||
    'unknown'
  );
}
