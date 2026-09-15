// CoinLudo admin console.
// Auth: log in for a short-lived admin JWT, kept in sessionStorage and sent as a
// Bearer token on every call. No inline handlers (CSP-friendly).

const API = '/api/admin';
const TOKEN_KEY = 'coinludo-admin';
let currentUserId = null;
let currentTournamentId = null;

const $ = (id) => document.getElementById(id);
const show = (el, on = true) => el && el.classList.toggle('hidden', !on);
const getToken = () => sessionStorage.getItem(TOKEN_KEY);
const setToken = (t) => (t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY));
const rupees = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;
const when = (ms) => (ms ? new Date(ms).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

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
  if (authed) refreshAll();
}

function msg(text, isError = false) {
  const m = $('action-msg');
  m.textContent = text;
  m.className = 'msg' + (isError ? ' error' : '');
  show(m, true);
  setTimeout(() => show(m, false), 4000);
}

// Build DOM without innerHTML, so nothing a player typed can become markup.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
function button(label, className, onClick) {
  const b = el('button', `btn ${className}`, label);
  b.addEventListener('click', onClick);
  return b;
}
function empty(container, text) {
  container.replaceChildren(el('p', 'sub', text));
}

// ── Tabs ──
$('tabs')?.addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
  document.querySelectorAll('.panel').forEach((p) => show(p, p.dataset.panel === tab.dataset.tab));
});

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

// ── Overview ──
async function loadOverview() {
  const { totals, tournaments } = await api('/stats');
  const kpis = $('kpis');
  kpis.replaceChildren(
    kpi('Your revenue', rupees(totals.yourCutInr), 'good'),
    kpi('Collected', rupees(totals.collectedInr)),
    kpi('Prize pool', rupees(totals.prizePoolInr)),
    kpi('Entries', totals.entries),
    kpi('Awaiting review', totals.pendingClaims, totals.pendingClaims ? 'warn' : ''),
  );

  const list = $('overview-list');
  if (!tournaments.length) return empty(list, 'No tournaments yet — create one in the Tournaments tab.');
  list.replaceChildren(
    ...tournaments.map((t) => {
      const row = el('div', 'row-item');
      const main = el('div', 'row-main');
      main.append(el('div', 'row-title', t.title), el('div', 'row-sub',
        `${t.status} · ${t.players}/${t.maxPlayers} players · ${rupees(t.entryFeeInr)} entry · ${when(t.startsAt)}`));
      row.append(main, el('div', 'row-amount', rupees(t.yourCutInr)));
      return row;
    }),
  );
}
function kpi(label, value, tone = '') {
  const box = el('div', `kpi ${tone}`);
  box.append(el('div', 'kpi-label', label), el('div', 'kpi-value', String(value)));
  return box;
}

// ── Tournaments ──
function splitValues() {
  return $('t-split').value.split(',').map(Number);
}
function updatePreview() {
  const fee = Number($('t-fee').value) || 0;
  const size = Number($('t-size').value) || 0;
  const rake = Math.round((Number($('t-rake').value) || 0) * 100); // % → bips
  const gross = fee * size;
  const cut = Math.floor((gross * rake) / 10000);
  const pool = gross - cut;
  const parts = splitValues();
  const amounts = parts.map((p) => Math.floor((pool * p) / 100));
  amounts[0] += pool - amounts.reduce((a, b) => a + b, 0);
  $('t-preview').textContent = fee
    ? `If it fills: collect ${rupees(gross)} · you keep ${rupees(cut)} · prizes ${amounts.map(rupees).join(' / ')}`
    : 'Free tournament — no entry fee.';
}
['t-fee', 't-rake', 't-size', 't-split'].forEach((id) => $(id)?.addEventListener('input', updatePreview));

