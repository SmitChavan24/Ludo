import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TournamentService } from '../src/tournament/TournamentService.js';
import { store } from '../src/db/store.js';
import { wallet, HOUSE_ACCOUNT } from '../src/wallet/Wallet.js';
import * as accounts from '../src/accounts/Accounts.js';

// This file runs in its own process, so the in-memory ledger starts empty and
// every figure below is exact.
const svc = new TournamentService();
let n = 0;
const mkUser = async (tag) => store.createUser({ provider: 'dev', providerId: `acc-${tag}-${n++}`, name: tag });

test('a coin tournament pays prizes, sends the cut to the house, and the books balance', async () => {
  const players = [];
  for (const tag of ['a', 'b', 'c', 'd']) {
    const u = await mkUser(tag);
    await wallet.credit(u.id, 100, 'coin_purchase', `order-${tag}`); // bought 100 coins each
    players.push(u);
  }

  // 4 players × 100 coins, 10% cut, 70/30 split.
  const t = await svc.create({
    title: 'Books Cup', entryType: 'coins', entryFeeCoins: 100, maxPlayers: 4, rakeBips: 1000, payoutSplit: [70, 30],
  });
  for (const p of players) await svc.joinWithCoins(p, t.id);

  // Mid-tournament: the 400 entry coins are "in play", not lost.
  let rec = await accounts.reconciliation();
  assert.equal(rec.outstanding, 400);
  assert.equal(rec.inPlay, 400);

  let detail = await svc.start(t.id);
  for (const m of detail.playing) await svc.recordResult(t.id, m.id, m.a);
  detail = await svc.detail(t.id);
  await svc.recordResult(t.id, detail.playing[0].id, detail.playing[0].a);

  // Pool = 400 - 40 cut = 360 → 252 / 108. The house gets everything not paid out.
  assert.equal(await wallet.getBalance(HOUSE_ACCOUNT), 40);
  const balances = await Promise.all(players.map((p) => wallet.getBalance(p.id)));
  assert.deepEqual(balances.sort((x, y) => y - x), [252, 108, 0, 0]);

  rec = await accounts.reconciliation();
  assert.equal(rec.inPlay, 0, rec.note);
  assert.equal(rec.playerBalances + rec.houseBalance, 400);
  assert.ok(rec.ledgerMatchesBalances);

  const s = await accounts.summary({});
  assert.equal(s.coins.bought, 400);
  assert.equal(s.coins.tournamentFees, 40);
  assert.equal(s.coins.tournamentPrizes, 360);
  assert.equal(s.balances.house, 40);
  const fees = s.byCategory.find((c) => c.category === 'Tournament fees');
  assert.equal(fees.credits, 40);
});

test('admin grants and removals are categorised and counted in reconciliation', async () => {
  const u = await mkUser('g');
  const before = await accounts.reconciliation();
  await wallet.credit(u.id, 50, 'admin_test_grant');
  await wallet.debit(u.id, 20, 'crm_adjust');
  const after = await accounts.reconciliation();
  assert.equal(after.created - before.created, 50);
  assert.equal(after.removed - before.removed, 20);
  assert.equal(after.inPlay, before.inPlay);
});

test('the ledger page lists lines newest first with names and categories', async () => {
  const page = await accounts.ledgerPage({}, { limit: 5 });
  assert.ok(page.total > 5);
  assert.equal(page.rows.length, 5);
  assert.ok(page.rows[0].at >= page.rows[4].at);
  assert.ok(page.rows.every((r) => r.category));
  const house = await accounts.ledgerPage({}, { account: HOUSE_ACCOUNT });
  assert.equal(house.rows[0].name, 'House');
  assert.equal(house.rows[0].reason, 'tournament_rake');
});

test('date ranges are India calendar days, end date inclusive', () => {
  const r = accounts.parseRange({ from: '2026-11-17', to: '2026-11-17' });
  assert.equal(r.since, Date.parse('2026-11-16T18:30:00Z'));
  assert.equal(r.until - r.since, 86_400_000);
  assert.deepEqual(accounts.parseRange({}), { since: null, until: null });
  assert.deepEqual(accounts.parseRange({ from: 'junk' }), { since: null, until: null });
});
