import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TournamentService } from '../src/tournament/TournamentService.js';
import { store } from '../src/db/store.js';
import { reasonText, scoreText, scoreFromStandings } from '../src/tournament/outcome.js';

const svc = new TournamentService();
let n = 0;
const mkUser = async (tag) => store.createUser({ provider: 'dev', providerId: `j-${tag}-${n++}`, name: tag });

// `seats` is the bracket size (must be a power of two); `entrants` is how many
// actually paid — fewer entrants than seats is what creates a bye.
async function started(entrants = 4, seats = 4) {
  const t = await svc.create({
    title: 'Journey Cup', entryType: 'manual', entryFeeInr: 100,
    maxPlayers: seats, rakePercent: 10, payoutSplit: [70, 30],
  });
  const users = [];
  for (let i = 0; i < entrants; i += 1) {
    const u = await mkUser(`p${i}`);
    await svc.addEntryManually(t.id, u.id, { paymentRef: `r${i}` });
    users.push(u);
  }
  await svc.start(t.id);
  return { t: await svc.get(t.id), users };
}

test('a knocked-out player is told which round, against whom, and why', async () => {
  const { t } = await started(4);
  const m = t.bracket.rounds[0].matches.find((x) => x.a && x.b);

  await svc.recordResult(t.id, m.id, m.a, {
    endedBy: 'inactivity',
    score: scoreFromStandings([
      { playerId: m.a, home: 3, steps: 180, captures: 2, percent: 79 },
      { playerId: m.b, home: 1, steps: 90, captures: 0, percent: 39 },
    ]),
  });

  const out = await svc.milestoneFor(t.id, m.b);
  assert.equal(out.eliminated, true);
  assert.ok(out.exit, 'the losing match is singled out');
  assert.equal(out.exit.round, 1);
  assert.equal(out.exit.result, 'lost');
  assert.equal(out.exit.endedBy, 'inactivity');
  assert.ok(out.exit.reason.includes('timed out'), `got: ${out.exit.reason}`);
  assert.equal(out.exit.score, '1/4 home vs 3/4 home', 'the board it was decided on');
  assert.ok(out.exit.opponentName, 'the opponent is named');
  assert.ok(out.label.includes('Knocked out'), out.label);
});

test('the journey lists every round the player reached, in order', async () => {
  const { t } = await started(4);
  const r1 = t.bracket.rounds[0].matches.filter((x) => x.a && x.b);
  const me = r1[0].a;

  await svc.recordResult(t.id, r1[0].id, me, { endedBy: 'played' });
  await svc.recordResult(t.id, r1[1].id, r1[1].a, { endedBy: 'forfeit' });

  const m = await svc.milestoneFor(t.id, me);
  assert.equal(m.journey.length, 2, 'round 1 played, round 2 pending');
  assert.equal(m.journey[0].result, 'won');
  assert.ok(m.journey[0].reason.includes('all four tokens home'));
  assert.equal(m.journey[1].result, 'playing');
  assert.equal(m.journey[1].round, 2);
});

test('a walkover is labelled as one, not as a win on the board', async () => {
  const { t } = await started(3, 4); // 3 entrants in a 4-slot bracket = one bye
  const bye = t.bracket.rounds[0].matches.find((x) => x.walkover);
  assert.ok(bye, 'the odd player out gets a bye');
  assert.equal(bye.endedBy, 'walkover');

  const m = await svc.milestoneFor(t.id, bye.winner);
  assert.ok(m.journey[0].reason.toLowerCase().includes('walkover'), m.journey[0].reason);
});

test('history covers every tournament entered, with the reason it ended', async () => {
  const u = await mkUser('hist');
  const ids = [];
  for (const title of ['Cup One', 'Cup Two']) {
    const t = await svc.create({ title, entryType: 'manual', entryFeeInr: 100, maxPlayers: 2, rakePercent: 10 });
    const opp = await mkUser('opp');
    await svc.addEntryManually(t.id, u.id, { paymentRef: 'a' });
    await svc.addEntryManually(t.id, opp.id, { paymentRef: 'b' });
    await svc.start(t.id);
    const cur = await svc.get(t.id);
    const m = cur.bracket.rounds[0].matches[0];
    // Lose the first, win the second.
    const winner = title === 'Cup One' ? opp.id : u.id;
    await svc.recordResult(t.id, m.id, winner, { endedBy: title === 'Cup One' ? 'forfeit' : 'played' });
    ids.push(t.id);
  }

  const hist = await svc.historyFor(u.id, 10);
  assert.equal(hist.length, 2);
  const lost = hist.find((h) => h.title === 'Cup One');
  const won = hist.find((h) => h.title === 'Cup Two');

  assert.equal(lost.eliminated, true);
  assert.ok(lost.exit.reason.includes('left the match'), lost.exit.reason);
  assert.equal(won.isChampion, true);
  assert.equal(won.place, 1);
  assert.ok(won.prizeInr > 0, 'the champion row shows what it paid');
});

test('reason wording is written from each side', () => {
  assert.notEqual(reasonText('forfeit', true), reasonText('forfeit', false));
  assert.ok(reasonText('forfeit', false).startsWith('You left'));
  assert.ok(reasonText('forfeit', true).startsWith('Your opponent left'));
  assert.equal(scoreText(null, 'a', 'b'), null, 'no board, no score line');
});

test('listings carry the live paid-entry count, not just the seat limit', async () => {
  const t = await svc.create({ title: 'Pot Growth', entryType: 'manual', entryFeeInr: 100, maxPlayers: 8, rakePercent: 10 });
  const listed = async () => (await svc.list({ status: 'open', limit: 50 })).find((x) => x.id === t.id);

  assert.equal((await listed()).players, 0, 'an empty tournament has an empty pot');

  for (const tag of ['a', 'b', 'c']) {
    const u = await mkUser(`pot-${tag}`);
    await svc.addEntryManually(t.id, u.id, { paymentRef: `r-${tag}` });
  }
  assert.equal((await listed()).players, 3, 'the count tracks real entries');

  // The pot a card renders must follow the entries, not the seat count.
  const pool = (players) => {
    const gross = 100 * players;
    return gross - Math.floor((gross * 1000) / 10000);
  };
  assert.equal(pool(3), 270);
  assert.equal(pool(8), 720, 'the full-table figure is the ceiling, not the promise');
});
