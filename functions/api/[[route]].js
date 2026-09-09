// Single entry point for /api/*. Pages Functions hands us the path segments in
// context.params.route.

import { json, fail, HttpError, readJson, clientIp } from '../_lib/http.js';
import {
  adminPassword,
  clearedCookie,
  constantTimeEquals,
  createSessionToken,
  requireAdmin,
  sessionCookie,
} from '../_lib/auth.js';
import { newId, newTicketCode, normalizeCode } from '../_lib/ids.js';
import { readCookie } from '../_lib/auth.js';
import { WINDOW_MS, currentScanKey, signSpinId, verifyScanKey } from '../_lib/scan.js';
import {
  DEFAULT_SETTINGS,
  KEYS,
  RARITIES,
  buildReel,
  bumpRollCount,
  checkRateLimit,
  consumeStock,
  db,
  displayOdds,
  drawablePrizes,
  getRollCount,
  getSpin,
  getPrizes,
  getSettings,
  getTicket,
  getWinByClaimCode,
  getWinById,
  listAll,
  markSpin,
  oddsFor,
  publicPrize,
  pushToScreen,
  putTicket,
  readScreen,
  recordWin,
  rollPrize,
  savePrizes,
  saveSettings,
  screenName,
  updateWin,
  visiblePrizes,
} from '../_lib/store.js';

const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

// A long-lived cookie identifies the phone: together with the scan key it makes
// each scan good for exactly one spin. Event venues share one IP across every
// phone on the WiFi, so the optional IP limit only counts *new* devices
// (someone clearing cookies to re-roll), never normal opens.
const DEVICE_COOKIE = 'hatamon_device';
const NEW_DEVICES_PER_IP_PER_HOUR = 30;

function deviceFrom(request) {
  const existing = readCookie(request, DEVICE_COOKIE);
  if (existing && /^[a-z0-9]{16}$/.test(existing)) return { deviceId: existing, isNew: false };
  return { deviceId: newId(16), isNew: true };
}

function deviceCookie(deviceId) {
  return `${DEVICE_COOKIE}=${deviceId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`;
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const segments = Array.isArray(params.route) ? params.route : [params.route].filter(Boolean);
  const path = segments.join('/');
  const method = request.method.toUpperCase();

  try {
    const response = await route(path, method, context, env, request);
    if (response) return response;
    return fail(404, `No API route for /${path}`);
  } catch (error) {
    if (error instanceof HttpError) {
      return fail(error.status, error.message, error.extra);
    }
    console.error('api error', path, error);
    return fail(500, 'Something broke on our side. Try again.');
  }
}

async function route(path, method, context, env, request) {
  /* -------------------------------------------------------------- public */

  if (path === 'case' && method === 'GET') return handleCase(env);
  if (path === 'open' && method === 'POST') return handleOpen(env, request);
  if (path === 'display' && method === 'GET') return handleDisplay(env, request);

  if (path.startsWith('img/') && method === 'GET') {
    return handleImage(env, path.slice(4));
  }

  if (path.startsWith('win/') && method === 'GET') {
    return handleWinLookup(env, path.slice(4));
  }

  /* --------------------------------------------------------------- admin */

  if (path === 'admin/login' && method === 'POST') return handleLogin(env, request);
  if (path === 'admin/logout' && method === 'POST') {
    return json({ ok: true }, { headers: { 'set-cookie': clearedCookie() } });
  }

  if (!path.startsWith('admin/')) return null;

  await requireAdmin(request, env);

  const admin = path.slice(6);
  if (admin === 'state' && method === 'GET') return handleState(env);
  if (admin === 'settings' && method === 'PUT') return handleSaveSettings(env, request);
  if (admin === 'prizes' && method === 'PUT') return handleSavePrizes(env, request);
  if (admin === 'upload' && method === 'POST') return handleUpload(env, request);
  if (admin === 'tickets' && method === 'GET') return handleListTickets(env);
  if (admin === 'tickets' && method === 'POST') return handleCreateTickets(env, request);
  if (admin === 'tickets/void' && method === 'POST') return handleVoidTicket(env, request);
  if (admin === 'wins' && method === 'GET') return handleListWins(env);
  if (admin === 'wins.csv' && method === 'GET') return handleWinsCsv(env);
  if (admin === 'wins/redeem' && method === 'POST') return handleRedeem(env, request);
  if (admin === 'purge' && method === 'POST') return handlePurge(env, request);

  return null;
}

