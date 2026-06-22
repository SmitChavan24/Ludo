import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/db/MemoryStore.js';

const game = (id, stake, winnerId, payout, endedAt, a, b) => ({
  id,
  stake,
  pot: stake * 2,
  winnerId,
  payout,
  rake: stake * 2 - payout,
  endedAt,
  players: [
    { userId: a.id, name: a.name, color: 'red' },
    { userId: b.id, name: b.name, color: 'green' },
  ],
});

test('user game history is newest-first with correct win/net', async () => {
  const store = new MemoryStore();
  const alice = await store.createUser({ provider: 'dev', providerId: 'h-alice', name: 'Alice' });
  const bob = await store.createUser({ provider: 'dev', providerId: 'h-bob', name: 'Bob' });

  await store.recordGame(game('g1', 100, alice.id, 190, 1000, alice, bob)); // alice +90
  await store.recordGame(game('g2', 50, bob.id, 95, 2000, alice, bob)); // alice -50

  const games = await store.getUserGames(alice.id, 10);
  assert.equal(games.length, 2);
  assert.equal(games[0].gameId, 'g2'); // newest first

  const g1 = games.find((g) => g.gameId === 'g1');
  assert.equal(g1.isWinner, true);
  assert.equal(g1.net, 90);
  assert.equal(g1.players.length, 2);

  const g2 = games.find((g) => g.gameId === 'g2');
  assert.equal(g2.isWinner, false);
  assert.equal(g2.net, -50);
});

test('leaderboard ranks by net coins won', async () => {
  const store = new MemoryStore();
  const a = await store.createUser({ provider: 'dev', providerId: 'l-a', name: 'A' });
  const b = await store.createUser({ provider: 'dev', providerId: 'l-b', name: 'B' });

  await store.recordGame(game('x1', 100, a.id, 190, 1000, a, b));
  await store.recordGame(game('x2', 100, a.id, 190, 2000, a, b));

  const lb = await store.getLeaderboard({ limit: 10 });
  assert.equal(lb[0].userId, a.id);
  assert.equal(lb[0].rank, 1);
  assert.equal(lb[0].wins, 2);
  assert.equal(lb[0].net, 180); // +90 twice
  assert.equal(lb[1].userId, b.id);
  assert.equal(lb[1].net, -200); // -100 twice
});

test('weekly leaderboard excludes games outside the window', async () => {
  const store = new MemoryStore();
  const a = await store.createUser({ provider: 'dev', providerId: 'w-a', name: 'A' });
  const b = await store.createUser({ provider: 'dev', providerId: 'w-b', name: 'B' });
  const old = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const recent = Date.now() - 60 * 60 * 1000;

  await store.recordGame(game('old1', 100, a.id, 190, old, a, b));
  await store.recordGame(game('new1', 100, b.id, 190, recent, a, b));

  const week = await store.getLeaderboard({ limit: 10, since: Date.now() - 7 * 24 * 60 * 60 * 1000 });
  assert.equal(week[0].userId, b.id); // only new1 counts
  assert.equal(week[0].net, 90);
  assert.equal(week.find((r) => r.userId === a.id).net, -100);
});
