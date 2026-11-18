import { wallet } from '../wallet/Wallet.js';
import { store } from '../db/store.js';

// ──────────────────────────────────────────────────────────────────────────
// Accounts — the books, for the admin "Accounts" tab.
//
// Two separate things are reported, and never mixed:
//   • MONEY (₹): what players paid for coin packs. The only real money.
//   • COINS: every coin movement in the ledger, grouped into categories.
//
// The ledger is append-only, so every figure here can be traced back to the
// individual lines that make it up (see listLedger / CSV export).
// ──────────────────────────────────────────────────────────────────────────

// Each ledger reason → a bookkeeping category. `side` says which way coins move
// from the players' point of view: 'in' = coins created for players, 'out' =
// coins removed from players for good, 'play' = coins moving between players
// and games (stakes in, winnings back out), 'fee' = the house's cut.
const CATEGORY_OF = [
  [/^coin_purchase$/, 'Coins bought'],
  [/^(crm_topup|crm:.*|admin_test_grant)$/, 'Admin grants'],
  [/^(signup_bonus|daily_bonus|referral_bonus|referral_reward)$/, 'Bonuses'],
  [/^(game_stake|game_win|game_refund)$/, 'Matches'],
  [/^(tournament_entry|tournament_prize|tournament_refund)$/, 'Tournaments'],
  [/^rake$/, 'Match fees'],
  [/^tournament_rake$/, 'Tournament fees'],
  [/^crm_adjust$/, 'Admin removals'],
];

export function categoryOf(reason, kind) {
  if (kind === 'cash') return 'Cash (disabled)';
  // Admin debits use the crm: tag too; the debit side makes them removals.
  for (const [re, name] of CATEGORY_OF) if (re.test(reason || '')) return name;
  return 'Other';
}

const DAY = 86_400_000;
const IST = 19_800_000; // UTC+5:30

// Parse ?from=YYYY-MM-DD&to=YYYY-MM-DD (India dates, `to` inclusive) into
// [since, until) millisecond bounds. Missing = open-ended.
export function parseRange({ from, to } = {}) {
  const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? Date.parse(`${v}T00:00:00Z`) - IST : null);
  const since = day(from);
  const end = day(to);
  return { since, until: end != null ? end + DAY : null };
}

export async function summary(range) {
  const [lines, daily, balances, orders] = await Promise.all([
    wallet.ledgerSummary(range),
    wallet.ledgerDaily(range),
    wallet.balanceTotals(),
    store.listCoinOrders({ since: range.since, until: range.until, limit: 10000 }),
  ]);

  // ── coins, by reason and by category ──
  const byReason = lines
    .map((l) => ({ ...l, category: categoryOf(l.reason, l.kind), net: l.credits - l.debits }))
    .sort((a, b) => a.category.localeCompare(b.category) || a.reason.localeCompare(b.reason));

  const cat = {};
  for (const l of byReason) {
    const c = (cat[l.category] ||= { category: l.category, count: 0, credits: 0, debits: 0 });
    c.count += l.count;
    c.credits += l.credits;
    c.debits += l.debits;
  }
  const byCategory = Object.values(cat).map((c) => ({ ...c, net: c.credits - c.debits }));
  const get = (name) => cat[name] || { credits: 0, debits: 0 };

  const coins = {
    bought: get('Coins bought').credits,
    granted: get('Admin grants').credits - get('Admin grants').debits,
    bonuses: get('Bonuses').credits,
    removedByAdmin: get('Admin removals').debits,
    matchFees: get('Match fees').credits,
    tournamentFees: get('Tournament fees').credits,
    tournamentPrizes: lines.filter((l) => l.reason === 'tournament_prize' && l.kind === 'player').reduce((a, l) => a + l.credits, 0),
    matchWinnings: lines.filter((l) => l.reason === 'game_win').reduce((a, l) => a + l.credits, 0),
  };
  coins.feesTotal = coins.matchFees + coins.tournamentFees;

  // ── money (₹) from the coin shop ──
  const credited = orders.filter((o) => o.status === 'credited');
  const byPack = {};
  for (const o of credited) {
    const p = (byPack[o.packId] ||= { packId: o.packId, orders: 0, revenueInr: 0, coins: 0 });
    p.orders += 1;
    p.revenueInr += o.amountInr;
    p.coins += o.coins;
  }
  const byStatus = {};
  for (const o of orders) byStatus[o.status] = (byStatus[o.status] || 0) + 1;

  const dailyMoney = {};
  for (const o of credited) {
    const d = new Date(o.createdAt + IST).toISOString().slice(0, 10);
    const row = (dailyMoney[d] ||= { revenueInr: 0, orders: 0 });
    row.revenueInr += o.amountInr;
    row.orders += 1;
  }

  // ── per-day table ──
  const days = {};
  for (const l of daily) {
    const row = (days[l.day] ||= { day: l.day, coinsBought: 0, granted: 0, fees: 0, prizes: 0 });
    const c = categoryOf(l.reason, l.kind);
    if (c === 'Coins bought') row.coinsBought += l.credits;
    else if (c === 'Admin grants' || c === 'Bonuses') row.granted += l.credits - l.debits;
    else if (c === 'Match fees' || c === 'Tournament fees') row.fees += l.credits;
    else if (l.reason === 'tournament_prize' && l.kind === 'player') row.prizes += l.credits;
  }
  for (const [d, m] of Object.entries(dailyMoney)) {
    (days[d] ||= { day: d, coinsBought: 0, granted: 0, fees: 0, prizes: 0 });
    Object.assign(days[d], m);
  }
  const dailyRows = Object.values(days)
    .map((r) => ({ revenueInr: 0, orders: 0, ...r }))
    .sort((a, b) => (a.day < b.day ? 1 : -1));

  return {
    range: { since: range.since, until: range.until },
    money: {
      revenueInr: credited.reduce((a, o) => a + o.amountInr, 0),
      orders: credited.length,
      coinsSold: credited.reduce((a, o) => a + o.coins, 0),
      byPack: Object.values(byPack),
      byStatus,
    },
    coins,
    byCategory,
    byReason,
    daily: dailyRows,
    balances, // right now, not limited to the range
  };
}

