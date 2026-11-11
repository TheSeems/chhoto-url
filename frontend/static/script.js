// SPDX-FileCopyrightText: 2023-2026 Sayantan Santra <sayantan.santra689@gmail.com>
// SPDX-License-Identifier: MIT

const $ = (id) => document.getElementById(id);

const state = {
  who: null, // Response of /api/whoami
  config: null, // Response of /api/getconfig
  admin: false,
  siteUrl: window.location.origin,
  pageSize: 10,
  links: [], // Links loaded so far, newest first
  exhausted: false, // True once the server has no more links to give
  page: 0,
  filter: '',
  busy: false,
};

// ---------- Talking to the backend ----------

const BASE = window.location.pathname.replace(/\/admin\/manage\/$/, '/');
const url = (path) => `${BASE}/${path}`.replace(/\/+/g, '/');

// Errors come back either as plain text or as JSON with a "reason"
const reasonOf = async (res) => {
  const text = await res.text();
  try {
    return JSON.parse(text).reason || text;
  } catch {
    return text;
  }
};

const request = async (method, path, body) => {
  const res = await fetch(url(`api/${path}`), {
    method,
    cache: 'no-cache',
    headers: body
      ? { 'Content-Type': 'application/json' }
      : { Accept: 'application/json' },
    body: body && JSON.stringify(body),
  });
  if (!res.ok) {
    const err = new Error((await reasonOf(res)) || `Got status ${res.status}`);
    err.status = res.status;
    // The session has expired
    if (res.status === 401 && path !== 'login' && state.who) {
      showLogin();
    }
    throw err;
  }
  return res;
};

// ---------- Small helpers ----------

let toastTimer;
const toast = (text, { error = false, link = null } = {}) => {
  const box = $('toast');
  box.textContent = text;
  if (link) {
    const a = document.createElement('a');
    a.href = a.textContent = link;
    a.target = '_blank';
    box.append(' ', a);
  }
  box.classList.toggle('error', error);
  // Re-opening the popover puts it above any open dialog
  box.hidePopover();
  box.showPopover();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.hidePopover(), error || link ? 6000 : 3000);
};

// Wraps an event handler so that failures end up in a toast
const guard =
  (fn) =>
  async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      console.error(err);
      toast(err.message || 'Something went wrong. Please try again.', {
        error: true,
      });
    }
  };

// Takes a promise so that copying works after a fetch in Safari as well
const copyText = async (textPromise) => {
  // Whoever made the promise deals with its failure, we only skip the copy
  textPromise.catch(() => {});
  if (!navigator.clipboard) {
    throw new Error('Unable to get access to clipboard.');
  }
  if (typeof ClipboardItem === 'function') {
    const blob = textPromise.then((t) => new Blob([t], { type: 'text/plain' }));
    blob.catch(() => {});
    await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
  } else {
    await navigator.clipboard.writeText(await textPromise);
  }
};

const shortUrlOf = (slug) => `${state.siteUrl}/${slug}`;

const formatTimeDiff = (seconds) => {
  if (seconds <= 0) {
    return 'expired';
  }
  const units = {
    year: 31536000,
    month: 2592000,
    day: 86400,
    hour: 3600,
    minute: 60,
    second: 1,
  };
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, size] of Object.entries(units)) {
    if (seconds > size || unit === 'second') {
      return rtf.format(Math.round(seconds / size), unit);
    }
  }
};

const formatDateTime = (timestamp) =>
  new Date(timestamp * 1000).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  });

// Value for a datetime-local input, in the local timezone
const toLocalInput = (date, length) =>
  new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, length);

const addMissingScheme = (e) => {
  const input = e.target;
  const value = input.value.trim();
  const allowed = state.config?.allowed_protocols ?? ['http', 'https'];
  let scheme = null;
  try {
    scheme = new URL(value).protocol.slice(0, -1);
  } catch {}
  input.value = value && !allowed.includes(scheme) ? `https://${value}` : value;
};

// ---------- Links table ----------

const fetchMore = async () => {
  const count = 2 * state.pageSize;
  const params = new URLSearchParams({ page_size: count });
  if (state.links.length > 0) {
    params.set('page_after', state.links.at(-1).shortlink);
  }
  if (state.filter) {
    params.set('filter', state.filter);
  }
  const res = await request('GET', `all?${params}`);
  // Every batch comes sorted oldest first
  const batch = (await res.json()).reverse();
  state.links.push(...batch);
  state.exhausted = batch.length < count;
};