$('t-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const startsAt = new Date($('t-start').value).getTime();
  if (!startsAt) return msg('Pick a start time', true);
  try {
    const body = {
      title: $('t-title').value,
      entryType: $('t-entry').value,
      entryFeeInr: Number($('t-fee').value) || 0,
      entryFeeCoins: $('t-entry').value === 'coins' ? Number($('t-fee').value) || 0 : 0,
      rakeBips: Math.round((Number($('t-rake').value) || 0) * 100),
      payoutSplit: splitValues(),
      maxPlayers: Number($('t-size').value),
      startsAt,
      lobbyMinutes: Number($('t-lobby').value),
    };
    const { tournament } = await api('/tournaments', { method: 'POST', body });
    msg(`Created "${tournament.title}"`);
    $('t-title').value = '';
    loadTournaments();
    loadOverview();
  } catch (err) {
    msg(err.message, true);
  }
});

async function loadTournaments() {
  const { tournaments } = await api('/tournaments');
  const list = $('t-list');
  if (!tournaments.length) return empty(list, 'None yet.');
  list.replaceChildren(
    ...tournaments.map((t) => {
      const row = el('div', 'row-item');
      const main = el('div', 'row-main');
      main.append(
        el('div', 'row-title', t.title),
        el('div', 'row-sub', `${t.status} · ${rupees(t.entryFeeInr)} · ${t.maxPlayers}p · ${when(t.startsAt)}`),
      );
      const actions = el('div', 'row-actions');
      actions.append(button('Open', 'small', () => openTournament(t.id).catch((e) => msg(e.message, true))));
      if (['cancelled', 'finished'].includes(t.status)) {
        actions.append(button('Delete', 'small danger', () => deleteTournament(t)));
      }
      row.append(main, actions);
      return row;
    }),
  );
}

// Shared by the row button and the detail card. The server is the real guard
// (it refuses to delete anything still holding seats or unreviewed payments);
// this only has to ask, and tidy up the pane afterwards.
async function deleteTournament(t) {
  const warning =
    t.status === 'finished'
      ? `Delete "${t.title}" for good?\n\nIts bracket and final placings are erased. Prize payments already made stay in the wallet ledger.`
      : `Delete "${t.title}" for good?\n\nThis cannot be undone.`;
  if (!confirm(warning)) return;
  try {
    await api(`/tournaments/${t.id}`, { method: 'DELETE' });
    msg(`Deleted "${t.title}"`);
    if (currentTournamentId === t.id) {
      currentTournamentId = null;
      openSeq += 1; // cancel any open in flight, so it can't repaint the pane
      show($('t-detail-card'), false);
    }
    loadTournaments();
  } catch (err) {
    msg(err.message, true);
  }
}

let openSeq = 0;

