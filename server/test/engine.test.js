import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LudoEngine, GameError } from '../src/game/LudoEngine.js';

const twoPlayers = () => [
  { id: 'red', name: 'Red', color: 'red' },
  { id: 'green', name: 'Green', color: 'green' },
];

test('a token can only leave the yard on a 6', () => {
  const g = new LudoEngine({ players: twoPlayers() });
  // Red rolls 3 with everything in the yard -> no legal move, turn passes.
  const r = g.applyRoll('red', 3);
  assert.equal(r.moves.length, 0);
  assert.equal(r.turnPassed, true);
  assert.equal(g.currentPlayerId(), 'green');
});

test('rolling a 6 lets a token exit and grants an extra turn', () => {
  const g = new LudoEngine({ players: twoPlayers() });
  const r = g.applyRoll('red', 6);
  assert.equal(r.moves.length, 4); // all four yard tokens may exit
  g.applyMove('red', 0);
  const token = g.getPlayer('red').tokens[0];
  assert.equal(token.state, 'active');
  assert.equal(token.steps, 0);
  // Extra turn for the six -> still Red, awaiting another roll.
  assert.equal(g.currentPlayerId(), 'red');
  assert.equal(g.phase, 'awaitingRoll');
});

test('illegal token index is rejected', () => {
  const g = new LudoEngine({ players: twoPlayers() });
  g.applyRoll('red', 6);
  assert.throws(() => g.applyMove('red', 99), (e) => e instanceof GameError && e.code === 'ILLEGAL_MOVE');
});

test('a player cannot act out of turn', () => {
  const g = new LudoEngine({ players: twoPlayers() });
  assert.throws(() => g.applyRoll('green', 6), (e) => e instanceof GameError && e.code === 'NOT_YOUR_TURN');
});

test('cannot move before rolling', () => {
  const g = new LudoEngine({ players: twoPlayers() });
  assert.throws(() => g.applyMove('red', 0), (e) => e instanceof GameError && e.code === 'BAD_PHASE');
});

test('landing on an opponent on a non-safe cell captures it', () => {
  const g = new LudoEngine({ players: twoPlayers() });
  // Red token on global cell 20 (not safe).
  g.getPlayer('red').tokens[0] = { state: 'active', steps: 20 };
  // Green token one step before global cell 20 (green: (13+7)%52 = 20).
  g.getPlayer('green').tokens[0] = { state: 'active', steps: 1 };
  g.turnIndex = 1; // Green's turn
  g.phase = 'awaitingRoll';

  g.applyRoll('green', 6);
  g.applyMove('green', 0);

  assert.equal(g.getPlayer('green').tokens[0].steps, 7);
  // Red token sent home.
  assert.equal(g.getPlayer('red').tokens[0].state, 'yard');
  assert.equal(g.getPlayer('red').tokens[0].steps, -1);
});

test('an opponent on a safe cell is NOT captured', () => {
  const g = new LudoEngine({ players: twoPlayers() });
  // Red token sits on global cell 13 (a safe star/start cell).
  g.getPlayer('red').tokens[0] = { state: 'active', steps: 13 };
  g.turnIndex = 1;
  g.phase = 'awaitingRoll';

  // Green exits the yard onto its start cell, which is global 13.
  g.applyRoll('green', 6);
  g.applyMove('green', 0);

  assert.equal(g.getPlayer('red').tokens[0].state, 'active'); // survived
  assert.equal(g.getPlayer('green').tokens[0].steps, 0);
});

test('a token cannot overshoot home', () => {
  const g = new LudoEngine({ players: twoPlayers() });
  g.getPlayer('red').tokens[0] = { state: 'active', steps: 55 }; // one short of home (56)
  g.getPlayer('red').tokens[1] = { state: 'home', steps: 56 };
  g.getPlayer('red').tokens[2] = { state: 'home', steps: 56 };
  g.getPlayer('red').tokens[3] = { state: 'home', steps: 56 };

  // Rolling 3 would overshoot (55+3=58) -> no legal move, turn passes.
  const r = g.applyRoll('red', 3);
  assert.equal(r.moves.length, 0);
  assert.equal(r.turnPassed, true);
});

test('bringing the last token home wins the game', () => {
  const g = new LudoEngine({ players: twoPlayers() });
  const red = g.getPlayer('red');
  red.tokens[0] = { state: 'home', steps: 56 };
  red.tokens[1] = { state: 'home', steps: 56 };
  red.tokens[2] = { state: 'home', steps: 56 };
  red.tokens[3] = { state: 'active', steps: 53 };

  g.applyRoll('red', 3); // 53 + 3 = 56 exactly
  const res = g.applyMove('red', 3);

  assert.equal(res.gameOver, true);
  assert.equal(res.winners[0], 'red');
  assert.equal(g.phase, 'finished');
});

test('three consecutive sixes forfeit the turn', () => {
  const g = new LudoEngine({ players: twoPlayers() });
  g.applyRoll('red', 6);
  g.applyMove('red', 0); // token0 out, extra turn
  g.applyRoll('red', 6);
  g.applyMove('red', 1); // token1 out, extra turn
  const r = g.applyRoll('red', 6); // third six -> forfeit
  assert.equal(r.turnPassed, true);
  assert.equal(r.reason, 'tripleSix');
  assert.equal(g.currentPlayerId(), 'green');
  assert.equal(g.consecutiveSixes, 0);
});

