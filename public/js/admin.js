// Staff panel: prizes + odds, ticket printing, redeeming pulls, settings.

const el = (id) => document.getElementById(id);
const MAX_IMAGE_EDGE = 900;

const state = {
  rarities: [],
  settings: null,
  prizes: [],
  draft: [],
  dirty: false,
  tickets: [],
  wins: [],
};

/* ------------------------------------------------------------------ utils */

let toastTimer;
function toast(message, isError = false) {
  const node = el('toast');
  node.textContent = message;
  node.classList.toggle('is-error', isError);
  node.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('is-visible'), 3200);
}

async function api(path, options = {}) {
  const isForm = options.body instanceof FormData;
  const response = await fetch(path, {
    ...options,
    headers: isForm ? options.headers : { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    showLogin();
    throw new Error(data.error || 'Signed out.');
  }
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return data;
}

function rarityColor(id) {
  const found = state.rarities.find((r) => r.id === id);
  return found ? found.color : '#8ea3b8';
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'style') node.style.cssText = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== null && value !== undefined) node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/* ----------------------------------------------------------------- login */

function showLogin() {
  el('login').classList.remove('hidden');
  el('admin').classList.remove('is-ready');
}

el('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.target.querySelector('button');
  button.disabled = true;
  try {
    await api('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ password: el('login-password').value }),
    });
    el('login-password').value = '';
    await boot();
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
});

el('logout').addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

/* ------------------------------------------------------------------ tabs */

el('tabs').addEventListener('click', (event) => {
  const tab = event.target.closest('.tab');
  if (!tab) return;
  for (const node of document.querySelectorAll('.tab')) node.classList.toggle('is-active', node === tab);
  for (const view of document.querySelectorAll('.view')) {
    view.classList.toggle('is-active', view.dataset.view === tab.dataset.tab);
  }
  if (tab.dataset.tab === 'tickets') loadTickets();
  if (tab.dataset.tab === 'pulls') loadWins();
  if (tab.dataset.tab === 'qr') renderSign();
});

/* ---------------------------------------------------------------- prizes */

function isLocked(prize) {
  return (prize.unlockAfter || 0) > (state.stats?.rolls || 0);
}

function computeOdds(list) {
  const pool = list.filter(
    (p) => p.active && p.weight > 0 && (p.stock === -1 || p.stock > 0) && !isLocked(p),
  );
  const total = pool.reduce((sum, p) => sum + p.weight, 0);
  const odds = new Map();
  for (const p of pool) odds.set(p.id, total ? (p.weight / total) * 100 : 0);
  return odds;
}

function markDirty(dirty = true) {
  state.dirty = dirty;
  el('savebar').classList.toggle('is-dirty', dirty);
  el('save-status').textContent = dirty ? 'Unsaved changes' : 'All changes saved';
}

function newPrize() {
  return {
    id: `new-${Math.random().toString(36).slice(2, 10)}`,
    name: '',
    subtitle: '',
    rarity: 'common',
    imageId: '',
    weight: 10,
    stock: -1,
    unlockAfter: 0,
    active: true,
  };
}

function renderRollStat() {
  const node = el('rolls-stat');
  if (!node) return;
  const rolls = state.stats?.rolls || 0;
  node.textContent = `${rolls} pull${rolls === 1 ? '' : 's'} so far`;
}

