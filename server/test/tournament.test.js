import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TournamentService, TournamentError } from '../src/tournament/TournamentService.js';
import { store } from '../src/db/store.js';
import { wallet } from '../src/wallet/Wallet.js';
import { champion } from '../src/tournament/bracket.js';

const svc = new TournamentService();
let n = 0;
// UTRs are validated as 12 digits and must be unique across every claim ever.
let utrSeq = 100000000000;
const utr12 = () => String(++utrSeq);
const mkUser = async (tag, coins = 0) => {
  const u = await store.createUser({ provider: 'dev', providerId: `t-${tag}-${n++}`, name: tag });
  if (coins) await wallet.credit(u.id, coins, 'seed');
  return u;
};

test('creating a tournament validates its settings', async () => {
  await assert.rejects(() => svc.create({ title: '' }), (e) => e.code === 'BAD_TITLE');
  await assert.rejects(() => svc.create({ title: 'x', maxPlayers: 5 }), (e) => e.code === 'BAD_SIZE');
  await assert.rejects(() => svc.create({ title: 'x', entryType: 'coins', entryFeeCoins: 0 }), (e) => e.code === 'BAD_FEE');
  await assert.rejects(() => svc.create({ title: 'x', entryType: 'bitcoin' }), (e) => e.code === 'BAD_ENTRY_TYPE');

  const t = await svc.create({ title: 'Sunday Cup', entryType: 'manual', entryFeeInr: 50, maxPlayers: 4 });
  assert.equal(t.status, 'open');
  assert.equal(t.entryFeeInr, 50);
});

test('MANUAL entry: admin adds a player after confirming an off-app payment', async () => {
  const t = await svc.create({ title: 'UPI Cup', entryType: 'manual', entryFeeInr: 100, maxPlayers: 4 });
  const p = await mkUser('upi-player');

  const entry = await svc.addEntryManually(t.id, p.id, { paymentRef: 'UTR12345', addedBy: 'admin' });
  assert.equal(entry.paymentRef, 'UTR12345', 'the payment reference is kept as an audit trail');

  const { entries } = await svc.detail(t.id);
  assert.equal(entries.length, 1);
  // No coins move for a manual tournament — money was handled outside the app.
  assert.equal(await wallet.getBalance(p.id), 0);

  await assert.rejects(() => svc.addEntryManually(t.id, p.id, {}), (e) => e.code === 'ALREADY_ENTERED');
  await assert.rejects(() => svc.addEntryManually(t.id, 'ghost', {}), (e) => e.code === 'NO_USER');
});

test('COIN entry: the fee is debited, and refunded if the player withdraws', async () => {
  const t = await svc.create({ title: 'Coin Cup', entryType: 'coins', entryFeeCoins: 200, maxPlayers: 4 });
  const rich = await mkUser('rich', 1000);
  const broke = await mkUser('broke', 50);

  await svc.joinWithCoins(rich, t.id);
  assert.equal(await wallet.getBalance(rich.id), 800, 'entry fee debited');

  await assert.rejects(() => svc.joinWithCoins(broke, t.id), (e) => e.code === 'INSUFFICIENT_FUNDS');

  await svc.removeEntry(t.id, rich.id);
  assert.equal(await wallet.getBalance(rich.id), 1000, 'withdrawing before the start refunds the fee');
});

test('a manual tournament refuses self-service coin joins', async () => {
  const t = await svc.create({ title: 'Manual only', entryType: 'manual', maxPlayers: 4 });
  const p = await mkUser('sneaky', 1000);
  await assert.rejects(() => svc.joinWithCoins(p, t.id), (e) => e.code === 'WRONG_ENTRY_TYPE');
});

test('a tournament fills up and locks', async () => {
  const t = await svc.create({ title: 'Small', entryType: 'manual', maxPlayers: 2 });
  const a = await mkUser('a');
  const b = await mkUser('b');
  const c = await mkUser('c');
  await svc.addEntryManually(t.id, a.id, {});
  await svc.addEntryManually(t.id, b.id, {});
  await assert.rejects(() => svc.addEntryManually(t.id, c.id, {}), (e) => e.code === 'FULL');

  await svc.start(t.id);
  await assert.rejects(() => svc.addEntryManually(t.id, c.id, {}), (e) => e.code === 'NOT_OPEN');
});