async function openTournament(id) {
  const seq = ++openSeq;
  currentTournamentId = id;
  let d;
  try {
    d = await api(`/tournaments/${id}`);
  } catch (err) {
    // Never strand the operator looking at a tournament that is no longer the
    // one they clicked — blank the pane and let the error speak.
    if (seq === openSeq) {
      currentTournamentId = null;
      show($('t-detail-card'), false);
    }
    throw err;
  }
  if (seq !== openSeq) return; // a newer click already won the race
  const box = $('t-detail');
  show($('t-detail-card'), true);
  $('t-detail-title').textContent = d.tournament.title;

  const money = d.money;
  const info = el('div', 'detail-money');
  info.append(
    el('div', '', `Status: ${d.tournament.status}`),
    el('div', '', `Collected ${rupees(money.collectedInr)} · your cut ${rupees(money.yourCutInr)} · prizes ${rupees(money.prizePoolInr)}`),
    el('div', 'row-sub', `Payouts: ${money.payouts.map((p) => `${p.place}. ${rupees(p.amountInr)}`).join('  ')}`),
    el('div', 'row-sub', `ID: ${d.tournament.id}`),
  );
  box.replaceChildren(info);

  // Entries
  const entries = el('div', 'rows');
  if (!d.entries.length) empty(entries, 'No players yet.');
  else
    d.entries.forEach((e) => {
      const row = el('div', 'row-item');
      const main = el('div', 'row-main');
      main.append(el('div', 'row-title', `${e.seed}. ${e.name || e.userId}`), el('div', 'row-sub', `paid: ${e.paymentRef || '—'}`));
      const actions = el('div', 'row-actions');
      if (d.tournament.status === 'open') {
        actions.append(button('Remove', 'small danger', async () => {
          try {
            await api(`/tournaments/${id}/entries/${e.userId}`, { method: 'DELETE' });
            msg('Removed'); openTournament(id);
          } catch (err) { msg(err.message, true); }
        }));
      }
      row.append(main, actions);
      entries.append(row);
    });
  box.append(el('h3', '', `Players (${d.entries.length}/${d.tournament.maxPlayers})`), entries);

  // Add a player manually (after an off-app payment)
  if (d.tournament.status === 'open') {
    const form = el('form', 'row');
    const uid = el('input'); uid.placeholder = 'Player ID';
    const ref = el('input'); ref.placeholder = 'Payment ref (UTR)';
    const add = el('button', 'btn small', 'Add');
    form.append(uid, ref, add);
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        await api(`/tournaments/${id}/entries`, { method: 'POST', body: { userId: uid.value.trim(), paymentRef: ref.value.trim() } });
        msg('Player added'); openTournament(id);
      } catch (err) { msg(err.message, true); }
    });
    box.append(el('h3', '', 'Add a player manually'), form);
    box.append(button('▶ Start now', 'primary block', async () => {
      try { await api(`/tournaments/${id}/start`, { method: 'POST' }); msg('Started'); openTournament(id); }
      catch (err) { msg(err.message, true); }
    }));
  }

  // Live matches
  if (d.playing?.length) {
    const names = Object.fromEntries(d.entries.map((e) => [e.userId, e.name || e.userId]));
    const matches = el('div', 'rows');
    d.playing.forEach((m) => {
      const row = el('div', 'row-item');
      const main = el('div', 'row-main');
      main.append(el('div', 'row-title', `${names[m.a] || '?'}  vs  ${names[m.b] || '?'}`), el('div', 'row-sub', `Round ${m.round}`));
      const actions = el('div', 'row-actions');
      actions.append(
        button(`${names[m.a] || 'A'} won`, 'small', () => recordResult(id, m.id, m.a)),
        button(`${names[m.b] || 'B'} won`, 'small', () => recordResult(id, m.id, m.b)),
      );
      row.append(main, actions);
      matches.append(row);
    });
    box.append(el('h3', '', 'Live matches — set a result if a game is disputed'), matches);
  }

  // Prize sheet once finished
  if (d.tournament.status === 'finished') {
    const { prizes } = await api(`/tournaments/${id}/prizes`).catch(() => ({ prizes: [] }));
    const sheet = el('div', 'rows');
    prizes.forEach((p) => {
      const row = el('div', 'row-item');
      row.append(el('div', 'row-main', `${p.place}. ${p.name || p.userId}`), el('div', 'row-amount', rupees(p.amountInr)));
      sheet.append(row);
    });
    box.append(el('h3', '', 'Prize sheet'), sheet);
    if (d.tournament.entryType !== 'balance') {
      box.append(el('p', 'sub', 'Pay these by UPI — balance tournaments pay out automatically.'));
    }
  }

  if (['open', 'lobby', 'running'].includes(d.tournament.status)) {
    box.append(button('Cancel tournament (refunds entries)', 'danger block', async () => {
      if (!confirm('Cancel and refund everyone?')) return;
      try { await api(`/tournaments/${id}/cancel`, { method: 'POST', body: {} }); msg('Cancelled'); openTournament(id); loadTournaments(); }
      catch (err) { msg(err.message, true); }
    }));
  }

  // Only offered once a tournament is over, so deleting can never be a way to
  // skip refunding entrants.
  if (['cancelled', 'finished'].includes(d.tournament.status)) {
    box.append(button('Delete permanently', 'danger block', () => deleteTournament(d.tournament)));
  }
}

async function recordResult(id, matchId, winnerId) {
  try {
    await api(`/tournaments/${id}/result`, { method: 'POST', body: { matchId, winnerId } });
    msg('Result recorded');
    openTournament(id);
  } catch (err) { msg(err.message, true); }
}