function renderPrizes() {
  const list = el('prize-list');
  const odds = computeOdds(state.draft);
  renderRollStat();
  el('prize-empty').classList.toggle('hidden', state.draft.length > 0);

  list.replaceChildren(
    ...state.draft.map((prize, index) => {
      const drop = h(
        'label',
        { class: 'prize__drop', title: 'Click or drop an image' },
        prize.imageId
          ? h('img', { src: `/api/img/${prize.imageId}`, alt: '' })
          : h('span', {}, 'Drop image\nor click'),
        h('input', {
          type: 'file',
          accept: 'image/*',
          onchange: (event) => uploadImage(event.target.files[0], index, drop),
        }),
      );
      drop.addEventListener('dragover', (event) => {
        event.preventDefault();
        drop.classList.add('is-hot');
      });
      drop.addEventListener('dragleave', () => drop.classList.remove('is-hot'));
      drop.addEventListener('drop', (event) => {
        event.preventDefault();
        drop.classList.remove('is-hot');
        uploadImage(event.dataTransfer.files[0], index, drop);
      });

      const bind = (key, transform = (v) => v) => (event) => {
        state.draft[index][key] = transform(event.target.value);
        refreshOdds();
        markDirty();
      };

      const unlimited = prize.stock === -1;

      return h(
        'div',
        { class: `prize${prize.active ? '' : ' is-off'}`, style: `--item-color:${rarityColor(prize.rarity)}` },
        drop,
        h(
          'div',
          { class: 'prize__grid' },
          h(
            'label',
            { class: 'field', style: 'margin:0' },
            h('span', { class: 'field__label' }, 'Name'),
            h('input', { class: 'input', value: prize.name, placeholder: 'e.g. Booster pack', maxlength: 60, oninput: bind('name') }),
          ),
          h(
            'label',
            { class: 'field', style: 'margin:0' },
            h('span', { class: 'field__label' }, 'Rarity'),
            h(
              'select',
              {
                class: 'select',
                onchange: (event) => {
                  state.draft[index].rarity = event.target.value;
                  markDirty();
                  renderPrizes();
                },
              },
              ...state.rarities.map((r) =>
                h('option', { value: r.id, selected: r.id === prize.rarity ? '' : null }, r.label),
              ),
            ),
          ),
          h(
            'label',
            { class: 'field', style: 'margin:0' },
            h('span', { class: 'field__label' }, 'Weight'),
            h('input', { class: 'input', type: 'number', min: 0, step: 1, value: prize.weight, oninput: bind('weight', (v) => Math.max(0, Number(v) || 0)) }),
          ),
          h(
            'label',
            { class: 'field', style: 'margin:0' },
            h('span', { class: 'field__label' }, 'Stock'),
            h('input', {
              class: 'input',
              type: 'number',
              min: 0,
              step: 1,
              value: unlimited ? '' : prize.stock,
              placeholder: '∞',
              disabled: unlimited ? '' : null,
              oninput: bind('stock', (v) => Math.max(0, Number(v) || 0)),
            }),
          ),
          h(
            'label',
            { class: 'field', style: 'margin:0' },
            h('span', { class: 'field__label' }, 'Unlock after'),
            h('input', {
              class: 'input',
              type: 'number',
              min: 0,
              step: 1,
              value: prize.unlockAfter || 0,
              title: 'Number of pulls before this prize can be won. 0 = from the start.',
              oninput: bind('unlockAfter', (v) => Math.max(0, Number(v) || 0)),
            }),
          ),
          h(
            'label',
            { class: 'field', style: 'margin:0; grid-column: 1 / -1' },
            h('span', { class: 'field__label' }, 'Subtitle'),
            h('input', { class: 'input', value: prize.subtitle, placeholder: 'Optional — set, condition, note…', maxlength: 80, oninput: bind('subtitle') }),
          ),
          h(
            'div',
            { class: 'prize__foot' },
            h('span', {}, 'Odds now: ', h('span', { class: 'prize__odds', 'data-odds': prize.id }, `${(odds.get(prize.id) || 0).toFixed(1)}%`)),
            h('span', { class: `prize__lock${isLocked(prize) ? '' : ' hidden'}`, 'data-lock': prize.id },
              `🔒 locked until pull #${prize.unlockAfter || 0}`),
            h(
              'label',
              { class: 'switch' },
              h('input', {
                type: 'checkbox',
                checked: unlimited ? '' : null,
                onchange: (event) => {
                  state.draft[index].stock = event.target.checked ? -1 : 1;
                  markDirty();
                  renderPrizes();
                },
              }),
              'Unlimited stock',
            ),
            h(
              'label',
              { class: 'switch' },
              h('input', {
                type: 'checkbox',
                checked: prize.active ? '' : null,
                onchange: (event) => {
                  state.draft[index].active = event.target.checked;
                  markDirty();
                  renderPrizes();
                },
              }),
              'In the case',
            ),
            h('span', { class: 'spacer' }),
            h('button', { class: 'btn btn--sm btn--ghost', type: 'button', title: 'Move up', onclick: () => movePrize(index, -1) }, '↑'),
            h('button', { class: 'btn btn--sm btn--ghost', type: 'button', title: 'Move down', onclick: () => movePrize(index, 1) }, '↓'),
            h(
              'button',
              {
                class: 'btn btn--sm btn--danger',
                type: 'button',
                onclick: () => {
                  if (!confirm(`Remove "${prize.name || 'this prize'}" from the case?`)) return;
                  state.draft.splice(index, 1);
                  markDirty();
                  renderPrizes();
                },
              },
              'Remove',
            ),
          ),
        ),
      );
    }),
  );
}

