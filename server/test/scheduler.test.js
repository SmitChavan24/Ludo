import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TournamentScheduler } from '../src/tournament/scheduler.js';
import { tournaments } from '../src/tournament/TournamentService.js';
import { store } from '../src/db/store.js';
import { wallet } from '../src/wallet/Wallet.js';

const sched = new TournamentScheduler();
let n = 0;
const mkUser = async (tag, coins = 0) => {
  const u = await store.createUser({ provider: 'dev', providerId: `s-${tag}-${n++}`, name: tag });
  if (coins) await wallet.credit(u.id, coins, 'seed');
  return u;
};

test('a tournament whose time has come starts by itself', async () => {
  const t = await tournaments.create({
    title: 'Auto 8pm', entryType: 'manual', entryFeeInr: 100, maxPlayers: 4,
    startsAt: Date.now() - 1000, // due a second ago
  });
  for (const tag of ['a1', 'a2', 'a3']) {
    const u = await mkUser(tag);
    await tournaments.addEntryManually(t.id, u.id, { paymentRef: 'x' + n });
  }

  const actions = await sched.tick();
  const mine = actions.find((a) => a.id === t.id);
  assert.equal(mine?.type, 'started');
  assert.equal(mine.players, 3);
  assert.equal((await tournaments.get(t.id)).status, 'running');
});

test('a tournament nobody joined is cancelled instead of hanging open', async () => {
  const t = await tournaments.create({
    title: 'Nobody came', entryType: 'coins', entryFeeCoins: 100, maxPlayers: 4,
    startsAt: Date.now() - 1000,
  });
  const solo = await mkUser('lonely', 500);
  await tournaments.joinWithCoins(solo, t.id);
  assert.equal(await wallet.getBalance(solo.id), 400);

  const actions = await sched.tick();
  const mine = actions.find((a) => a.id === t.id);
  assert.equal(mine?.type, 'cancelled');
  assert.equal((await tournaments.get(t.id)).status, 'cancelled');
  assert.equal(await wallet.getBalance(solo.id), 500, 'coin entry refunded automatically');
});

test('a cancelled MANUAL tournament lists who you must refund by hand', async () => {
  const t = await tournaments.create({
    title: 'Manual refund', entryType: 'manual', entryFeeInr: 100, maxPlayers: 4,
    startsAt: Date.now() - 1000,
  });
  const u = await mkUser('needs-refund');
  await tournaments.addEntryManually(t.id, u.id, { paymentRef: 'UTR-REFUND-ME' });

  const actions = await sched.tick();
  const mine = actions.find((a) => a.id === t.id);
  assert.equal(mine.type, 'cancelled');
  assert.equal(mine.refundManually.length, 1, 'real money can only be returned by you');
  assert.equal(mine.refundManually[0].paymentRef, 'UTR-REFUND-ME');
});

test('a tournament far in the future is left alone', async () => {
  // Well beyond the lobby window, so nothing should happen yet.
  const t = await tournaments.create({
    title: 'Later', entryType: 'manual', maxPlayers: 4,
    startsAt: Date.now() + 60 * 60_000, lobbyMinutes: 10,
  });
  for (const tag of ['l1', 'l2']) {
    const u = await mkUser(tag);
    await tournaments.addEntryManually(t.id, u.id, {});
  }
  const actions = await sched.tick();
  assert.equal(actions.find((a) => a.id === t.id), undefined);
  assert.equal((await tournaments.get(t.id)).status, 'open');
});

test('the lobby opens before the start, closing entries', async () => {
  // Starts in 5 minutes with a 10-minute lobby → the lobby is due now.
  const t = await tournaments.create({
    title: 'Lobby test', entryType: 'manual', entryFeeInr: 100, maxPlayers: 4,
    startsAt: Date.now() + 5 * 60_000, lobbyMinutes: 10,
  });
  const players = [];
  for (const tag of ['lb1', 'lb2']) {
    const u = await mkUser(tag);
    players.push(u);
    await tournaments.addEntryManually(t.id, u.id, {});
  }

  const actions = await sched.tick();
  assert.equal(actions.find((a) => a.id === t.id)?.type, 'lobby');
  assert.equal((await tournaments.get(t.id)).status, 'lobby');

  // Entries are closed during the lobby — nobody can slip in late.
  const late = await mkUser('lb-late');
  await assert.rejects(() => tournaments.addEntryManually(t.id, late.id, {}), (e) => e.code === 'NOT_OPEN');
  await assert.rejects(() => tournaments.submitClaim(late, t.id, { utr: '505050505050' }), (e) => e.code === 'NOT_OPEN');

  // It is NOT started yet — that waits for the actual start time.
  assert.equal((await tournaments.get(t.id)).status, 'lobby');
});

test('a tournament in its lobby starts when the time comes', async () => {
  const t = await tournaments.create({
    title: 'Lobby then go', entryType: 'manual', maxPlayers: 4,
    startsAt: Date.now() - 1000, lobbyMinutes: 10,
  });
  for (const tag of ['lg1', 'lg2']) {
    const u = await mkUser(tag);
    await tournaments.addEntryManually(t.id, u.id, {});
  }
  await tournaments.openLobby(t.id);
  assert.equal((await tournaments.get(t.id)).status, 'lobby');

  const actions = await sched.tick();
  assert.equal(actions.find((a) => a.id === t.id)?.type, 'started');
  assert.equal((await tournaments.get(t.id)).status, 'running');
});

test('lobbyOpensAt is derived from the start time', async () => {
  const startsAt = Date.now() + 60 * 60_000;
  const t = await tournaments.create({
    title: 'Derived', entryType: 'manual', maxPlayers: 4, startsAt, lobbyMinutes: 15,
  });
  assert.equal(t.lobbyOpensAt, startsAt - 15 * 60_000);
});

test('autoStart:false means it waits for you', async () => {
  const t = await tournaments.create({
    title: 'Manual start', entryType: 'manual', maxPlayers: 4,
    startsAt: Date.now() - 1000, autoStart: false,
  });
  for (const tag of ['m1', 'm2']) {
    const u = await mkUser(tag);
    await tournaments.addEntryManually(t.id, u.id, {});
  }
  const actions = await sched.tick();
  assert.equal(actions.find((a) => a.id === t.id), undefined);
  assert.equal((await tournaments.get(t.id)).status, 'open');
});

test('ticks never overlap', async () => {
  const s2 = new TournamentScheduler();
  s2.running = true; // pretend a tick is in flight
  assert.deepEqual(await s2.tick(), []);
});