// The books balance when every coin ever created is either in a player's
// balance, in the house, or held in a game/tournament that hasn't finished.
// Always computed over ALL time (a date range can't balance on its own).
export async function reconciliation() {
  const [lines, balances] = await Promise.all([wallet.ledgerSummary({}), wallet.balanceTotals()]);
  let created = 0;
  let removed = 0;
  let net = 0;
  for (const l of lines) {
    if (l.kind === 'cash') continue;
    const c = categoryOf(l.reason, l.kind);
    if (c === 'Coins bought' || c === 'Admin grants' || c === 'Bonuses') {
      created += l.credits;
      removed += l.debits; // admin grant reversals, if any
    } else if (c === 'Admin removals') {
      removed += l.debits;
    }
    net += l.credits - l.debits;
  }
  // net (sum of every ledger delta) == players + house, by construction of the
  // ledger. What remains of the created coins is "in play": staked in a live
  // match or paid into a tournament that hasn't finished yet.
  const outstanding = created - removed;
  const held = balances.players + balances.house;
  const inPlay = outstanding - held;
  return {
    created,
    removed,
    outstanding,
    playerBalances: balances.players,
    houseBalance: balances.house,
    inPlay,
    ledgerMatchesBalances: net === held,
    note:
      inPlay === 0
        ? 'Balanced: every coin is with a player or the house.'
        : inPlay > 0
          ? `${inPlay} coins are in live matches or unfinished tournaments. This returns to 0 when they finish.`
          : `${-inPlay} more coins exist than were created. Investigate.`,
  };
}

export async function ledgerPage(range, { account = null, reason = null, limit = 100, offset = 0 } = {}) {
  const page = await wallet.listLedger({ ...range, accountId: account || null, reason: reason || null, limit, offset });
  const names = await namesFor(page.rows.map((r) => r.account));
  return { ...page, rows: page.rows.map((r) => ({ ...r, name: names[r.account] ?? null, category: categoryOf(r.reason, r.account === '__house__' ? 'house' : 'player') })) };
}

export async function ordersPage(range, { status = null, limit = 500 } = {}) {
  const orders = await store.listCoinOrders({ since: range.since, until: range.until, status: status || null, limit });
  const names = await namesFor(orders.map((o) => o.userId));
  return orders.map((o) => ({ ...o, name: names[o.userId] ?? null }));
}

async function namesFor(ids) {
  const out = {};
  for (const id of new Set(ids)) {
    if (!id || id === '__house__') {
      out[id] = id === '__house__' ? 'House' : null;
      continue;
    }
    const u = await store.getUser(id).catch(() => null);
    out[id] = u?.name ?? null;
  }
  return out;
}