function refreshOdds() {
  const odds = computeOdds(state.draft);
  for (const node of document.querySelectorAll('[data-lock]')) {
    const prize = state.draft.find((p) => p.id === node.dataset.lock);
    if (!prize) continue;
    node.classList.toggle('hidden', !isLocked(prize));
    node.textContent = `🔒 locked until pull #${prize.unlockAfter || 0}`;
  }
  for (const node of document.querySelectorAll('[data-odds]')) {
    node.textContent = `${(odds.get(node.dataset.odds) || 0).toFixed(1)}%`;
  }
}

function movePrize(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= state.draft.length) return;
  const [item] = state.draft.splice(index, 1);
  state.draft.splice(target, 0, item);
  markDirty();
  renderPrizes();
}

/** Shrink on the client so every upload is phone-friendly and cheap to store. */
async function shrinkImage(file) {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const type = file.type === 'image/png' || file.type === 'image/webp' ? 'image/webp' : 'image/jpeg';
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, 0.86));
  return blob && blob.size < file.size ? blob : file;
}

async function uploadImage(file, index, drop) {
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    toast('That is not an image.', true);
    return;
  }
  drop.classList.add('is-hot');
  try {
    const body = new FormData();
    body.append('file', await shrinkImage(file), file.name);
    const { imageId } = await api('/api/admin/upload', { method: 'POST', body });
    state.draft[index].imageId = imageId;
    markDirty();
    renderPrizes();
    toast('Image uploaded — remember to save.');
  } catch (error) {
    toast(error.message, true);
  } finally {
    drop.classList.remove('is-hot');
  }
}

el('add-prize').addEventListener('click', () => {
  state.draft.push(newPrize());
  markDirty();
  renderPrizes();
  const inputs = el('prize-list').querySelectorAll('input.input');
  if (inputs.length) inputs[inputs.length - 5].focus();
});

el('discard-prizes').addEventListener('click', () => {
  state.draft = structuredClone(state.prizes);
  markDirty(false);
  renderPrizes();
});

el('save-prizes').addEventListener('click', async () => {
  const empty = state.draft.find((p) => !p.name.trim());
  if (empty) {
    toast('Every prize needs a name.', true);
    return;
  }
  el('save-prizes').disabled = true;
  try {
    const { prizes, rolls } = await api('/api/admin/prizes', {
      method: 'PUT',
      body: JSON.stringify({ prizes: state.draft }),
    });
    state.prizes = prizes;
    state.draft = structuredClone(prizes);
    markDirty(false);
    renderPrizes();
    toast('Prizes saved.');
  } catch (error) {
    toast(error.message, true);
  } finally {
    el('save-prizes').disabled = false;
  }
});

window.addEventListener('beforeunload', (event) => {
  if (state.dirty) event.preventDefault();
});

/* --------------------------------------------------------------- tickets */

async function loadTickets() {
  try {
    const { tickets, summary } = await api('/api/admin/tickets');
    state.tickets = tickets;
    el('t-unused').textContent = summary.unused;
    el('t-used').textContent = summary.used;
    el('t-total').textContent = summary.total;
    el('count-tickets').textContent = summary.unused;
    renderTickets();
  } catch (error) {
    toast(error.message, true);
  }
}

function visibleTickets() {
  const filter = el('ticket-filter').value;
  return state.tickets.filter((t) => {
    if (filter === 'unused') return !t.usedAt && !t.voidedAt;
    if (filter === 'used') return Boolean(t.usedAt);
    return true;
  });
}

function ticketStatus(t) {
  if (t.voidedAt) return h('span', { class: 'tag tag--void' }, 'void');
  if (t.usedAt) return h('span', { class: 'tag tag--used' }, 'opened');
  return h('span', { class: 'tag tag--open' }, 'unused');
}