test('finished games reject further rolls', () => {
  const g = new LudoEngine({ players: twoPlayers() });
  const red = g.getPlayer('red');
  red.tokens = [
    { state: 'home', steps: 56 },
    { state: 'home', steps: 56 },
    { state: 'home', steps: 56 },
    { state: 'active', steps: 50 },
  ];
  g.applyRoll('red', 6);
  g.applyMove('red', 3);
  assert.equal(g.phase, 'finished');
  assert.throws(() => g.applyRoll('red', 6), (e) => e instanceof GameError && e.code === 'FINISHED');
});

test('rejects games with the wrong number of players', () => {
  assert.throws(() => new LudoEngine({ players: [{ id: 'a', name: 'A', color: 'red' }] }),
    (e) => e instanceof GameError && e.code === 'BAD_PLAYERS');
});

const threePlayers = () => [
  { id: 'a', name: 'A', color: 'red' },
  { id: 'b', name: 'B', color: 'green' },
  { id: 'c', name: 'C', color: 'yellow' },
];

test('eliminating a player in a heads-up game ends it, the other wins', () => {
  const g = new LudoEngine({ players: twoPlayers() });
  const res = g.eliminatePlayer('red');
  assert.equal(res.gameOver, true);
  assert.equal(res.winnerId, 'green');
  assert.equal(g.phase, 'finished');
  assert.equal(g.getPlayer('red').eliminated, true);
});

test('eliminating one of three players keeps the game going', () => {
  const g = new LudoEngine({ players: threePlayers() });
  const res = g.eliminatePlayer('a'); // a was current
  assert.equal(res.gameOver, false);
  assert.notEqual(g.phase, 'finished');
  assert.notEqual(g.currentPlayerId(), 'a'); // moved off the eliminated player

  const res2 = g.eliminatePlayer('b'); // now only c remains
  assert.equal(res2.gameOver, true);
  assert.equal(res2.winnerId, 'c');
});

test("an eliminated player's turn is skipped in rotation", () => {
  const g = new LudoEngine({ players: threePlayers() }); // a's turn
  g.eliminatePlayer('b'); // b not current
  g.applyRoll('a', 3); // all in yard -> no move -> turn passes, skipping eliminated b
  assert.equal(g.currentPlayerId(), 'c');
});

test('an opponent cannot pass a blockade', () => {
  const g = new LudoEngine({ players: twoPlayers() });
  // Green blockade on global cell 20 (green steps 7 -> (13+7)%52 = 20, not safe).
  g.getPlayer('green').tokens[0] = { state: 'active', steps: 7 };
  g.getPlayer('green').tokens[1] = { state: 'active', steps: 7 };
  // Red is just before cell 20 and its only movable token.
  g.getPlayer('red').tokens[0] = { state: 'active', steps: 18 };
  const r = g.applyRoll('red', 3); // 18 -> 21 would pass through the block at 20
  assert.equal(r.moves.length, 0);
  assert.equal(r.turnPassed, true);
});

test('an opponent cannot land on a blockade', () => {
  const g = new LudoEngine({ players: twoPlayers() });
  g.getPlayer('green').tokens[0] = { state: 'active', steps: 7 }; // block at global 20
  g.getPlayer('green').tokens[1] = { state: 'active', steps: 7 };
  g.getPlayer('red').tokens[0] = { state: 'active', steps: 17 };
  const r = g.applyRoll('red', 3); // 17 -> 20 lands on the block
  assert.equal(r.moves.length, 0);
});

test('a player can pass their OWN blockade', () => {
  const g = new LudoEngine({ players: twoPlayers() });
  g.getPlayer('red').tokens[0] = { state: 'active', steps: 5 }; // red block at global 5
  g.getPlayer('red').tokens[1] = { state: 'active', steps: 5 };
  g.getPlayer('red').tokens[2] = { state: 'active', steps: 2 };
  const r = g.applyRoll('red', 4); // token2: 2 -> 6 through its own block at 5
  const move = r.moves.find((m) => m.tokenIndex === 2);
  assert.ok(move, 'own blockade must not block own token');
  assert.equal(move.toStep, 6);
});

test('two tokens on a SAFE cell do not form a blockade', () => {
  const g = new LudoEngine({ players: twoPlayers() });
  g.getPlayer('green').tokens[0] = { state: 'active', steps: 47 }; // global (13+47)%52 = 8 (safe)
  g.getPlayer('green').tokens[1] = { state: 'active', steps: 47 };
  g.getPlayer('red').tokens[0] = { state: 'active', steps: 6 };
  const r = g.applyRoll('red', 4); // 6 -> 10 passes the safe cell 8 freely
  const move = r.moves.find((m) => m.tokenIndex === 0);
  assert.ok(move, 'a safe cell is not a blockade');
  assert.equal(move.toStep, 10);
});
