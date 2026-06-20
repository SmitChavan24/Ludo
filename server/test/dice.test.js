import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ProvablyFairDice,
  rollFromSeeds,
  hashServerSeed,
  createServerSeed,
} from '../src/game/dice.js';

test('rolls are always 1..6', () => {
  const dice = new ProvablyFairDice('client-seed');
  for (let i = 0; i < 1000; i++) {
    const v = dice.roll();
    assert.ok(v >= 1 && v <= 6, `out of range: ${v}`);
  }
});

test('rolls are deterministic given the seeds + nonce', () => {
  const serverSeed = createServerSeed();
  const a = rollFromSeeds(serverSeed, 'client', 0);
  const b = rollFromSeeds(serverSeed, 'client', 0);
  assert.equal(a, b);
  // Different nonce generally changes the stream.
  const seq1 = Array.from({ length: 10 }, (_, n) => rollFromSeeds(serverSeed, 'client', n));
  const seq2 = Array.from({ length: 10 }, (_, n) => rollFromSeeds(serverSeed, 'client', n));
  assert.deepEqual(seq1, seq2);
});

test('distribution is roughly uniform (no obvious bias)', () => {
  const dice = new ProvablyFairDice('fairness-check');
  const counts = [0, 0, 0, 0, 0, 0];
  const N = 60000;
  for (let i = 0; i < N; i++) counts[dice.roll() - 1]++;
  const expected = N / 6;
  for (const c of counts) {
    // Within 8% of expected — extremely loose, just catches gross bias.
    assert.ok(Math.abs(c - expected) < expected * 0.08, `face count ${c} too far from ${expected}`);
  }
});

test('the revealed serverSeed verifies against the published commitment', () => {
  const dice = new ProvablyFairDice('player-seed');
  const { serverSeedHash } = dice.commitment();
  for (let i = 0; i < 20; i++) dice.roll();
  const revealed = dice.reveal();
  // A player can recompute this and confirm the server never changed its seed.
  assert.equal(hashServerSeed(revealed.serverSeed), serverSeedHash);
});

test('anyone can recompute the exact roll sequence after reveal', () => {
  const dice = new ProvablyFairDice('audit');
  const observed = Array.from({ length: 15 }, () => dice.roll());
  const { serverSeed, clientSeed } = dice.reveal();
  const recomputed = observed.map((_, nonce) => rollFromSeeds(serverSeed, clientSeed, nonce));
  assert.deepEqual(observed, recomputed);
});
