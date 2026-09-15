import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LudoEngine } from '../src/game/LudoEngine.js';
import { HOME_STEP } from '../src/game/constants.js';

const mk = (n = 2) =>
  new LudoEngine({
    players: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, color: ['red', 'blue', 'green', 'yellow'][i] })),
  });

// Put a player's tokens at chosen distances, bypassing the dice.
const place = (eng, id, steps) => {
  const p = eng.getPlayer(id);
  steps.forEach((s, i) => {
    p.tokens[i].steps = s;
    p.tokens[i].state = s < 0 ? 'yard' : s >= HOME_STEP ? 'home' : 'active';
  });
};

test('standings rank on tokens home first, then distance travelled', () => {
  const eng = mk(3);
  place(eng, 'p0', [10, 5, -1, -1]);            // 15 steps, none home
  place(eng, 'p1', [HOME_STEP, 2, -1, -1]);     // 1 home — beats raw distance
  place(eng, 'p2', [30, 20, 10, -1]);           // 60 steps, none home

  const order = eng.standings().map((s) => s.playerId);
  assert.deepEqual(order, ['p1', 'p2', 'p0']);
  assert.equal(eng.standings()[0].place, 1);
});

test('a player who walked away ranks below everyone still at the table', () => {
  const eng = mk(2);
  place(eng, 'p0', [HOME_STEP, HOME_STEP, HOME_STEP, 40]); // way ahead
  place(eng, 'p1', [-1, -1, -1, -1]);                      // nothing
  eng.getPlayer('p0').eliminated = true;

  assert.deepEqual(eng.standings().map((s) => s.playerId), ['p1', 'p0']);
});

test('an idle game is decided on the board, never left without a winner', () => {
  const eng = mk(2);
  place(eng, 'p0', [20, 10, -1, -1]);
  place(eng, 'p1', [5, -1, -1, -1]);

  const res = eng.finishByProgress('inactivity');
  assert.equal(res.gameOver, true);
  assert.equal(res.winnerId, 'p0', 'the player who was ahead wins');
  assert.equal(eng.phase, 'finished');
  assert.deepEqual(eng.winners, ['p0', 'p1'], 'full placings, not just a winner');
  assert.equal(eng.finishByProgress(), null, 'a finished game cannot be re-decided');
});

test('ranking is deterministic — identical boards resolve the same way every time', () => {
  const runs = new Set();
  for (let i = 0; i < 20; i += 1) {
    const eng = mk(4);
    place(eng, 'p0', [10, -1, -1, -1]);
    place(eng, 'p1', [10, -1, -1, -1]); // exact tie with p0
    place(eng, 'p2', [3, -1, -1, -1]);
    place(eng, 'p3', [3, -1, -1, -1]);  // exact tie with p2
    runs.add(eng.finishByProgress().winnerId + '|' + eng.winners.join(','));
  }
  assert.equal(runs.size, 1, 'a tie always breaks the same way');
  assert.equal([...runs][0].split('|')[0], 'p0', 'seat order is the published final tiebreak');
});

test('captures count, and break a tie when distance is level', () => {
  const eng = mk(2);
  place(eng, 'p0', [12, -1, -1, -1]);
  place(eng, 'p1', [12, -1, -1, -1]);
  eng.getPlayer('p1').captures = 2;

  assert.equal(eng.standings()[0].playerId, 'p1', 'the player who fought wins the tie');
  assert.equal(eng.progressOf('p1').captures, 2);
});

test('every state broadcast carries the live standings', () => {
  const eng = mk(2);
  place(eng, 'p0', [25, -1, -1, -1]);
  const state = eng.getState();
  assert.ok(Array.isArray(state.standings), 'clients can render position at every step');
  assert.equal(state.standings[0].playerId, 'p0');
  assert.ok(state.standings[0].percent > 0, 'progress is expressed as a percentage');
});