// ── Payments: deposits + tournament claims ──
async function loadPayments() {
  const [{ deposits }, { claims }] = await Promise.all([api('/deposits'), api('/claims')]);

  const dl = $('deposit-list');
  if (!deposits.length) empty(dl, 'No deposits waiting.');
  else
    dl.replaceChildren(...deposits.map((d) => {
      const row = el('div', 'row-item');
      const main = el('div', 'row-main');
      main.append(
        el('div', 'row-title', `${d.userName || d.userId} — ${rupees(d.amountInr)}`),
        el('div', 'row-sub', `UTR ${d.utr} · ${when(d.createdAt)}${d.note ? ' · ' + d.note : ''}`),
      );
      const amount = el('input', 'tiny-input');
      amount.type = 'number'; amount.value = d.amountInr; amount.title = 'Amount actually received';
      const actions = el('div', 'row-actions');
      actions.append(amount,
        button('Approve', 'small primary', async () => {
          try { const r = await api(`/deposits/${d.id}/approve`, { method: 'POST', body: { amountInr: Number(amount.value) } });
            msg(`Credited ${rupees(r.credited)}`); refreshAll(); } catch (e) { msg(e.message, true); }
        }),
        button('Reject', 'small danger', async () => {
          const reason = prompt('Reason (shown to the player):', 'Payment not found');
          if (reason === null) return;
          try { await api(`/deposits/${d.id}/reject`, { method: 'POST', body: { reason } }); msg('Rejected'); refreshAll(); }
          catch (e) { msg(e.message, true); }
        }));
      row.append(main, actions);
      return row;
    }));

  const cl = $('claim-list');
  if (!claims.length) empty(cl, 'No entry payments waiting.');
  else
    cl.replaceChildren(...claims.map((c) => {
      const row = el('div', 'row-item');
      const main = el('div', 'row-main');
      main.append(
        el('div', 'row-title', `${c.userName || c.userId} — ${c.tournamentTitle || 'tournament'}`),
        el('div', 'row-sub', `${rupees(c.amountInr)} · UTR ${c.utr} · ${when(c.createdAt)}`),
      );
      const actions = el('div', 'row-actions');
      actions.append(
        button('Approve', 'small primary', async () => {
          try { await api(`/claims/${c.id}/approve`, { method: 'POST', body: {} }); msg('Player entered'); refreshAll(); }
          catch (e) { msg(e.message, true); }
        }),
        button('Reject', 'small danger', async () => {
          const reason = prompt('Reason:', 'Payment not found');
          if (reason === null) return;
          try { await api(`/claims/${c.id}/reject`, { method: 'POST', body: { reason } }); msg('Rejected'); refreshAll(); }
          catch (e) { msg(e.message, true); }
        }));
      row.append(main, actions);
      return row;
    }));

  const n = deposits.length + claims.length;
  const badge = $('badge-payments');
  badge.textContent = String(n);
  show(badge, n > 0);
}

// ── Withdrawals ──
async function loadWithdrawals() {
  const { withdrawals } = await api('/withdrawals');
  const list = $('withdrawal-list');
  if (!withdrawals.length) empty(list, 'No payouts waiting.');
  else
    list.replaceChildren(...withdrawals.map((w) => {
      const row = el('div', 'row-item');
      const main = el('div', 'row-main');
      main.append(
        el('div', 'row-title', `${w.userName || w.userId} — ${rupees(w.amountInr)}`),
        el('div', 'row-sub', `to ${w.upiId} · requested ${when(w.createdAt)}`),
      );
      const actions = el('div', 'row-actions');
      actions.append(
        button('Mark paid', 'small primary', async () => {
          const ref = prompt(`Confirm you have sent ${rupees(w.amountInr)} to ${w.upiId}.\n\nPayment reference (optional):`, '');
          if (ref === null) return;
          try { await api(`/withdrawals/${w.id}/paid`, { method: 'POST', body: { paymentRef: ref } }); msg('Marked paid'); refreshAll(); }
          catch (e) { msg(e.message, true); }
        }),
        button('Reject', 'small danger', async () => {
          const reason = prompt('Reason (money is returned to the player):', '');
          if (reason === null) return;
          try { await api(`/withdrawals/${w.id}/reject`, { method: 'POST', body: { reason } }); msg('Rejected and refunded'); refreshAll(); }
          catch (e) { msg(e.message, true); }
        }));
      row.append(main, actions);
      return row;
    }));

  const badge = $('badge-withdrawals');
  badge.textContent = String(withdrawals.length);
  show(badge, withdrawals.length > 0);
}

