import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameManager } from '../src/game/GameManager.js';
import { store } from '../src/db/store.js';
import { wallet } from '../src/wallet/Wallet.js';
import { config } from '../src/config.js';

// A no-op socket.io double that just records what would have been broadcast.
function fakeIo() {
  const events = [];
  return {
    events,
    to: () => ({ emit: (event, payload) => events.push({ event, payload }) }),
  };
}

// Drive a started game to completion using only the public manager API, always
// choosing the first legal move — exactly what a (well-behaved) client can do.
async function playToCompletion(manager, room) {
  let guard = 0;
  while (room.status === 'playing' && guard++ < 500_000) {
    const engine = room.engine;
    const cur = engine.currentPlayerId();
    if (engine.phase === 'awaitingRoll') {
      manager.handleRoll(cur);
    } else if (engine.phase === 'awaitingMove') {
      await manager.handleMove(cur, engine.legalMoves[0].tokenIndex);
    } else {
      break;
    }
  }
  assert.equal(room.status, 'finished', 'game should finish within the guard');
}

test('a full staked 2-player game escrows, settles, and conserves coins', async () => {
  const io = fakeIo();
  const manager = new GameManager(io);

  const alice = store.createUser({ provider: 'dev', providerId: 'dev-alice-itest', name: 'Alice' });
  const bob = store.createUser({ provider: 'dev', providerId: 'dev-bob-itest', name: 'Bob' });
  await wallet.credit(alice.id, 1000, 'test_seed');
  await wallet.credit(bob.id, 1000, 'test_seed');

  const stake = 100;
  const houseBefore = wallet.houseBalance();

  const room = manager.createRoom(alice, { stake, maxPlayers: 2 });
  await manager.joinRoom(bob, room.id); // fills the room -> game starts -> escrow

  // Stakes were escrowed up front.
  assert.equal(wallet.getBalance(alice.id), 900);
  assert.equal(wallet.getBalance(bob.id), 900);
  assert.equal(room.pot, 200);

  await playToCompletion(manager, room);

  const winnerId = room.engine.winners[0];
  const loserId = winnerId === alice.id ? bob.id : alice.id;

  const pot = 200;
  const rake = Math.floor((pot * config.economy.rakeBips) / 10000);
  const payout = pot - rake;

  // Winner: -stake +payout. Loser: -stake. House: +rake. Nothing created/destroyed.
  assert.equal(wallet.getBalance(winnerId), 1000 - stake + payout);
  assert.equal(wallet.getBalance(loserId), 1000 - stake);
  assert.equal(wallet.houseBalance() - houseBefore, rake);

  const totalAfter = wallet.getBalance(alice.id) + wallet.getBalance(bob.id) + (wallet.houseBalance() - houseBefore);
  assert.equal(totalAfter, 2000, 'coins must be conserved across the whole game');

  // A game-over broadcast with verifiable fairness data must have gone out.
  const over = io.events.find((e) => e.event === 'game:over');
  assert.ok(over, 'expected a game:over broadcast');
  assert.ok(over.payload.fairness.serverSeed, 'fairness reveal must include the server seed');
});

test('cannot create a game you cannot afford', () => {
  const manager = new GameManager(fakeIo());
  const broke = store.createUser({ provider: 'dev', providerId: 'dev-broke-itest', name: 'Broke' });
  assert.throws(() => manager.createRoom(broke, { stake: 100, maxPlayers: 2 }),
    (e) => e.code === 'INSUFFICIENT_FUNDS');
});

test('cannot join two games at once', async () => {
  const manager = new GameManager(fakeIo());
  const u = store.createUser({ provider: 'dev', providerId: 'dev-double-itest', name: 'Dub' });
  await wallet.credit(u.id, 1000, 'test_seed');
  manager.createRoom(u, { stake: 50, maxPlayers: 2 });
  assert.throws(() => manager.createRoom(u, { stake: 50, maxPlayers: 2 }),
    (e) => e.code === 'ALREADY_IN_GAME');
});
