import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePot, computePayouts, financials, validateSplit, validateRake, prizeAwards } from '../src/tournament/economics.js';

test('the pot is entry fee times players, minus your cut', () => {
  // 8 players × ₹100 = ₹800 gross, 10% cut = ₹80, prize pool ₹720
  const p = computePot({ entryFeeInr: 100, players: 8, rakeBips: 1000 });
  assert.deepEqual(p, { gross: 800, rake: 80, prizePool: 720, players: 8, entryFeeInr: 100 });
});

test('an empty tournament has an empty pot', () => {
  assert.deepEqual(computePot({ entryFeeInr: 100, players: 0, rakeBips: 500 }),
    { gross: 0, rake: 0, prizePool: 0, players: 0, entryFeeInr: 100 });
});

test('your cut always rounds DOWN, so players are never short-changed', () => {
  // ₹250 gross at 7.5% = ₹18.75 → you take ₹18, players get ₹232
  const p = computePot({ entryFeeInr: 50, players: 5, rakeBips: 750 });
  assert.equal(p.rake, 18);
  assert.equal(p.prizePool, 232);
  assert.equal(p.rake + p.prizePool, p.gross, 'nothing vanishes');
});

test('payouts always sum exactly back to the prize pool', () => {
  for (const pool of [0, 1, 7, 99, 100, 233, 719, 1001, 99999]) {
    for (const split of [[100], [70, 30], [50, 30, 20], [40, 25, 20, 15]]) {
      const payouts = computePayouts({ prizePool: pool, split });
      const total = payouts.reduce((a, b) => a + b.amountInr, 0);
      assert.equal(total, pool, `pool ${pool} with split ${split} lost money`);
    }
  }
});

test('rounding remainders go to first place, not the house', () => {
  // ₹100 split 3 ways: 33.33 each → 33/33/33 = 99, the spare ₹1 goes to 1st.
  const payouts = computePayouts({ prizePool: 100, split: [34, 33, 33] });
  assert.equal(payouts[0].amountInr, 34);
  assert.equal(payouts.reduce((a, b) => a + b.amountInr, 0), 100);

  const odd = computePayouts({ prizePool: 719, split: [70, 30] });
  assert.equal(odd[0].amountInr + odd[1].amountInr, 719);
  assert.ok(odd[0].amountInr >= odd[1].amountInr);
});

test('winner-takes-all gives the whole pool to first place', () => {
  const payouts = computePayouts({ prizePool: 720, split: [100] });
  assert.equal(payouts.length, 1);
  assert.equal(payouts[0].amountInr, 720);
});

test('financials show both the current pot and the full-house pot', () => {
  // ₹100 entry, 8 seats, 3 sold, 10% cut
  const f = financials({ entryFeeInr: 100, players: 3, maxPlayers: 8, rakeBips: 1000, payoutSplit: [70, 30] });
  assert.equal(f.collectedInr, 300);
  assert.equal(f.yourCutInr, 30);
  assert.equal(f.prizePoolInr, 270);
  assert.equal(f.payouts[0].amountInr, 189); // 70% of 270
  assert.equal(f.payouts[1].amountInr, 81);  // 30% of 270

  assert.equal(f.ifFull.collectedInr, 800, 'projection if every seat sells');
  assert.equal(f.ifFull.yourCutInr, 80);
  assert.equal(f.ifFull.prizePoolInr, 720);
});

test('splits and rake are validated', () => {
  assert.equal(validateSplit([100]), null);
  assert.equal(validateSplit([70, 30]), null);
  assert.match(validateSplit([70, 20]), /add up to 100/);
  assert.match(validateSplit([50, 50, 0]), /positive whole percent/);
  assert.match(validateSplit([]), /required/);
  assert.match(validateSplit([33.3, 66.7]), /positive whole percent/);

  assert.equal(validateRake(500), null);
  assert.equal(validateRake(0), null);
  assert.match(validateRake(5000), /cannot exceed/);
  assert.match(validateRake(-1), /whole number/);
});

test('prize awards map finishing order onto payouts', () => {
  const payouts = computePayouts({ prizePool: 1000, split: [70, 30] });
  const awards = prizeAwards({ standings: ['champ', 'second', 'third'], payouts });
  assert.equal(awards.length, 2);
  assert.deepEqual(awards[0], { place: 1, percent: 70, amountInr: 700, userId: 'champ' });
  assert.deepEqual(awards[1], { place: 2, percent: 30, amountInr: 300, userId: 'second' });
});

test('a zero-rake tournament pays the whole pot to players', () => {
  const f = financials({ entryFeeInr: 100, players: 4, maxPlayers: 4, rakeBips: 0, payoutSplit: [100] });
  assert.equal(f.yourCutInr, 0);
  assert.equal(f.prizePoolInr, 400);
  assert.equal(f.payouts[0].amountInr, 400);
});