const createRow = (link, number) => {
  const tr = $('row-template').content.firstElementChild.cloneNode(true);
  tr.dataset.slug = link.shortlink;
  tr.querySelector('.num').textContent = number;

  const short = tr.querySelector('.short a');
  short.textContent = link.shortlink;
  short.href = shortUrlOf(link.shortlink);

  const long = tr.querySelector('.long a');
  long.textContent = link.longlink;
  long.href = link.longlink;
  if (!link.enabled) {
    tr.classList.add('disabled');
    long.title = 'Link is disabled. Edit to enable again.';
  }

  tr.querySelector('.hits').textContent = link.hits.toLocaleString();

  const expiry = tr.querySelector('.expiry');
  if (link.expiry_time > 0) {
    expiry.dataset.time = link.expiry_time;
    expiry.title = formatDateTime(link.expiry_time);
  } else {
    expiry.textContent = '-';
  }
  return tr;
};

const refreshExpiryTimes = () => {
  const now = Date.now() / 1000;
  for (const td of document.querySelectorAll('td[data-time]')) {
    const text = formatTimeDiff(td.dataset.time - now);
    if (td.textContent !== text) {
      td.textContent = text;
    }
    if (text === 'expired') {
      const tr = td.parentElement;
      tr.classList.add('expired');
      tr.querySelectorAll('button').forEach((btn) => (btn.disabled = true));
      delete td.dataset.time;
      td.removeAttribute('title');
    }
  }
};

const render = () => {
  const start = state.page * state.pageSize;
  const links = state.links.slice(start, start + state.pageSize);
  const empty = state.links.length === 0;

  $('status').textContent = 'No active links.';
  $('status').hidden = !empty || !!state.filter;
  $('links').hidden = empty && !state.filter;
  $('links-table').hidden = empty;
  $('no-matches').hidden = !empty;
  $('rows').replaceChildren(...links.map((l, i) => createRow(l, start + i + 1)));
  refreshExpiryTimes();

  const firstPage = state.page === 0;
  const lastPage = state.links.length <= start + state.pageSize;
  $('prev-page').disabled = firstPage;
  $('next-page').disabled = lastPage;
  $('page-number').textContent = state.page + 1;
  $('pager').hidden = firstPage && lastPage;
};

// Loads whatever is needed to show the given page, then shows it
const showPage = async (page) => {
  if (state.busy) {
    return;
  }
  state.busy = true;
  try {
    // One extra link tells us whether there is a next page
    const needed = (page + 1) * state.pageSize + 1;
    while (!state.exhausted && state.links.length < needed) {
      await fetchMore();
    }
    const lastPage = Math.ceil(state.links.length / state.pageSize) - 1;
    state.page = Math.max(0, Math.min(page, lastPage));
    render();
  } finally {
    state.busy = false;
  }
};

const reloadLinks = () => {
  state.links = [];
  state.exhausted = false;
  return showPage(0);
};

// ---------- Row actions ----------

const showQrCode = (link) => {
  if (typeof QRCode !== 'function') {
    throw new Error('Could not load the QR code library.');
  }
  const qrWidth = 512;
  const padding = 24;
  const logoWidth = 100;
  const width = qrWidth + padding * 2;

  const tmp = document.createElement('div');
  new QRCode(tmp, {
    text: shortUrlOf(link.shortlink),
    correctLevel: QRCode.CorrectLevel.H,
    height: qrWidth,
    width: qrWidth,
  });

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = width;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, width, width);
  ctx.drawImage(tmp.querySelector('canvas'), padding, padding);

  const logo = new Image();
  logo.src = 'assets/favicon.svg';
  logo.onload = () => {
    ctx.beginPath();
    ctx.arc(width / 2, width / 2, 60, 0, Math.PI * 2);
    ctx.fill();
    const offset = (width - logoWidth) / 2;
    ctx.drawImage(logo, offset, offset, logoWidth, logoWidth);

    $('qr-code').replaceChildren(canvas);
    $('qr-download').href = canvas.toDataURL();
    $('qr-download').download = `chhoto-qr-${link.shortlink}.png`;
    $('qr-dialog').showModal();
  };
};

const showInfo = (link) => {
  $('info-short').textContent = link.shortlink;
  $('info-long').textContent = $('info-long').href = link.longlink;
  $('info-hits').textContent = link.hits.toLocaleString();
  $('info-expiry').textContent =
    link.expiry_time > 0 ? formatDateTime(link.expiry_time) : 'Never';
  $('info-enabled').textContent = link.enabled ? 'Yes' : 'No';
  $('info-notes').textContent = link.notes || '-';
  $('info-dialog').showModal();
};

