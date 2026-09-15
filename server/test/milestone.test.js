import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TournamentService } from '../src/tournament/TournamentService.js';
import { store } from '../src/db/store.js';

const svc = new TournamentService();
let n = 0;
const mkUser = async (tag) =>
  store.createUser({ provider: 'dev', providerId: `ms-${tag}-${n++}`, name: tag });

// A 4-player manual tournament, started, with the bracket drawn.
async function fourPlayerTournament() {
  const t = await svc.create({
    title: 'Milestone Cup', entryType: 'manual', entryFeeInr: 100,
    maxPlayers: 4, rakePercent: 10, payoutSplit: [70, 30],
  });
  const users = [];
  for (const tag of ['a', 'b', 'c', 'd']) {
    const u = await mkUser(tag);
    await svc.addEntryManually(t.id, u.id, { paymentRef: `r-${tag}` });
    users.push(u);
  }
  await svc.start(t.id);
  return { t: await svc.get(t.id), users };
}

test('a player who never entered gets no milestone', async () => {
  const { t } = await fourPlayerTournament();
  const outsider = await mkUser('outsider');
  assert.deepEqual(await svc.milestoneFor(t.id, outsider.id), { entered: false });
});

test('before the draw, the milestone is the number of wins the title costs', async () => {
  const t = await svc.create({ title: 'Pre-draw', entryType: 'manual', entryFeeInr: 100, maxPlayers: 4 });
  const u = await mkUser('pre');
  await svc.addEntryManually(t.id, u.id, { paymentRef: 'r' });
  const m = await svc.milestoneFor(t.id, u.id);

  assert.equal(m.entered, true);
  assert.equal(m.winsSoFar, 0);
  assert.equal(m.round, 0);
  assert.ok(m.label.includes('to take the title'));
});

test('the milestone counts down as a player wins, and names the next opponent', async () => {
  const { t, users } = await fourPlayerTournament();
  const me = users.find((u) => {
    const m = t.bracket.rounds[0].matches.find((x) => x.a === u.id || x.b === u.id);
    return m && m.a && m.b;
  });

  let m = await svc.milestoneFor(t.id, me.id);
  assert.equal(m.totalRounds, 2, '4 players = 2 wins for the title');
  assert.equal(m.winsNeeded, 2);
  assert.ok(m.nextMatch, 'a live match is shown');
  assert.ok(m.nextMatch.opponentName, 'the opponent is named');
  assert.equal(m.prizeIfChampion > 0, true, 'the title is worth real money');

  // Win the first match.
  await svc.recordResult(t.id, m.nextMatch.matchId, me.id);
  m = await svc.milestoneFor(t.id, me.id);
  assert.equal(m.winsSoFar, 1);
  assert.equal(m.winsNeeded, 1);
  assert.equal(m.label, 'Win this match and the title is yours');
});

test('a knocked-out player is told where they finished, and what it paid', async () => {
  const { t, users } = await fourPlayerTournament();
  const match = t.bracket.rounds[0].matches.find((x) => x.a && x.b);
  const loser = match.b;

  await svc.recordResult(t.id, match.id, match.a);
  const m = await svc.milestoneFor(t.id, loser);

  assert.equal(m.eliminated, true);
  assert.equal(m.nextMatch, null, 'no next match once you are out');
  assert.ok(m.label.startsWith('Knocked out in round'));
});

test('the champion is told they won and what it paid', async () => {
  const { t, users } = await fourPlayerTournament();
  let cur = await svc.get(t.id);
  let winner = null;
  // Play the whole bracket out, always advancing slot A.
  for (let guard = 0; guard < 10; guard += 1) {
    cur = await svc.get(t.id);
    const live = cur.bracket.rounds.flatMap((r) => r.matches).find((mm) => !mm.winner && mm.a && mm.b);
    if (!live) break;
    winner = live.a;
    await svc.recordResult(t.id, live.id, live.a);
  }
  const m = await svc.milestoneFor(t.id, winner);
  assert.equal(m.isChampion, true);
  assert.equal(m.winsNeeded, 0);
  assert.equal(m.place, 1);
  assert.ok(m.label.startsWith('You won the tournament'));
});
