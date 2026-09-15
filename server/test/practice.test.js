import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameManager } from '../src/game/GameManager.js';
import { LudoEngine } from '../src/game/LudoEngine.js';
import { chooseMove, isBotId, makeBotId } from '../src/game/bot.js';
import { store } from '../src/db/store.js';
import { wallet } from '../src/wallet/Wallet.js';
import { config } from '../src/config.js';
import './helpers/wideConfig.js';

const fakeIo = () => ({
  to: () => ({ emit: () => {} }),
  in: () => ({ socketsLeave: () => {}, fetchSockets: async () => [] }),
  socketsLeave: () => {},
});
const guest = (n) => ({ id: `guest:test-${n}`, name: 'Player', isGuest: true });

test('a guest cannot start or join a staked game', async () => {
  const m = new GameManager(fakeIo());
  await assert.rejects(() => m.createRoom(guest(1), { stake: 50, maxPlayers: 2 }), (e) => e.code === 'GUEST_FORBIDDEN');
  await assert.rejects(() => m.quickMatch(guest(2), 50, 2), (e) => e.code === 'GUEST_FORBIDDEN');
});

test('a guest can start a free practice game', async () => {
  const m = new GameManager(fakeIo());
  const room = await m.quickMatch(guest(3), 0, 2, undefined, 'seed', true);
  assert.equal(room.isPractice, true);
  assert.equal(room.stake, 0);
  assert.equal(room.seats.length, 1);
});

test('practice games reject a non-zero stake', async () => {
  const m = new GameManager(fakeIo());
  await assert.rejects(() => m.createRoom(guest(4), { stake: 50, isPractice: true }), (e) => e.code === 'BAD_STAKE');
});

test('two practice seekers are paired with each other, not with bots', async () => {
  const m = new GameManager(fakeIo());
  const first = await m.quickMatch(guest(5), 0, 2, undefined, 'a', true);
  const second = await m.quickMatch(guest(6), 0, 2, undefined, 'b', true);
  assert.equal(first.id, second.id, 'second player joins the waiting practice table');
  assert.equal(first.status, 'playing');
  assert.equal(first.seats.filter((s) => s.isBot).length, 0, 'no bot should be seated');
});

test('a practice game pays nothing and records nothing', async () => {
  const m = new GameManager(fakeIo());
  const human = await store.createUser({ provider: 'dev', providerId: 'prac-h', name: 'H' });
  await wallet.credit(human.id, 1000, 'seed');
  const before = await wallet.getBalance(human.id);

  const room = await m.quickMatch(human, 0, 2, undefined, 'x', true);
  // Seat a bot manually and start, the way the wait-timer would.
  room.seats.push({ userId: makeBotId(), name: 'Computer', color: 'green', connected: true, isBot: true, clientSeed: '' });
  m.userRoom.set(room.seats[1].userId, room.id);
  await m._startGame(room);
  assert.equal(room.pot, 0);

  // Play it out.
  let guard = 0;
  while (room.status === 'playing' && guard++ < 500_000) {
    const e = room.engine;
    const cur = e.currentPlayerId();
    if (e.phase === 'awaitingRoll') m.handleRoll(cur);
    else if (e.phase === 'awaitingMove') await m.handleMove(cur, e.legalMoves[0].tokenIndex);
    else break;
  }
  assert.equal(room.status, 'finished');
  assert.equal(await wallet.getBalance(human.id), before, 'balance must be untouched by practice');
  const games = await store.getUserGames(human.id, 10);
  assert.equal(games.length, 0, 'practice must not appear in game history');
});

test('a waiting practice room reports how long until the bot joins', async () => {
  const m = new GameManager(fakeIo());
  const room = await m.quickMatch(guest(8), 0, 2, undefined, 'd', true);

  const view = m.serializeRoom(room);
  assert.ok(view.botJoinsInMs > 0, 'countdown should be running');
  assert.ok(view.botJoinsInMs <= config.practice.botWaitMs, 'never more than the configured wait');

  // Once the search is cancelled there is no bot pending, so no countdown.
  await m.handleLeave(room.seats[0].userId);
  assert.equal(m.serializeRoom(room).botJoinsInMs, null);
});

test('cancelling a practice search cancels the pending bot and destroys the room', async () => {
  const m = new GameManager(fakeIo());
  const u = guest(7);
  const room = await m.quickMatch(u, 0, 2, undefined, 'c', true);
  assert.ok(room.botTimer, 'a bot-fill timer should be armed while waiting');

  await m.handleLeave(u.id);

  assert.equal(room.botTimer, null, 'the bot timer must be cancelled');
  assert.equal(m._roomOf(u.id), null, 'player is freed');
  assert.equal(m.rooms.has(room.id), false, 'the empty practice room is destroyed');
});

test('bot ids are recognisable and chooseMove picks a legal token', () => {
  const botId = makeBotId();
  assert.ok(isBotId(botId));
  assert.ok(!isBotId('guest:abc'));

  const engine = new LudoEngine({
    players: [
      { id: botId, name: 'Computer', color: 'red' },
      { id: 'human', name: 'H', color: 'green' },
    ],
  });
  engine.applyRoll(botId, 6);
  const choice = chooseMove(engine.getState(), botId);
  assert.ok(engine.legalMoves.some((mv) => mv.tokenIndex === choice), 'bot must pick from the legal set');
});

test('the bot prefers a capture over an ordinary move', () => {
  const botId = makeBotId();
  const engine = new LudoEngine({
    players: [
      { id: botId, name: 'Computer', color: 'red' },
      { id: 'human', name: 'H', color: 'green' },
    ],
  });
  // Red token 0 can capture green on global cell 20; token 1 has a dull move.
  engine.getPlayer(botId).tokens[0] = { state: 'active', steps: 17 };
  engine.getPlayer(botId).tokens[1] = { state: 'active', steps: 30 };
  engine.getPlayer('human').tokens[0] = { state: 'active', steps: 7 }; // green (13+7)%52 = 20
  engine.applyRoll(botId, 3); // token0: 17 -> 20 captures

  const choice = chooseMove(engine.getState(), botId);
  assert.equal(choice, 0, 'bot should take the capture');
});

test('practice mode config is sane', () => {
  assert.equal(typeof config.practice.enabled, 'boolean');
  assert.ok(config.practice.botWaitMs > 0);
  assert.ok(config.practice.botMaxThinkMs >= config.practice.botMinThinkMs);
});