/* ============================================================== customer == */

async function handleCase(env) {
  const [settings, prizes] = await Promise.all([getSettings(env), getPrizes(env)]);
  const odds = displayOdds(prizes);
  const pool = visiblePrizes(prizes);
  return json({
    ok: true,
    settings: {
      storeName: settings.storeName,
      caseName: settings.caseName,
      tagline: settings.tagline,
      claimNote: settings.claimNote,
      caseMode: settings.caseMode,
      autoCollect: settings.autoCollect,
      limitOpens: settings.limitOpens,
      requireTicket: settings.requireTicket,
      showOdds: settings.showOdds,
      live: settings.live,
      closedMessage: settings.closedMessage,
    },
    rarities: RARITIES,
    prizes: pool.map((p) => publicPrize(p, settings.showOdds ? odds.get(p.id) : undefined)),
  });
}

async function handleOpen(env, request) {
  const body = await readJson(request).catch(() => ({}));
  const settings = await getSettings(env);

  if (!settings.live) {
    throw new HttpError(403, settings.closedMessage, { code: 'closed' });
  }

  const [prizes, rolls] = await Promise.all([getPrizes(env), getRollCount(env)]);
  if (drawablePrizes(prizes, rolls).length === 0) {
    throw new HttpError(409, 'No prizes are stocked right now. Grab a staff member.', {
      code: 'empty',
    });
  }

  let ticket = null;
  if (settings.requireTicket) {
    const code = normalizeCode(body.ticket);
    if (!code) {
      throw new HttpError(400, 'This case needs a ticket code from your receipt slip.', {
        code: 'ticket_required',
      });
    }
    ticket = await getTicket(env, code);
    if (!ticket) {
      throw new HttpError(404, 'That ticket code is not valid.', { code: 'ticket_invalid' });
    }
    if (ticket.voidedAt) {
      throw new HttpError(410, 'That ticket was cancelled.', { code: 'ticket_void' });
    }
    if (ticket.usedAt) {
      const previous = ticket.winId ? await getWinById(env, ticket.winId) : null;
      throw new HttpError(409, 'That ticket has already been opened.', {
        code: 'ticket_used',
        win: previous ? winView(previous) : null,
      });
    }
    // Burn the ticket before rolling so a double-tap cannot open twice.
    ticket.usedAt = Date.now();
    await putTicket(env, ticket);
  }

  const { deviceId, isNew } = deviceFrom(request);
  const setCookie = isNew ? deviceCookie(deviceId) : null;
  const screen = screenName(body.screen);

  // Which "scan" is this? A key from the display's QR, or the printed sign.
  let spinId = null;
  if (!ticket) {
    if (body.key) {
      spinId = await verifyScanKey(env, screen, body.key);
      if (!spinId) {
        throw new HttpError(410, 'That QR code has expired. Scan it again for a new pull.', {
          code: 'rescan',
        });
      }
    } else {
      spinId = signSpinId();
    }
    const previousId = await getSpin(env, spinId, deviceId);
    if (previousId) {
      const previous = await getWinById(env, previousId);
      throw new HttpError(409, 'This scan was already used. Scan the QR again for a new pull.', {
        code: 'already',
        win: previous ? winView(previous) : null,
      });
    }
  }

  if (!ticket && settings.limitOpens) {
    if (isNew) {
      const ipOk = await checkRateLimit(env, `ip:${clientIp(request)}`, NEW_DEVICES_PER_IP_PER_HOUR);
      if (!ipOk) {
        throw new HttpError(429, 'Too many opens from this network right now. Come see us at the table!', {
          code: 'rate_limited',
        });
      }
    }
    const deviceOk = await checkRateLimit(env, `dev:${deviceId}`, settings.maxOpensPerHour);
    if (!deviceOk) {
      throw new HttpError(429, 'This phone has already opened its case. Come see us at the table!', {
        code: 'rate_limited',
      });
    }
  }

  const onScreen = settings.caseMode === 'screen';
  const winner = rollPrize(prizes, rolls);
  const win = await recordWin(env, {
    prize: winner,
    ticketCode: ticket ? ticket.code : null,
    source: ticket ? 'ticket' : 'open',
    collected: onScreen && settings.autoCollect,
  });

  if (ticket) {
    ticket.winId = win.id;
    ticket.claimCode = win.claimCode;
    await putTicket(env, ticket);
  }

  await Promise.all([
    consumeStock(env, winner.id),
    bumpRollCount(env),
    spinId ? markSpin(env, spinId, deviceId, win.id) : Promise.resolve(),
    onScreen ? pushToScreen(env, screen, { win: winView(win) }) : Promise.resolve(),
  ]);

  // The phone always spins its own reel; in screen mode the display spins too.
  const { reel, winnerIndex } = buildReel(prizes, winner);
  return json(
    { ok: true, onScreen, reel, winnerIndex, win: winView(win) },
    setCookie ? { headers: { 'set-cookie': setCookie } } : {},
  );
}

