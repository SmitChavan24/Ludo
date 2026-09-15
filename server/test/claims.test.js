import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TournamentService } from '../src/tournament/TournamentService.js';
import { store } from '../src/db/store.js';
import { normalizeUtr, isValidUtr, upiPayLink } from '../src/util/payments.js';

const svc = new TournamentService();
let n = 0;
const mkUser = async (tag) => store.createUser({ provider: 'dev', providerId: `c-${tag}-${n++}`, name: tag });
const mkT = (over = {}) => svc.create({ title: 'Cup', entryType: 'manual', entryFeeInr: 100, maxPlayers: 4, ...over });

test('UTR normalisation defeats cosmetic differences', () => {
  // These are all the SAME payment typed differently — they must collide.
  assert.equal(normalizeUtr(' 1234 5678 9012 '), '123456789012');
  assert.equal(normalizeUtr('utr-123456789012'), 'UTR123456789012');
  assert.equal(normalizeUtr('abc123'), 'ABC123');
  assert.equal(isValidUtr('123456789012'), true);
  assert.equal(isValidUtr('12345'), false, 'too short');
  assert.equal(isValidUtr('!!!!!!!!'), false, 'not alphanumeric');
  assert.equal(isValidUtr(''), false);
});

test('a UPI pay link carries payee, amount and our reference', () => {
  const link = upiPayLink({ upiId: 'me@upi', upiName: 'CoinLudo', amountInr: 100, note: 'Entry Cup', ref: 't1-u1' });
  assert.match(link, /^upi:\/\/pay\?/);
  assert.match(link, /pa=me%40upi/);
  assert.match(link, /am=100/);
  assert.match(link, /tr=t1-u1/);
  assert.equal(upiPayLink({ upiId: '' }), null, 'no UPI id configured -> no link');
});

test('a player submits a claim, which does NOT grant entry by itself', async () => {
  const t = await mkT();
  const p = await mkUser('claimer');
  const claim = await svc.submitClaim(p, t.id, { utr: '111111111111' });

  assert.equal(claim.status, 'pending');
  assert.equal(claim.amountInr, 100, 'defaults to the tournament entry fee');
  const { entries } = await svc.detail(t.id);
  assert.equal(entries.length, 0, 'no entry until an admin approves');
});

test('the same UTR can never be used twice — even by a different player', async () => {
  const t1 = await mkT();
  const t2 = await mkT();
  const a = await mkUser('utr-a');
  const b = await mkUser('utr-b');

  await svc.submitClaim(a, t1.id, { utr: '222222222222' });

  // Same person, different tournament, same transaction → blocked.
  await assert.rejects(() => svc.submitClaim(a, t2.id, { utr: '222222222222' }), (e) => e.code === 'DUPLICATE_UTR');
  // Different person reusing someone else's reference → blocked.
  await assert.rejects(() => svc.submitClaim(b, t2.id, { utr: '222222222222' }), (e) => e.code === 'DUPLICATE_UTR');
  // And blocked even when disguised with spaces/dashes/case.
  await assert.rejects(() => svc.submitClaim(b, t2.id, { utr: ' 2222-2222 2222 ' }), (e) => e.code === 'DUPLICATE_UTR');
});

test('a player cannot stack multiple live claims on one tournament', async () => {
  const t = await mkT();
  const p = await mkUser('spammer');
  await svc.submitClaim(p, t.id, { utr: '333333333333' });
  await assert.rejects(() => svc.submitClaim(p, t.id, { utr: '444444444444' }), (e) => e.code === 'CLAIM_PENDING');
});

test('a rejected claim lets the player resubmit a corrected reference', async () => {
  const t = await mkT();
  const p = await mkUser('typo');
  const bad = await svc.submitClaim(p, t.id, { utr: '555555555555' });
  await svc.rejectClaim(bad.id, { reason: 'No payment found with that UTR' });

  const good = await svc.submitClaim(p, t.id, { utr: '666666666666' });
  assert.equal(good.status, 'pending');
  // The rejected reference stays burned, so it can't be recycled.
  const other = await mkUser('recycler');
  await assert.rejects(() => svc.submitClaim(other, t.id, { utr: '555555555555' }), (e) => e.code === 'DUPLICATE_UTR');
});

