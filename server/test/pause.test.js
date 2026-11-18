import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameManager } from '../src/game/GameManager.js';
import { store } from '../src/db/store.js';
import { wallet } from '../src/wallet/Wallet.js';
import { config } from '../src/config.js';
import './helpers/wideConfig.js';

// socket.io double. `live` decides which users still have a connected socket.
function fakeIo(live) {
  const events = [];
  return {
    events,
    to: () => ({ emit: (event, payload) => events.push({ event, payload }) }),
    in: (roomName) => ({
      socketsLeave: () => {},
      fetchSockets: async () => (live.has(String(roomName).replace(/^user:/, '')) ? [{}] : []),
    }),
    socketsLeave: () => {},
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;

async function startGame(live) {
  const io = fakeIo(live);
  const m = new GameManager(io);
  const a = await store.createUser({ provider: 'dev', providerId: `pause-a-${n++}`, name: 'Asha' });
  const b = await store.createUser({ provider: 'dev', providerId: `pause-b-${n++}`, name: 'Bala' });
  await wallet.credit(a.id, 1000, 'test_seed');
  await wallet.credit(b.id, 1000, 'test_seed');
  live.add(a.id);
  live.add(b.id);
  const room = await m.createRoom(a, { stake: 50, maxPlayers: 2 });
  await m.joinRoom(b, room.id);
  assert.equal(room.status, 'playing');
  return { m, io, room, a, b };
}

test('a disconnect pauses the game: nobody can roll, the clock freezes, and play resumes on return', async () => {
  const live = new Set();
  const { m, room, a, b } = await startGame(live);
  const current = room.engine.currentPlayerId();
  const other = current === a.id ? b.id : a.id;

  // The player who is NOT on turn drops.
  live.delete(other);
  await m.markConnected(other, false);

  assert.equal(room.away.size, 1);
  assert.equal(room.turnTimer, null, 'turn clock frozen');
  assert.equal(m.serializeRoom(room).paused[0].userId, other);
  assert.throws(() => m.handleRoll(current), (e) => e.code === 'PAUSED', 'the present player cannot play on');

  // They come back: unpaused, a fresh turn clock, and play continues.
  live.add(other);
  await m.markConnected(other, true);
  assert.equal(room.away.size, 0);
  assert.ok(room.turnTimer, 'turn clock re-armed');
  assert.deepEqual(m.serializeRoom(room).paused, []);
  m.handleRoll(current);
  assert.equal(room.status, 'playing');
  m._destroyRoom(room);
});

test('a player who does not come back in time forfeits, and the winner is paid', async () => {
  const grace = config.economy.disconnectGraceMs;
  config.economy.disconnectGraceMs = 60;
  try {
    const live = new Set();
    const { m, room, a, b } = await startGame(live);
    live.delete(b.id);
    await m.markConnected(b.id, false);
    await sleep(150);
    assert.equal(room.status, 'finished');
    assert.equal(room.engine.winners[0], a.id);
    assert.equal(await wallet.getBalance(a.id), 1000 - 50 + 95);
    assert.equal(await wallet.getBalance(b.id), 1000 - 50);
  } finally {
    config.economy.disconnectGraceMs = grace;
  }
});

test('pause time is capped per player per game, so nobody can stall forever', async () => {
  const budget = config.economy.pauseBudgetMs;
  config.economy.pauseBudgetMs = 80;
  try {
    const live = new Set();
    const { m, room, a, b } = await startGame(live);
    // First absence: 50ms of the 80ms budget used.
    live.delete(b.id);
    await m.markConnected(b.id, false);
    await sleep(50);
    live.add(b.id);
    await m.markConnected(b.id, true);
    assert.equal(room.status, 'playing');
    // Second absence only gets what is left (~30ms), then forfeits.
    live.delete(b.id);
    await m.markConnected(b.id, false);
    assert.ok(m.serializeRoom(room).paused[0].msLeft <= 40);
    await sleep(120);
    assert.equal(room.status, 'finished');
    assert.equal(room.engine.winners[0], a.id);
  } finally {
    config.economy.pauseBudgetMs = budget;
  }
});