const showEdit = (link) => {
  $('edit-slug').textContent = link.shortlink;
  $('edit-url').value = link.longlink;
  $('edit-notes').value = link.notes;
  $('edit-reset-hits').checked = false;
  $('edit-enabled').checked = link.enabled;
  $('edit-error').hidden = true;

  const expiry = $('edit-expiry');
  const now = new Date();
  expiry.min = toLocalInput(new Date(now.getTime() + 60000), 16);
  expiry.max = toLocalInput(new Date(now.getTime() + 5 * 31536000000), 16);
  expiry.value =
    link.expiry_time > 0
      ? toLocalInput(new Date(link.expiry_time * 1000), 19)
      : '';

  $('edit-dialog').showModal();
  $('edit-url').focus();
};

const submitEdit = async () => {
  const slug = $('edit-slug').textContent;
  const expiry = $('edit-expiry').value;
  const changes = {
    longlink: $('edit-url').value,
    notes: $('edit-notes').value,
    enabled: $('edit-enabled').checked,
    expiry_time: expiry ? Math.floor(new Date(expiry).getTime() / 1000) : 0,
  };
  const resetHits = $('edit-reset-hits').checked;
  try {
    await request('PUT', 'edit', {
      shortlink: slug,
      reset_hits: resetHits,
      ...changes,
    });
  } catch (err) {
    $('edit-error').textContent = err.message;
    $('edit-error').hidden = false;
    return;
  }
  const link = state.links.find((l) => l.shortlink === slug);
  Object.assign(link, changes, resetHits ? { hits: 0 } : {});
  $('edit-dialog').close();
  render();
};

// The first click arms the button, the second one deletes
const deleteLink = async (link, btn) => {
  if (!btn.classList.contains('armed')) {
    btn.classList.add('armed');
    btn.title = 'Click again to delete';
    setTimeout(() => {
      btn.classList.remove('armed');
      btn.title = 'Delete';
    }, 3000);
    return;
  }
  try {
    await request('DELETE', `del/${link.shortlink}`);
  } catch (err) {
    console.error(err);
    throw new Error(`Unable to delete ${link.shortlink}. Please try again!`);
  }
  state.links = state.links.filter((l) => l !== link);
  await showPage(state.page);
};

const actions = {
  copy: async (link) => {
    const full = shortUrlOf(link.shortlink);
    try {
      await copyText(Promise.resolve(full));
      toast('Copied to clipboard:', { link: full });
    } catch (err) {
      console.error(err);
      toast('Could not copy, please do it manually:', {
        error: true,
        link: full,
      });
    }
  },
  qr: showQrCode,
  info: showInfo,
  edit: showEdit,
  delete: deleteLink,
};

// ---------- Creating links ----------

const submitNew = async () => {
  const form = $('new-form');
  const created = request('POST', 'new', {
    longlink: form.longlink.value,
    shortlink: form.shortlink.value,
    expiry_delay: parseInt(form.expiry_delay.value),
    notes: form.notes.value,
  }).then((res) => res.text());
  // Has to start right away, while we still have the user gesture
  const copied = copyText(created.then(shortUrlOf)).then(
    () => true,
    () => false,
  );

  const full = shortUrlOf(await created);
  form.reset();
  toast('Link created:', { link: full });
  if (state.admin) {
    await reloadLinks();
  }
  // The browser may take its time here, e.g. to ask for permission
  if (await copied) {
    toast('Copied to clipboard:', { link: full });
  } else {
    toast('Link created, but could not copy it:', { link: full });
  }
};

// ---------- Login and logout ----------

function showLogin() {
  const { password_enabled, oidc_enabled, public_mode_enabled } = state.who;
  $('password-fields').hidden = !password_enabled;
  $('oidc-button').hidden = !oidc_enabled;
  $('login-error').hidden = true;
  // Without public mode there is nothing to go back to
  $('login-close').hidden = !public_mode_enabled;
  const dialog = $('login-dialog');
  if (!dialog.open) {
    document.querySelectorAll('dialog[open]').forEach((d) => d.close());
    dialog.showModal();
  }
  if (password_enabled) {
    $('password').focus();
  }
}

const submitLogin = async () => {
  try {
    await request('POST', 'login', {
      password: $('password').value,
      remember: $('remember').checked,
    });
  } catch (err) {
    if (err.status !== 401 && err.status !== 403) {
      throw err;
    }
    $('login-error').textContent = err.message;
    $('login-error').hidden = false;
    $('password').focus();
    return;
  }
  $('password').value = '';
  $('login-dialog').close();
  await init();
};

