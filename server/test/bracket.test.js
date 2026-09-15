import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBracket, reportWinner, pendingMatches, champion, isComplete, standings, bracketSize, seedOrder, findMatch,
} from '../src/tournament/bracket.js';

test('bracket size rounds up to a power of two', () => {
  assert.equal(bracketSize(2), 2);
  assert.equal(bracketSize(3), 4);
  assert.equal(bracketSize(8), 8);
  assert.equal(bracketSize(9), 16);
});

test('seeding pairs the top seed against the bottom seed', () => {
  assert.deepEqual(seedOrder(4), [1, 4, 2, 3]);
  assert.deepEqual(seedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
});

test('a full 4-player bracket plays out to a champion', () => {
  const b = buildBracket(['p1', 'p2', 'p3', 'p4']);
  assert.equal(b.rounds.length, 2);
  assert.equal(pendingMatches(b).length, 2, 'both semi-finals are playable');

  reportWinner(b, 'r1m1', 'p1');
  reportWinner(b, 'r1m2', 'p2');
  const final = pendingMatches(b);
  assert.equal(final.length, 1);
  assert.equal(final[0].round, 2);

  reportWinner(b, final[0].id, 'p2');
  assert.equal(champion(b), 'p2');
  assert.equal(isComplete(b), true);
  assert.equal(standings(b)[0], 'p2');
  assert.equal(standings(b)[1], 'p1', 'runner-up is the beaten finalist');
});

test('odd player counts get byes in round 1 only', () => {
  const b = buildBracket(['a', 'b', 'c', 'd', 'e']);
  assert.equal(b.size, 8);
  // Seeds 1-3 have no opponent in round 1, so they walk over.
  const r1 = b.rounds[0].matches;
  assert.equal(r1.filter((m) => m.walkover).length, 3);
  // Only the genuine match is playable.
  const pending = pendingMatches(b);
  assert.equal(pending.length, 1);
  assert.deepEqual([pending[0].a, pending[0].b].sort(), ['d', 'e']);
});

test('a two-player tournament is a single final', () => {
  const b = buildBracket(['x', 'y']);
  assert.equal(b.rounds.length, 1);
  reportWinner(b, 'r1m1', 'y');
  assert.equal(champion(b), 'y');
});

test('the bracket rejects bogus results', () => {
  const b = buildBracket(['p1', 'p2', 'p3', 'p4']);
  assert.throws(() => reportWinner(b, 'nope', 'p1'), /Unknown match/);
  assert.throws(() => reportWinner(b, 'r1m1', 'p3'), /not a player in this match/);
  reportWinner(b, 'r1m1', 'p1');
  assert.throws(() => reportWinner(b, 'r1m1', 'p1'), /already decided/);
});

test('a later round cannot start before the current one finishes', () => {
  const b = buildBracket(['p1', 'p2', 'p3', 'p4']);
  reportWinner(b, 'r1m1', 'p1');
  // The final has only one player so far — not playable yet.
  const pending = pendingMatches(b);
  assert.ok(pending.every((m) => m.round === 1), 'still on round 1');
  assert.equal(findMatch(b, 'r2m1').winner, null);
});

test('an empty later-round slot is NOT a bye — it awaits the previous winner', () => {
  // 3 players in a 4-slot bracket: one semi is a bye, the other is real.
  // The final must stay OPEN until that real semi is played.
  const b = buildBracket(['p1', 'p2', 'p3']);
  const final = b.rounds[1].matches[0];
  assert.equal(final.winner, null, 'no champion before the semi-final is played');
  assert.equal(champion(b), null);
  assert.equal(isComplete(b), false);

  const semi = pendingMatches(b)[0];
  reportWinner(b, semi.id, semi.a);
  assert.equal(isComplete(b), false, 'final still to play');
  const f = pendingMatches(b)[0];
  reportWinner(b, f.id, f.a);
  assert.ok(champion(b));
});

test('fewer than two players is rejected', () => {
  assert.throws(() => buildBracket(['solo']), /at least 2 players/);
});