test('a 4-player tournament runs to a champion and pays the coin prize', async () => {
  const t = await svc.create({ title: 'Champs', entryType: 'manual', maxPlayers: 4, prizeCoins: 5000 });
  const players = [];
  for (const tag of ['w', 'x', 'y', 'z']) players.push(await mkUser(tag));
  for (const p of players) await svc.addEntryManually(t.id, p.id, { paymentRef: 'upi' });

  let detail = await svc.start(t.id);
  assert.equal(detail.tournament.status, 'running');
  assert.equal(detail.playing.length, 2, 'both semi-finals playable');

  // Play the semis, then the final.
  for (const m of detail.playing) await svc.recordResult(t.id, m.id, m.a);
  detail = await svc.detail(t.id);
  assert.equal(detail.playing.length, 1, 'final is next');

  const final = detail.playing[0];
  const winner = final.a;
  detail = await svc.recordResult(t.id, final.id, winner);

  assert.equal(detail.tournament.status, 'finished');
  assert.equal(detail.tournament.winnerId, winner);
  assert.equal(champion(detail.tournament.bracket), winner);
  assert.equal(await wallet.getBalance(winner), 5000, 'coin prize paid to the champion');
});

test('results are rejected for matches that are not live', async () => {
  const t = await svc.create({ title: 'Guarded', entryType: 'manual', maxPlayers: 4 });
  const ps = [];
  for (const tag of ['g1', 'g2', 'g3', 'g4']) ps.push(await mkUser(tag));
  for (const p of ps) await svc.addEntryManually(t.id, p.id, {});
  const detail = await svc.start(t.id);
  const m = detail.playing[0];

  // A player who isn't in that match can't be declared the winner.
  const outsider = detail.playing[1].a;
  await assert.rejects(() => svc.recordResult(t.id, m.id, outsider), (e) => e.code === 'BAD_RESULT');
  // Nor can a result be recorded twice.
  await svc.recordResult(t.id, m.id, m.a);
  await assert.rejects(() => svc.recordResult(t.id, m.id, m.b), (e) => e.code === 'BAD_RESULT');
});

test('cancelling refunds coin entries', async () => {
  const t = await svc.create({ title: 'Cancelled', entryType: 'coins', entryFeeCoins: 300, maxPlayers: 4 });
  const p = await mkUser('refundee', 1000);
  await svc.joinWithCoins(p, t.id);
  assert.equal(await wallet.getBalance(p.id), 700);

  const after = await svc.cancel(t.id);
  assert.equal(after.status, 'cancelled');
  assert.equal(await wallet.getBalance(p.id), 1000, 'entry fee returned');
});

test('starting needs at least two players', async () => {
  const t = await svc.create({ title: 'Lonely', entryType: 'manual', maxPlayers: 4 });
  const solo = await mkUser('solo');
  await svc.addEntryManually(t.id, solo.id, {});
  await assert.rejects(() => svc.start(t.id), (e) => e.code === 'TOO_FEW');
});

test('deleting is refused while a tournament is still live, allowed once it is over', async () => {
  const t = await svc.create({ title: 'Delete Me', entryType: 'manual', maxPlayers: 4 });
  const a = await mkUser('del-a');
  await svc.addEntryManually(t.id, a.id, { paymentRef: 'ref-1' });

  // Still open and holding a seat — deleting must not become a way to skip refunds.
  await assert.rejects(() => svc.remove(t.id), (e) => e.code === 'NOT_TERMINAL');
  assert.ok(await store.getTournament(t.id), 'tournament survives the refused delete');

  await svc.cancel(t.id);
  const res = await svc.remove(t.id);
  assert.equal(res.deleted, true);
  assert.equal(await store.getTournament(t.id), null, 'tournament is gone');
  assert.equal((await store.listTournamentEntries(t.id)).length, 0, 'entries are gone too');
});

test('deleting is refused while a payment claim is still awaiting review', async () => {
  const t = await svc.create({ title: 'Claim Guard', entryType: 'manual', entryFeeInr: 100, maxPlayers: 4 });
  const u = await mkUser('del-claim');
  await svc.submitClaim(u, t.id, { utr: utr12() });
  await svc.cancel(t.id);

  await assert.rejects(() => svc.remove(t.id), (e) => e.code === 'PENDING_CLAIMS');
  assert.ok(await store.getTournament(t.id), 'a pending "I paid you" keeps the tournament alive');
});

test('a deleted tournament keeps its payment claims as an audit trail', async () => {
  const t = await svc.create({ title: 'Audit Cup', entryType: 'manual', entryFeeInr: 100, maxPlayers: 4 });
  const u = await mkUser('del-audit');
  const utr = utr12();
  const claim = await svc.submitClaim(u, t.id, { utr });
  await svc.rejectClaim(claim.id, { reason: 'test' });
  await svc.cancel(t.id);
  await svc.remove(t.id);

  const claims = await store.listClaims({ tournamentId: t.id });
  assert.equal(claims.length, 1, 'the payment record outlives the tournament');
  assert.equal(claims[0].utr, utr);
});