// ── Players ──
function cell(text, cls) { const td = el('td', cls, text); return td; }
function renderLedger(history) {
  const body = $('ledger-body');
  body.replaceChildren(...history.map((e) => {
    const tr = el('tr');
    tr.append(cell(e.reason), cell((e.delta > 0 ? '+' : '') + e.delta, e.delta > 0 ? 'pos' : 'neg'),
      cell(String(e.balanceAfter)), cell(new Date(e.at).toLocaleString()));
    return tr;
  }));
}
$('lookup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  show($('lookup-error'), false);
  try {
    const data = await api('/users/' + encodeURIComponent($('lookup-id').value.trim()));
    currentUserId = data.user.id;
    $('player-name').textContent = data.user.name;
    $('player-id').textContent = data.user.id;
    $('player-email').textContent = data.user.email || '';
    $('player-coins').textContent = data.user.coins.toLocaleString('en-IN');
    renderLedger(data.history || []);
    show($('player-card'), true);
  } catch (err) {
    $('lookup-error').textContent = err.message;
    show($('lookup-error'), true);
    show($('player-card'), false);
  }
});
async function adjust(kind, amountEl, reasonEl) {
  if (!currentUserId) return;
  const amount = parseInt(amountEl.value, 10);
  if (!Number.isInteger(amount) || amount <= 0) return msg('Enter a valid amount', true);
  try {
    const data = await api('/' + kind, { method: 'POST', body: { userId: currentUserId, amount, reason: reasonEl.value || undefined } });
    $('player-coins').textContent = data.balance.toLocaleString('en-IN');
    amountEl.value = ''; reasonEl.value = '';
    msg(`${kind === 'credit' ? 'Credited' : 'Debited'} ${amount} coins`);
    const fresh = await api('/users/' + encodeURIComponent(currentUserId));
    renderLedger(fresh.history || []);
  } catch (err) { msg(err.message, true); }
}
$('credit-form').addEventListener('submit', (e) => { e.preventDefault(); adjust('credit', $('credit-amount'), $('credit-reason')); });
$('debit-form').addEventListener('submit', (e) => { e.preventDefault(); adjust('debit', $('debit-amount'), $('debit-reason')); });

// ── Notifications ──
const notifyTarget = $('notify-target');
notifyTarget?.addEventListener('change', () => {
  show($('notify-tid-wrap'), notifyTarget.value === 'tournament');
  show($('notify-uid-wrap'), notifyTarget.value === 'user');
});
async function refreshReach() {
  try {
    const r = await api('/notify/reach');
    $('reach').textContent = r.enabled
      ? `${r.subscribers} subscriber${r.subscribers === 1 ? '' : 's'} reachable.`
      : 'Push is not configured on the server.';
  } catch { /* non-critical */ }
}
$('notify-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('/notify', { method: 'POST', body: {
      target: notifyTarget.value,
      title: $('notify-title').value,
      body: $('notify-body').value,
      tournamentId: $('notify-tid').value.trim() || undefined,
      userId: $('notify-uid').value.trim() || undefined,
    } });
    msg(`Sent to ${r.sent} device(s) across ${r.recipients} player(s).`);
    $('notify-title').value = ''; $('notify-body').value = '';
  } catch (err) { msg(err.message, true); }
});

// ── Boot ──
async function refreshAll() {
  if (!getToken()) return;
  await Promise.allSettled([loadOverview(), loadTournaments(), loadPayments(), loadWithdrawals(), refreshReach()]);
  if (currentTournamentId) {
    openTournament(currentTournamentId).catch(() => {});
  }
}

// Default the start time to the next round hour — the common case.
const next = new Date(Date.now() + 60 * 60 * 1000);
next.setMinutes(0, 0, 0);
if ($('t-start')) $('t-start').value = new Date(next.getTime() - next.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
updatePreview();
render();
