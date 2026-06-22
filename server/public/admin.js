// CoinLudo admin page logic.
// Auth: log in for a short-lived admin JWT, kept in sessionStorage and sent as a
// Bearer token on every admin API call. No inline handlers (CSP-friendly).

const API = '/api/admin';
const TOKEN_KEY = 'coinludo-admin';
let currentUserId = null;

const $ = (id) => document.getElementById(id);
const show = (el, on = true) => el.classList.toggle('hidden', !on);
const getToken = () => sessionStorage.getItem(TOKEN_KEY);
const setToken = (t) => (t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY));

// Authenticated request helper. A 401 drops the session and returns to login.
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    setToken(null);
    render();
    throw new Error(data.error || 'Session expired — sign in again');
  }
  if (!res.ok) throw new Error(data.error || 'Error ' + res.status);
  return data;
}

function render() {
  const authed = !!getToken();
  show($('login-view'), !authed);
  show($('dash-view'), authed);
}

function msg(text, isError = false) {
  const m = $('action-msg');
  m.textContent = text;
  m.className = 'msg' + (isError ? ' error' : '');
  show(m, true);
  setTimeout(() => show(m, false), 4000);
}

function cell(text, cls) {
  const td = document.createElement('td');
  td.textContent = text;
  if (cls) td.className = cls;
  return td;
}

function renderLedger(history) {
  const body = $('ledger-body');
  body.replaceChildren();
  for (const e of history) {
    const tr = document.createElement('tr');
    tr.append(
      cell(e.reason),
      cell((e.delta > 0 ? '+' : '') + e.delta, e.delta > 0 ? 'pos' : 'neg'),
      cell(String(e.balanceAfter)),
      cell(new Date(e.at).toLocaleString()),
    );
    body.appendChild(tr);
  }
}

function renderPlayer(data) {
  currentUserId = data.user.id;
  $('player-name').textContent = data.user.name;
  $('player-id').textContent = data.user.id;
  $('player-email').textContent = data.user.email || '';
  $('player-coins').textContent = data.user.coins.toLocaleString('en-IN');
  renderLedger(data.history || []);
  show($('player-card'), true);
}

// ── Login ──
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  show($('login-error'), false);
  try {
    const res = await fetch(API + '/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('username').value, password: $('password').value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Login failed');
    setToken(data.token);
    $('password').value = '';
    render();
  } catch (err) {
    $('login-error').textContent = err.message;
    show($('login-error'), true);
  }
});

$('logout').addEventListener('click', () => {
  setToken(null);
  currentUserId = null;
  show($('player-card'), false);
  render();
});

// ── Look up a player ──
$('lookup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  show($('lookup-error'), false);
  try {
    const id = $('lookup-id').value.trim();
    const data = await api('/users/' + encodeURIComponent(id));
    renderPlayer(data);
  } catch (err) {
    $('lookup-error').textContent = err.message;
    show($('lookup-error'), true);
    show($('player-card'), false);
  }
});

// ── Credit / debit ──
async function adjust(kind, amountEl, reasonEl) {
  if (!currentUserId) return;
  const amount = parseInt(amountEl.value, 10);
  if (!Number.isInteger(amount) || amount <= 0) return msg('Enter a valid amount', true);
  try {
    const data = await api('/' + kind, {
      method: 'POST',
      body: { userId: currentUserId, amount, reason: reasonEl.value || undefined },
    });
    $('player-coins').textContent = data.balance.toLocaleString('en-IN');
    amountEl.value = '';
    reasonEl.value = '';
    msg(`${kind === 'credit' ? 'Credited' : 'Debited'} ${amount} coins · new balance ${data.balance}`);
    const fresh = await api('/users/' + encodeURIComponent(currentUserId));
    renderLedger(fresh.history || []);
  } catch (err) {
    msg(err.message, true);
  }
}

$('credit-form').addEventListener('submit', (e) => {
  e.preventDefault();
  adjust('credit', $('credit-amount'), $('credit-reason'));
});
$('debit-form').addEventListener('submit', (e) => {
  e.preventDefault();
  adjust('debit', $('debit-amount'), $('debit-reason'));
});

render();