function renderTickets() {
  const rows = visibleTickets();
  el('ticket-empty').classList.toggle('hidden', rows.length > 0);
  el('ticket-rows').replaceChildren(
    ...rows.map((t) =>
      h(
        'tr',
        {},
        h('td', { class: 'code' }, t.code),
        h('td', { class: 'muted' }, t.batch || '—'),
        h('td', {}, ticketStatus(t), t.claimCode ? h('span', { class: 'muted', style: 'margin-left:8px' }, `→ ${t.claimCode}`) : null),
        h('td', { class: 'muted' }, fmtTime(t.createdAt)),
        h(
          'td',
          { style: 'text-align:right; white-space:nowrap' },
          h('button', { class: 'btn btn--sm btn--ghost', type: 'button', onclick: () => copyLink(t.code) }, 'Copy link'),
          t.usedAt
            ? null
            : h('button', { class: 'btn btn--sm btn--ghost', type: 'button', onclick: () => voidTicket(t.code) }, t.voidedAt ? 'Restore' : 'Void'),
        ),
      ),
    ),
  );
}

function ticketUrl(code) {
  return `${location.origin}/?c=${encodeURIComponent(code)}`;
}

async function copyLink(code) {
  try {
    await navigator.clipboard.writeText(ticketUrl(code));
    toast('Link copied.');
  } catch {
    prompt('Copy this link', ticketUrl(code));
  }
}

async function voidTicket(code) {
  try {
    await api('/api/admin/tickets/void', { method: 'POST', body: JSON.stringify({ code }) });
    await loadTickets();
  } catch (error) {
    toast(error.message, true);
  }
}

el('ticket-filter').addEventListener('change', renderTickets);

el('ticket-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const count = Number(el('ticket-count').value) || 1;
  const button = event.target.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    const { tickets } = await api('/api/admin/tickets', {
      method: 'POST',
      body: JSON.stringify({ count, batch: el('ticket-batch').value }),
    });
    toast(`${tickets.length} tickets generated.`);
    el('ticket-filter').value = 'unused';
    await loadTickets();
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
});

el('print-tickets').addEventListener('click', () => {
  const rows = visibleTickets().filter((t) => !t.usedAt && !t.voidedAt);
  if (!rows.length) {
    toast('No unused tickets to print in this view.', true);
    return;
  }
  if (typeof qrcode !== 'function') {
    toast('QR library did not load.', true);
    return;
  }
  const sheet = el('sheet');
  sheet.classList.remove('sheet--sign');
  sheet.replaceChildren(
    ...rows.map((t) => {
      const qr = qrcode(0, 'M');
      qr.addData(ticketUrl(t.code));
      qr.make();
      const slip = h('div', { class: 'slip' });
      slip.insertAdjacentHTML('afterbegin', qr.createSvgTag({ cellSize: 3, margin: 2, scalable: true }));
      slip.append(
        h('div', { class: 'slip__code' }, t.code),
        h('div', { class: 'slip__store' }, `${state.settings.storeName} · scan to open your case`),
      );
      return slip;
    }),
  );
  window.print();
});

/* ---------------------------------------------------------------- QR sign */

function caseUrl() {
  return `${location.origin}/`;
}

function qrSvg(text, cellSize = 4) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize, margin: 2, scalable: true });
}

function renderSign() {
  if (typeof qrcode !== 'function') return;
  el('sign-url').textContent = caseUrl();
  el('sign-qr').innerHTML = qrSvg(caseUrl());
}

el('print-sign').addEventListener('click', () => {
  if (typeof qrcode !== 'function') {
    toast('QR library did not load.', true);
    return;
  }
  const sheet = el('sheet');
  sheet.classList.add('sheet--sign');
  const sign = h('div', { class: 'sign' });
  sign.append(
    h('div', { class: 'sign__store' }, state.settings.storeName),
    h('div', { class: 'sign__title' }, 'Scan to open your case'),
    h('div', { class: 'sign__sub' }, 'One free pull with every purchase — show staff your claim code'),
  );
  sign.insertAdjacentHTML('beforeend', qrSvg(caseUrl(), 6));
  sign.append(h('div', { class: 'sign__url' }, caseUrl()));
  sheet.replaceChildren(sign);
  window.print();
});

/* ------------------------------------------------------------------ pulls */

async function loadWins() {
  try {
    const { wins, summary } = await api('/api/admin/wins');
    state.wins = wins;
    el('count-pulls').textContent = summary.pending;
    renderWins();
  } catch (error) {
    toast(error.message, true);
  }
}

