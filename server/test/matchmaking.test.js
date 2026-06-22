import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameManager } from '../src/game/GameManager.js';
import { store } from '../src/db/store.js';
import { wallet } from '../src/wallet/Wallet.js';

const fakeIo = () => ({ to: () => ({ emit: () => {} }) });
let n = 0;
const mkUser = async (tag, coins = 1000) => {
  const u = await store.createUser({ provider: 'dev', providerId: `dev-${tag}-${n++}`, name: tag });
  await wallet.credit(u.id, coins, 'seed');
  return u;
};

test('quick match pairs two players at the same stake + count', async () => {
  const m = new GameManager(fakeIo());
  const a = await mkUser('qm-a');
  const b = await mkUser('qm-b');
  const r1 = await m.quickMatch(a, 100, 2);
  assert.equal(r1.status, 'waiting');
  const r2 = await m.quickMatch(b, 100, 2);
  assert.equal(r1.id, r2.id, 'second player joins the first one\'s room');
  assert.equal(r1.status, 'playing', 'a 2-player table starts when full');
});

test('a 3-player match only starts once three players have joined', async () => {
  const m = new GameManager(fakeIo());
  const a = await mkUser('p3-a');
  const b = await mkUser('p3-b');
  const c = await mkUser('p3-c');
  const r = await m.quickMatch(a, 50, 3);
  await m.quickMatch(b, 50, 3);
  assert.equal(r.status, 'waiting', 'still waiting at 2/3');
  assert.equal(r.seats.length, 2);
  await m.quickMatch(c, 50, 3);
  assert.equal(r.status, 'playing', 'starts at 3/3');
  assert.equal(r.pot, 150);
  assert.equal(r.seats.length, 3);
});

test('different player counts use separate matchmaking pools', async () => {
  const m = new GameManager(fakeIo());
  const a = await mkUser('cnt-2');
  const b = await mkUser('cnt-4');
  const r2 = await m.quickMatch(a, 100, 2);
  const r4 = await m.quickMatch(b, 100, 4);
  assert.notEqual(r2.id, r4.id, '2P and 4P seekers must not be matched together');
});

test('random matchmaking never joins a private friend room', async () => {
  const m = new GameManager(fakeIo());
  const host = await mkUser('priv-host');
  const rando = await mkUser('priv-rando');
  const priv = await m.createRoom(host, { stake: 100, maxPlayers: 2, isPrivate: true });
  const r = await m.quickMatch(rando, 100, 2);
  assert.notEqual(r.id, priv.id, 'stranger should not be dropped into a private room');
  assert.equal(priv.seats.length, 1, 'private room stays untouched');
});

test('invalid player counts are rejected', async () => {
  const m = new GameManager(fakeIo());
  const a = await mkUser('bad-count');
  await assert.rejects(() => m.quickMatch(a, 100, 5), (e) => e.code === 'BAD_MAX_PLAYERS');
});
