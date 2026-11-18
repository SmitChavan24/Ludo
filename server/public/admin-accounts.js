// Admin "Accounts" tab: the books. Uses helpers from admin.js ($, api, el, show,
// msg, rupees, coinsFmt), which loads first.
(() => {
  const DAY = 86_400_000;
  const IST = 19_800_000;
  const n = (v) => Number(v || 0).toLocaleString('en-IN');
  // Today's date in India as YYYY-MM-DD, shifted by `days`.
  const istDate = (days = 0) => new Date(Date.now() + IST + days * DAY).toISOString().slice(0, 10);

  const REASON_LABEL = {
    coin_purchase: 'Coins bought (shop)',
    admin_test_grant: 'Test coins (admin)',
    crm_topup: 'Admin credit',
    crm_adjust: 'Admin removal',
    signup_bonus: 'Sign-up bonus',
    daily_bonus: 'Daily bonus',
    referral_bonus: 'Referral bonus (new player)',
    referral_reward: 'Referral reward (inviter)',
    game_stake: 'Match stake',
    game_win: 'Match winnings',
    game_refund: 'Match refund',
    rake: 'Match fee (house)',
    tournament_entry: 'Tournament entry',
    tournament_prize: 'Tournament prize',
    tournament_refund: 'Tournament refund',
    tournament_rake: 'Tournament fee (house)',
  };
  const label = (r) => REASON_LABEL[r] || (r?.startsWith('crm:') ? `Admin: ${r.slice(4)}` : r);

  let ledgerOffset = 0;
  const PAGE = 50;
  let last = { cats: [], daily: [], orders: [], audit: [] };

  function range() {
    const p = $('acc-preset').value;
    show($('acc-from'), p === 'custom');
    show($('acc-to'), p === 'custom');
    if (p === 'all') return {};
    if (p === 'today') return { from: istDate(), to: istDate() };
    if (p === 'month') return { from: istDate().slice(0, 8) + '01', to: istDate() };
    if (p === 'custom') return { from: $('acc-from').value || undefined, to: $('acc-to').value || undefined };
    return { from: istDate(-(Number(p) - 1)), to: istDate() };
  }
  const qs = (obj) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(obj)) if (v != null && v !== '') q.set(k, v);
    const s = q.toString();
    return s ? `?${s}` : '';
  };

  function table(id, headers, rows, foot) {
    const t = $(id);
    const thead = el('thead');
    const hr = el('tr');
    for (const [h, num] of headers) hr.append(el('th', num ? 'num' : '', h));
    thead.append(hr);
    const tbody = el('tbody');
    if (!rows.length) {
      const tr = el('tr');
      const td = el('td', 'sub', 'Nothing in this period.');
      td.colSpan = headers.length;
      tr.append(td);
      tbody.append(tr);
    }
    for (const r of rows) {
      const tr = el('tr');
      r.forEach((v, i) => {
        const [text, cls] = Array.isArray(v) ? v : [v, ''];
        tr.append(el('td', `${headers[i][1] ? 'num' : ''} ${cls}`.trim(), String(text ?? '')));
      });
      tbody.append(tr);
    }
    t.replaceChildren(thead, tbody);
    if (foot) {
      const tf = el('tfoot');
      const tr = el('tr');
      foot.forEach((v, i) => tr.append(el('td', headers[i][1] ? 'num' : '', String(v ?? ''))));
      tf.append(tr);
      t.append(tf);
    }
  }

  function kpi(labelText, value, tone = '') {
    const box = el('div', `kpi ${tone}`);
    box.append(el('div', 'kpi-label', labelText), el('div', 'kpi-value', String(value)));
    return box;
  }

  async function loadSummary() {
    const r = range();
    const s = await api('/accounts/summary' + qs(r));
    $('acc-range-label').textContent =
      r.from || r.to ? `${r.from || 'start'} to ${r.to || 'today'} (India time)` : 'All time';

    $('acc-kpis').replaceChildren(
      kpi('Revenue (₹)', rupees(s.money.revenueInr), 'good'),
      kpi('Paid orders', n(s.money.orders)),
      kpi('Coins sold', coinsFmt(s.coins.bought)),
      kpi('Fees collected', coinsFmt(s.coins.feesTotal)),
      kpi('Prizes paid', coinsFmt(s.coins.tournamentPrizes)),
      kpi('Free coins given', coinsFmt(s.coins.granted + s.coins.bonuses)),
      kpi('Players hold now', coinsFmt(s.balances.players)),
      kpi('House holds now', coinsFmt(s.balances.house)),
    );

    // Books check (all time).
    const rc = s.reconciliation;
    const box = $('acc-recon');
    const grid = el('div', 'recon-grid');
    const cellBox = (v, t) => {
      const d = el('div');
      d.append(el('b', '', v), el('span', '', t));
      return d;
    };
    grid.append(
      cellBox(coinsFmt(rc.created), 'Coins created (bought + granted)'),
      cellBox(coinsFmt(rc.removed), 'Removed by admin'),
      cellBox(coinsFmt(rc.playerBalances), 'With players'),
      cellBox(coinsFmt(rc.houseBalance), 'With the house (fees)'),
      cellBox(coinsFmt(rc.inPlay), 'In live games / tournaments'),
    );
    const ok = rc.ledgerMatchesBalances && rc.inPlay >= 0;
    box.replaceChildren(el('p', ok ? 'recon-ok' : 'recon-warn', (ok ? '✓ ' : '⚠ ') + rc.note), grid);

    // Categories + reasons.
    last.cats = s.byReason.map((l) => [l.category, label(l.reason), l.kind, l.count, l.credits, l.debits, l.net]);
    table(
      'acc-cats',
      [['Category'], ['Type'], ['Account'], ['Lines', 1], ['Coins in', 1], ['Coins out', 1], ['Net', 1]],
      s.byReason.map((l) => [l.category, label(l.reason), l.kind, n(l.count), n(l.credits), n(l.debits), [n(l.net), l.net >= 0 ? 'pos' : 'neg']]),
    );

    last.daily = s.daily.map((d) => [d.day, d.revenueInr, d.orders, d.coinsBought, d.granted, d.fees, d.prizes]);
    const tot = s.daily.reduce(
      (a, d) => ({ r: a.r + d.revenueInr, o: a.o + d.orders, b: a.b + d.coinsBought, g: a.g + d.granted, f: a.f + d.fees, p: a.p + d.prizes }),
      { r: 0, o: 0, b: 0, g: 0, f: 0, p: 0 },
    );
    table(
      'acc-daily',
      [['Day'], ['Revenue ₹', 1], ['Orders', 1], ['Coins sold', 1], ['Free coins', 1], ['Fees', 1], ['Prizes', 1]],
      s.daily.map((d) => [d.day, rupees(d.revenueInr), n(d.orders), n(d.coinsBought), n(d.granted), n(d.fees), n(d.prizes)]),
      ['Total', rupees(tot.r), n(tot.o), n(tot.b), n(tot.g), n(tot.f), n(tot.p)],
    );

    // Reason filter options, from what actually exists.
    const sel = $('acc-l-reason');
    const current = sel.value;
    const reasons = [...new Set(s.byReason.map((l) => l.reason))].sort();
    sel.replaceChildren(new Option('All reasons', ''), ...reasons.map((r) => new Option(label(r), r)));
    sel.value = reasons.includes(current) ? current : '';
  }

  async function loadOrders() {
    const { orders } = await api('/accounts/orders' + qs(range()));
    last.orders = orders.map((o) => [new Date(o.createdAt).toISOString(), o.id, o.userId, o.name, o.packId, o.amountInr, o.coins, o.status, o.payPaymentId]);
    const paid = orders.filter((o) => o.status === 'credited');
    table(
      'acc-orders',
      [['When'], ['Player'], ['Pack'], ['Amount', 1], ['Coins', 1], ['Status'], ['Order ID']],
      orders.map((o) => [
        when(o.createdAt), o.name || o.userId, o.packId, rupees(o.amountInr), n(o.coins),
        [o.status, o.status === 'credited' ? 'pos' : o.status === 'pending' ? '' : 'neg'], o.id,
      ]),
      ['Paid total', '', '', rupees(paid.reduce((a, o) => a + o.amountInr, 0)), n(paid.reduce((a, o) => a + o.coins, 0)), `${paid.length} paid`, ''],
    );
  }

  async function loadLedger() {
    const filter = { ...range(), account: $('acc-l-account').value.trim(), reason: $('acc-l-reason').value };
    const page = await api('/accounts/ledger' + qs({ ...filter, limit: PAGE, offset: ledgerOffset }));
    table(
      'acc-ledger',
      [['When'], ['Account'], ['Type'], ['Change', 1], ['Balance after', 1], ['Ref']],
      page.rows.map((r) => [
        when(r.at), r.name ? `${r.name} (${r.account})` : r.account, label(r.reason),
        [(r.delta > 0 ? '+' : '') + n(r.delta), r.delta > 0 ? 'pos' : 'neg'], n(r.balanceAfter), r.refId || '',
      ]),
    );
    const from = page.total ? ledgerOffset + 1 : 0;
    $('acc-page').textContent = `${from}–${ledgerOffset + page.rows.length} of ${n(page.total)}`;
    $('acc-prev').disabled = ledgerOffset === 0;
    $('acc-next').disabled = ledgerOffset + page.rows.length >= page.total;
  }

  async function loadAudit() {
    const { entries } = await api('/audit?limit=500');
    last.audit = entries.map((e) => [new Date(e.at).toISOString(), e.actor, e.action, e.ip || '', e.detail ? JSON.stringify(e.detail) : '']);
    table(
      'acc-audit',
      [['When'], ['Who'], ['Action'], ['From IP'], ['Details']],
      entries.slice(0, 100).map((e) => [when(e.at), e.actor, e.action, e.ip || '', e.detail ? JSON.stringify(e.detail).slice(0, 120) : '']),
    );
  }

  async function loadAll() {
    ledgerOffset = 0;
    try {
      await Promise.all([loadSummary(), loadOrders(), loadLedger(), loadAudit()]);
    } catch (err) {
      msg(err.message, true);
    }
  }

  // ── CSV export ──
  function downloadCsv(name, headers, rows) {
    const esc = (v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [headers, ...rows].map((r) => r.map(esc).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    const a = el('a');
    a.href = url;
    const r = range();
    a.download = `coinludo-${name}-${r.from || 'start'}-to-${r.to || istDate()}.csv`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  $('acc-csv-cats').addEventListener('click', () =>
    downloadCsv('coin-flow', ['category', 'type', 'account', 'lines', 'coins_in', 'coins_out', 'net'], last.cats));
  $('acc-csv-daily').addEventListener('click', () =>
    downloadCsv('daily', ['day', 'revenue_inr', 'orders', 'coins_sold', 'free_coins', 'fees', 'prizes'], last.daily));
  $('acc-csv-orders').addEventListener('click', () =>
    downloadCsv('orders', ['created_at_utc', 'order_id', 'player_id', 'player_name', 'pack', 'amount_inr', 'coins', 'status', 'pay_payment_id'], last.orders));
  $('acc-csv-audit').addEventListener('click', () =>
    downloadCsv('admin-activity', ['at_utc', 'actor', 'action', 'ip', 'detail'], last.audit));
  // The full ledger for the period (every line, not just the visible page).
  $('acc-csv-ledger').addEventListener('click', async () => {
    try {
      const filter = { ...range(), account: $('acc-l-account').value.trim(), reason: $('acc-l-reason').value };
      const rows = [];
      for (let offset = 0; ; offset += 5000) {
        const page = await api('/accounts/ledger' + qs({ ...filter, limit: 5000, offset }));
        rows.push(...page.rows.map((r) => [new Date(r.at).toISOString(), r.id, r.account, r.name || '', r.reason, r.category, r.delta, r.balanceAfter, r.refId || '']));
        if (offset + page.rows.length >= page.total || !page.rows.length) break;
      }
      downloadCsv('ledger', ['at_utc', 'line_id', 'account', 'name', 'reason', 'category', 'delta', 'balance_after', 'ref'], rows);
    } catch (err) {
      msg(err.message, true);
    }
  });

  // ── wiring ──
  $('acc-preset').addEventListener('change', () => {
    if ($('acc-preset').value === 'custom') {
      $('acc-from').value ||= istDate(-29);
      $('acc-to').value ||= istDate();
    }
    loadAll();
  });
  $('acc-from').addEventListener('change', loadAll);
  $('acc-to').addEventListener('change', loadAll);
  $('acc-refresh').addEventListener('click', loadAll);
  $('acc-ledger-form').addEventListener('submit', (e) => {
    e.preventDefault();
    ledgerOffset = 0;
    loadLedger().catch((err) => msg(err.message, true));
  });
  $('acc-prev').addEventListener('click', () => {
    ledgerOffset = Math.max(0, ledgerOffset - PAGE);
    loadLedger().catch((err) => msg(err.message, true));
  });
  $('acc-next').addEventListener('click', () => {
    ledgerOffset += PAGE;
    loadLedger().catch((err) => msg(err.message, true));
  });
  // Load when the tab is opened (and each time it is reopened).
  document.querySelector('.tab[data-tab="accounts"]').addEventListener('click', loadAll);
})();