function renderWins() {
  const pendingOnly = el('pending-only').checked;
  const rows = state.wins.filter((w) => !pendingOnly || !w.redeemed);
  el('pull-empty').classList.toggle('hidden', rows.length > 0);
  el('pull-rows').replaceChildren(
    ...rows.map((w) =>
      h(
        'tr',
        {},
        h('td', { class: 'muted', style: 'white-space:nowrap' }, fmtTime(w.createdAt)),
        h(
          'td',
          {},
          h('span', { class: `pill rarity-${w.rarity}`, style: 'margin-right:8px' }, w.rarity),
          w.prizeName,
        ),
        h('td', { class: 'code' }, w.claimCode),
        h('td', { class: 'muted code' }, w.ticketCode || '—'),
        h('td', {}, w.redeemed ? h('span', { class: 'tag tag--used' }, 'collected') : h('span', { class: 'tag tag--open' }, 'pending')),
        h(
          'td',
          { style: 'text-align:right' },
          h(
            'button',
            { class: `btn btn--sm ${w.redeemed ? 'btn--ghost' : ''}`, type: 'button', onclick: () => redeem({ id: w.id, redeemed: !w.redeemed }) },
            w.redeemed ? 'Undo' : 'Collected',
          ),
        ),
      ),
    ),
  );
}

async function redeem(payload) {
  try {
    const { win } = await api('/api/admin/wins/redeem', { method: 'POST', body: JSON.stringify(payload) });
    toast(win.redeemed ? `${win.prizeName} marked collected.` : 'Marked pending again.');
    await loadWins();
  } catch (error) {
    toast(error.message, true);
  }
}

el('redeem-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const code = el('redeem-code').value.trim();
  if (!code) return;
  redeem({ claimCode: code, redeemed: true });
  el('redeem-code').value = '';
});

el('pending-only').addEventListener('change', renderWins);
el('refresh-pulls').addEventListener('click', loadWins);

/* --------------------------------------------------------------- settings */

function fillSettings(settings) {
  const form = el('settings-form');
  for (const [key, value] of Object.entries(settings)) {
    const field = form.elements[key];
    if (!field) continue;
    if (field.type === 'checkbox') field.checked = Boolean(value);
    else field.value = value;
  }
  el('live-toggle').checked = settings.live;
  el('live-label').textContent = settings.live ? 'Live' : 'Closed';
}

el('settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const payload = {
    storeName: form.elements.storeName.value,
    caseName: form.elements.caseName.value,
    tagline: form.elements.tagline.value,
    claimNote: form.elements.claimNote.value,
    closedMessage: form.elements.closedMessage.value,
    caseMode: form.elements.caseMode.value,
    autoCollect: form.elements.autoCollect.checked,
    limitOpens: form.elements.limitOpens.checked,
    requireTicket: form.elements.requireTicket.checked,
    showOdds: form.elements.showOdds.checked,
    maxOpensPerHour: Number(form.elements.maxOpensPerHour.value),
  };
  try {
    const { settings } = await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(payload) });
    state.settings = settings;
    fillSettings(settings);
    toast('Settings saved.');
  } catch (error) {
    toast(error.message, true);
  }
});

el('live-toggle').addEventListener('change', async (event) => {
  try {
    const { settings } = await api('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify({ live: event.target.checked }),
    });
    state.settings = settings;
    fillSettings(settings);
    toast(settings.live ? 'Case is live.' : 'Case closed to customers.');
  } catch (error) {
    toast(error.message, true);
    event.target.checked = !event.target.checked;
  }
});

for (const button of document.querySelectorAll('[data-purge]')) {
  button.addEventListener('click', async () => {
    const what = button.dataset.purge;
    if (!confirm(`Delete ALL ${what}? This cannot be undone.`)) return;
    if (prompt(`Type ${what.toUpperCase()} to confirm`) !== what.toUpperCase()) return;
    try {
      const { deleted } = await api('/api/admin/purge', { method: 'POST', body: JSON.stringify({ what }) });
      toast(`Deleted ${deleted} records.`);
      await Promise.all([loadTickets(), loadWins()]);
    } catch (error) {
      toast(error.message, true);
    }
  });
}

/* ------------------------------------------------------------------- boot */

async function boot() {
  let data;
  try {
    data = await api('/api/admin/state');
  } catch {
    return; // 401 already routed to the login screen
  }
  state.rarities = data.rarities;
  state.settings = data.settings;
  state.prizes = data.prizes;
  state.draft = structuredClone(data.prizes);
  el('count-pulls').textContent = data.stats.wins;
  el('count-tickets').textContent = data.stats.tickets;

  state.stats = data.stats || {};
  fillSettings(data.settings);
  renderPrizes();
  markDirty(false);

  el('login').classList.add('hidden');
  el('admin').classList.add('is-ready');
}

boot();