const logOut = async () => {
  await request('DELETE', 'logout');
  await init();
};

// ---------- Startup ----------

const applyConfig = (config) => {
  state.config = config;
  state.pageSize = config.frontend_page_size || 10;

  state.siteUrl = window.location.origin;
  if (config.site_url) {
    state.siteUrl = config.site_url.replace(/^"|"$/g, '').replace(/\/$/, '');
  }

  if (config.allow_capital_letters) {
    const input = $('short-url');
    input.pattern = '[A-Za-z0-9\\-_]+';
    input.title = input.placeholder = 'Only A-Z, a-z, 0-9, - and _ are allowed';
  }

  const version = $('version');
  version.querySelector('span').textContent = `v${config.version}`;
  version.href = config.version.includes('-dev+')
    ? `https://github.com/SinTan1729/chhoto-url/commits/${config.version.split('+')[1]}`
    : `https://github.com/SinTan1729/chhoto-url/releases/tag/${config.version}`;
  version.hidden = false;
};

async function init() {
  const status = $('status');
  $('links').hidden = true;
  $('auth-button').hidden = true;
  $('version').hidden = true;
  status.hidden = false;
  status.textContent = 'Loading links...';
  state.links = [];
  state.exhausted = false;
  state.filter = $('filter').value = '';

  try {
    state.who = await (await request('GET', 'whoami')).json();
    const { admin, password_enabled, oidc_enabled, public_mode_enabled } =
      state.who;
    // With no login method configured, the server lets everyone manage links
    const noAuthNeeded = !password_enabled && !oidc_enabled;
    state.admin = admin || noAuthNeeded;

    if (!state.admin && !public_mode_enabled) {
      status.textContent = 'Please log in to manage links.';
      showLogin();
      return;
    }

    applyConfig(await (await request('GET', 'getconfig')).json());
    $('auth-button').querySelector('span').textContent = state.admin
      ? 'logout'
      : 'login';
    $('auth-button').hidden = noAuthNeeded;

    if (state.admin) {
      await showPage(0);
    } else {
      const delay = parseInt(state.config.public_mode_expiry_delay);
      status.textContent =
        'Using public mode.' +
        (delay > 0
          ? ` Unless chosen a shorter expiry time, submitted links will automatically expire ${formatTimeDiff(delay)}.`
          : '');
    }
  } catch (err) {
    console.error(err);
    status.textContent =
      'Could not load data from the server. Reload the page to try again.';
  }
}

$('new-form').onsubmit = (e) => {
  e.preventDefault();
  guard(submitNew)();
};
$('long-url').onblur = addMissingScheme;
$('edit-url').onblur = addMissingScheme;

$('filter-form').onsubmit = (e) => {
  e.preventDefault();
  const filter = $('filter').value.trim();
  if (filter !== state.filter) {
    state.filter = filter;
    guard(reloadLinks)();
  }
};
$('prev-page').onclick = guard(() => showPage(state.page - 1));
$('next-page').onclick = guard(() => showPage(state.page + 1));

$('rows').onclick = guard(async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) {
    return;
  }
  const slug = btn.closest('tr').dataset.slug;
  const link = state.links.find((l) => l.shortlink === slug);
  await actions[btn.dataset.action](link, btn);
});

$('edit-form').onsubmit = (e) => {
  e.preventDefault();
  guard(submitEdit)();
};
$('edit-cancel').onclick = () => $('edit-dialog').close();

$('auth-button').onclick = guard(() => (state.admin ? logOut() : showLogin()));
$('login-form').onsubmit = (e) => {
  e.preventDefault();
  guard(submitLogin)();
};
// Escape must not dismiss the login dialog unless public mode is available
$('login-dialog').oncancel = (e) => {
  if (!state.who?.public_mode_enabled) {
    e.preventDefault();
  }
};
$('oidc-button').onclick = () => {
  window.location.href = url('oidc/login');
};
$('password-eye').onclick = () => {
  const input = $('password');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  $('password-eye')
    .querySelector('use')
    .setAttribute('href', show ? '#i-eye-off' : '#i-eye');
  input.focus();
};

for (const btn of document.querySelectorAll('button.dialog-close')) {
  btn.onclick = () => btn.closest('dialog').close();
}

setInterval(refreshExpiryTimes, 1000);
init();
