import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameManager } from '../src/game/GameManager.js';
import { Presence } from '../src/socket/presence.js';
import { store } from '../src/db/store.js';
import { wallet } from '../src/wallet/Wallet.js';
import './helpers/wideConfig.js';

const fakeIo = () => ({
  to: () => ({ emit: () => {} }),
  in: () => ({ socketsLeave: () => {}, fetchSockets: async () => [] }),
  emit: () => {},
  socketsLeave: () => {},
});

let n = 0;
const player = async () => {
  const u = await store.createUser({ provider: 'dev', providerId: `pres-${n++}`, name: `P${n}` });
  await wallet.credit(u.id, 5000, 'test_seed');
  return u;
};

test('presence counts who is waiting at each stake, public tables only', async () => {
  const m = new GameManager(fakeIo());
  const presence = new Presence(fakeIo(), m);

  await m.quickMatch(await player(), 100, 2); // waiting at 100
  await m.quickMatch(await player(), 500, 2); // waiting at 500
  const a = await player();
  const b = await player();
  await m.quickMatch(a, 50, 2);
  await m.quickMatch(b, 50, 2); // pairs with a → playing at 50
  await m.createRoom(await player(), { stake: 100, maxPlayers: 2, isPrivate: true }); // private: not a queue

  const snap = presence.snapshot();
  assert.deepEqual(snap.waitingBy, { '2:100': 1, '2:500': 1 });
  assert.deepEqual(snap.playingBy, { '2:50': 2 });
  assert.equal(snap.waiting, 3, 'overall waiting still includes the private room');
  for (const room of m.rooms.values()) m._destroyRoom(room);
});