test('approving a claim grants the entry and records the UTR as the payment ref', async () => {
  const t = await mkT();
  const p = await mkUser('payer');
  const claim = await svc.submitClaim(p, t.id, { utr: '777777777777' });

  const { claim: approved, entry } = await svc.approveClaim(claim.id, { reviewedBy: 'admin', note: 'seen in statement' });
  assert.equal(approved.status, 'approved');
  assert.equal(approved.reviewedBy, 'admin');
  assert.ok(approved.reviewedAt);
  assert.equal(entry.paymentRef, '777777777777', 'the UTR becomes the entry audit trail');

  const { entries } = await svc.detail(t.id);
  assert.equal(entries.length, 1);
});

test('a claim can only be reviewed once', async () => {
  const t = await mkT();
  const p = await mkUser('once');
  const claim = await svc.submitClaim(p, t.id, { utr: '888888888888' });
  await svc.approveClaim(claim.id, {});

  await assert.rejects(() => svc.approveClaim(claim.id, {}), (e) => e.code === 'ALREADY_REVIEWED');
  await assert.rejects(() => svc.rejectClaim(claim.id, {}), (e) => e.code === 'ALREADY_REVIEWED');
});

test('approval re-checks capacity — a claim queued while the event filled is refused', async () => {
  const t = await mkT({ maxPlayers: 2 });
  const a = await mkUser('cap-a');
  const b = await mkUser('cap-b');
  const late = await mkUser('cap-late');

  const lateClaim = await svc.submitClaim(late, t.id, { utr: '999999999999' });
  // Meanwhile the tournament fills up by other means.
  await svc.addEntryManually(t.id, a.id, {});
  await svc.addEntryManually(t.id, b.id, {});

  await assert.rejects(() => svc.approveClaim(lateClaim.id, {}), (e) => e.code === 'FULL');
});

test('claims are refused once the tournament is no longer open', async () => {
  const t = await mkT();
  const a = await mkUser('st-a');
  const b = await mkUser('st-b');
  await svc.addEntryManually(t.id, a.id, {});
  await svc.addEntryManually(t.id, b.id, {});
  await svc.start(t.id);

  const late = await mkUser('st-late');
  await assert.rejects(() => svc.submitClaim(late, t.id, { utr: '101010101010' }), (e) => e.code === 'NOT_OPEN');
});

test('garbage references are rejected before they reach the review queue', async () => {
  const t = await mkT();
  const p = await mkUser('junk');
  for (const utr of ['', '   ', '123', 'no!!', null, undefined]) {
    await assert.rejects(() => svc.submitClaim(p, t.id, { utr }), (e) => e.code === 'BAD_UTR');
  }
});

test('coin tournaments do not accept payment claims', async () => {
  const t = await svc.create({ title: 'Coins', entryType: 'coins', entryFeeCoins: 100, maxPlayers: 4 });
  const p = await mkUser('wrongtype');
  await assert.rejects(() => svc.submitClaim(p, t.id, { utr: '121212121212' }), (e) => e.code === 'WRONG_ENTRY_TYPE');
});

test('an already-entered player cannot submit a claim', async () => {
  const t = await mkT();
  const p = await mkUser('dupe-entry');
  await svc.addEntryManually(t.id, p.id, {});
  await assert.rejects(() => svc.submitClaim(p, t.id, { utr: '131313131313' }), (e) => e.code === 'ALREADY_ENTERED');
});

test('the review queue lists oldest first and filters by status', async () => {
  const t = await mkT({ maxPlayers: 8 });
  const ids = [];
  for (const tag of ['q1', 'q2', 'q3']) {
    const u = await mkUser(tag);
    const c = await svc.submitClaim(u, t.id, { utr: `20${tag}0000000` });
    ids.push(c.id);
  }
  await svc.rejectClaim(ids[1], { reason: 'not found' });

  const pending = await svc.listClaims({ status: 'pending', tournamentId: t.id });
  assert.equal(pending.length, 2);
  assert.equal(pending[0].id, ids[0], 'oldest claim is first in the queue');
  assert.ok(pending[0].userName, 'queue shows who is asking');

  const rejected = await svc.listClaims({ status: 'rejected', tournamentId: t.id });
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reviewNote, 'not found');
});