/** Polled by /display.html: queued wins plus the QR key to show right now. */
async function handleDisplay(env, request) {
  const url = new URL(request.url);
  const name = screenName(url.searchParams.get('screen'));
  const [entries, scan] = await Promise.all([readScreen(env, name), currentScanKey(env, name)]);
  const scanUrl = new URL('/', url.origin);
  scanUrl.searchParams.set('k', scan.key);
  if (name !== 'main') scanUrl.searchParams.set('screen', name);
  return json({
    ok: true,
    screen: name,
    entries,
    scanUrl: scanUrl.toString(),
    rotatesIn: scan.rotatesIn,
    windowMs: WINDOW_MS,
  });
}

async function handleImage(env, id) {
  if (!id) return fail(404, 'Missing image id.');
  const result = await db(env).getWithMetadata(KEYS.image(id), { type: 'arrayBuffer' });
  if (!result || !result.value) return fail(404, 'Image not found.');
  return new Response(result.value, {
    headers: {
      'content-type': (result.metadata && result.metadata.contentType) || 'image/jpeg',
      // Image ids are unique per upload, so this can cache hard.
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
}

async function handleWinLookup(env, id) {
  const win = (await getWinById(env, id)) || (await getWinByClaimCode(env, normalizeCode(id)));
  if (!win) return fail(404, 'We could not find that pull.');
  return json({ ok: true, win: winView(win) });
}

function winView(win) {
  return {
    id: win.id,
    claimCode: win.claimCode,
    createdAt: win.createdAt,
    redeemed: win.redeemed,
    prize: {
      id: win.prizeId,
      name: win.prizeName,
      subtitle: win.prizeSubtitle || '',
      rarity: win.rarity,
      image: win.imageId ? `/api/img/${win.imageId}` : null,
    },
  };
}

/* ================================================================= admin == */

async function handleLogin(env, request) {
  const { password } = await readJson(request);
  const matches = await constantTimeEquals(password || '', adminPassword(env));
  if (!matches) {
    // Slow brute force from a phone/browser without a persistent counter.
    await new Promise((resolve) => setTimeout(resolve, 600));
    throw new HttpError(401, 'Wrong password.');
  }
  const token = await createSessionToken(env);
  return json({ ok: true }, { headers: { 'set-cookie': sessionCookie(token) } });
}

async function handleState(env) {
  const [settings, prizes, rolls, winKeys, ticketKeys] = await Promise.all([
    getSettings(env),
    getPrizes(env),
    getRollCount(env),
    listAll(env, 'win:'),
    listAll(env, 'ticket:'),
  ]);
  const odds = oddsFor(prizes, rolls);
  return json({
    ok: true,
    settings,
    defaults: DEFAULT_SETTINGS,
    rarities: RARITIES,
    prizes: prizes.map((p) => ({ ...p, odds: Number(((odds.get(p.id) || 0) * 100).toFixed(2)) })),
    stats: { wins: winKeys.length, tickets: ticketKeys.length, rolls },
  });
}

async function handleSaveSettings(env, request) {
  const body = await readJson(request);
  return json({ ok: true, settings: await saveSettings(env, body) });
}

async function handleSavePrizes(env, request) {
  const body = await readJson(request);
  const [prizes, rolls] = await Promise.all([savePrizes(env, body.prizes), getRollCount(env)]);
  const odds = oddsFor(prizes, rolls);
  return json({
    ok: true,
    rolls,
    prizes: prizes.map((p) => ({ ...p, odds: Number(((odds.get(p.id) || 0) * 100).toFixed(2)) })),
  });
}

async function handleUpload(env, request) {
  const form = await request.formData().catch(() => null);
  const file = form && form.get('file');
  if (!file || typeof file === 'string') {
    throw new HttpError(400, 'Attach an image as the "file" field.');
  }
  const contentType = file.type || 'image/jpeg';
  if (!contentType.startsWith('image/')) {
    throw new HttpError(415, 'That file is not an image.');
  }
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new HttpError(413, 'Image is over 3 MB — try a smaller one.');
  }
  const id = newId(16);
  await db(env).put(KEYS.image(id), bytes, {
    metadata: { contentType, size: bytes.byteLength, uploadedAt: Date.now() },
  });
  return json({ ok: true, imageId: id, url: `/api/img/${id}` });
}

async function handleListTickets(env) {
  const keys = await listAll(env, 'ticket:');
  const tickets = await Promise.all(keys.map((key) => db(env).get(key, 'json')));
  const rows = tickets.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
  return json({
    ok: true,
    tickets: rows,
    summary: {
      total: rows.length,
      unused: rows.filter((t) => !t.usedAt && !t.voidedAt).length,
      used: rows.filter((t) => t.usedAt).length,
    },
  });
}

async function handleCreateTickets(env, request) {
  const body = await readJson(request);
  const count = Math.min(200, Math.max(1, Math.round(Number(body.count) || 0) || 1));
  const batch = typeof body.batch === 'string' ? body.batch.trim().slice(0, 40) : '';
  const created = [];
  for (let i = 0; i < count; i++) {
    const ticket = {
      code: newTicketCode(),
      batch,
      createdAt: Date.now(),
      usedAt: null,
      voidedAt: null,
      winId: null,
      claimCode: null,
    };
    await putTicket(env, ticket);
    created.push(ticket);
  }
  return json({ ok: true, tickets: created });
}

async function handleVoidTicket(env, request) {
  const body = await readJson(request);
  const code = normalizeCode(body.code);
  const ticket = await getTicket(env, code);
  if (!ticket) throw new HttpError(404, 'No such ticket.');
  ticket.voidedAt = ticket.voidedAt ? null : Date.now();
  await putTicket(env, ticket);
  return json({ ok: true, ticket });
}

async function loadWins(env) {
  const keys = await listAll(env, 'win:');
  const wins = await Promise.all(keys.map((key) => db(env).get(key, 'json')));
  return wins.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
}

async function handleListWins(env) {
  const wins = await loadWins(env);
  return json({
    ok: true,
    wins,
    summary: {
      total: wins.length,
      pending: wins.filter((w) => !w.redeemed).length,
    },
  });
}

async function handleWinsCsv(env) {
  const wins = await loadWins(env);
  const header = 'time,prize,rarity,claim_code,ticket_code,redeemed';
  const rows = wins.map((w) =>
    [
      new Date(w.createdAt).toISOString(),
      w.prizeName,
      w.rarity,
      w.claimCode,
      w.ticketCode || '',
      w.redeemed ? 'yes' : 'no',
    ]
      .map(csvCell)
      .join(','),
  );
  return new Response([header, ...rows].join('\n'), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="hatamon-pulls-${new Date()
        .toISOString()
        .slice(0, 10)}.csv"`,
    },
  });
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function handleRedeem(env, request) {
  const body = await readJson(request);
  const win = body.claimCode
    ? await getWinByClaimCode(env, String(body.claimCode).toUpperCase().replace(/[^A-Z0-9]/g, ''))
    : await getWinById(env, String(body.id || ''));
  if (!win) throw new HttpError(404, 'No pull matches that code.');
  win.redeemed = body.redeemed === false ? false : true;
  win.redeemedAt = win.redeemed ? Date.now() : null;
  await updateWin(env, win);
  return json({ ok: true, win });
}

async function handlePurge(env, request) {
  const body = await readJson(request);
  const targets = {
    wins: ['win:', 'claim:', 'screen:', 'counter:', 'spin:'],
    tickets: ['ticket:'],
  };
  const prefixes = targets[body.what];
  if (!prefixes) throw new HttpError(400, 'Pass what: "wins" or "tickets".');
  let deleted = 0;
  for (const prefix of prefixes) {
    const keys = await listAll(env, prefix, 10000);
    for (const key of keys) {
      await db(env).delete(key);
      deleted++;
    }
  }
  return json({ ok: true, deleted });
}
