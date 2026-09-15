// ──────────────────────────────────────────────────────────────────────────
// Single-elimination bracket maths. Pure functions, no I/O — so the tricky
// part (seeding, byes, advancing) is fully testable on its own.
//
// A bracket is:
//   { size, rounds: [ { round, matches: [ { id, a, b, winner, roomId } ] } ] }
// where `a`/`b` are user ids (or null for an empty slot / bye).
// ──────────────────────────────────────────────────────────────────────────

// Smallest power of two that fits n players (min 2).
export function bracketSize(n) {
  let size = 2;
  while (size < n) size *= 2;
  return size;
}

// Standard seeding order so top seeds meet as late as possible:
// size 4 -> [1,4,2,3]; size 8 -> [1,8,4,5,2,7,3,6]
export function seedOrder(size) {
  let order = [1, 2];
  while (order.length < size) {
    const n = order.length * 2;
    const next = [];
    for (const s of order) {
      next.push(s);
      next.push(n + 1 - s);
    }
    order = next;
  }
  return order;
}

// Build the full bracket from an ordered player list (index 0 = top seed).
// Missing slots become byes: a player paired with null advances automatically.
export function buildBracket(playerIds) {
  if (!Array.isArray(playerIds) || playerIds.length < 2) {
    throw new Error('A tournament needs at least 2 players');
  }
  const size = bracketSize(playerIds.length);
  const order = seedOrder(size);
  const slots = order.map((seed) => playerIds[seed - 1] ?? null);

  const rounds = [];
  let matchCount = size / 2;
  let roundNo = 1;
  while (matchCount >= 1) {
    const matches = [];
    for (let i = 0; i < matchCount; i++) {
      matches.push({
        id: `r${roundNo}m${i + 1}`,
        a: roundNo === 1 ? slots[i * 2] ?? null : null,
        b: roundNo === 1 ? slots[i * 2 + 1] ?? null : null,
        winner: null,
        roomId: null,
        endedBy: null, // 'played' | 'forfeit' | 'inactivity' | 'disconnect' | 'walkover' | 'admin'
        score: null,   // final progress per player, so a decided game can be shown
        decidedAt: null,
      });
    }
    rounds.push({ round: roundNo, matches });
    matchCount /= 2;
    roundNo += 1;
  }

  const bracket = { size, rounds };
  resolveByes(bracket);
  return bracket;
}

// Byes exist ONLY in round 1, where an empty slot means "no such player".
// In every later round an empty slot means "waiting for the previous match's
// winner" — treating that as a walkover would crown a champion before the
// tournament had been played.
export function resolveByes(bracket) {
  const first = bracket.rounds[0];
  if (!first) return bracket;
  for (const m of first.matches) {
    if (m.winner) continue;
    const hasA = !!m.a;
    const hasB = !!m.b;
    if (hasA !== hasB) {
      m.winner = m.a || m.b;
      m.walkover = true;
      m.endedBy = 'walkover';
      m.decidedAt = Date.now();
      promote(bracket, m);
    }
  }
  return bracket;
}

// Where does this match's winner go next? Match i of round r feeds
// match floor(i/2) of round r+1, into slot a (even i) or b (odd i).
function nextSlot(bracket, match) {
  for (let r = 0; r < bracket.rounds.length - 1; r++) {
    const idx = bracket.rounds[r].matches.findIndex((m) => m.id === match.id);
    if (idx === -1) continue;
    const target = bracket.rounds[r + 1].matches[Math.floor(idx / 2)];
    return { target, slot: idx % 2 === 0 ? 'a' : 'b' };
  }
  return null; // the final has nowhere to advance to
}

function promote(bracket, match) {
  const next = nextSlot(bracket, match);
  if (next) next.target[next.slot] = match.winner;
}

// Record a result and advance the winner. Throws if the match isn't playable
// or the winner isn't actually in it — the bracket is authoritative.
export function reportWinner(bracket, matchId, winnerId, meta = {}) {
  const match = findMatch(bracket, matchId);
  if (!match) throw new Error('Unknown match');
  if (match.winner) throw new Error('Match already decided');
  if (winnerId !== match.a && winnerId !== match.b) {
    throw new Error('Winner is not a player in this match');
  }
  match.winner = winnerId;
  match.loser = winnerId === match.a ? match.b : match.a;
  match.endedBy = meta.endedBy || 'played';
  match.score = meta.score || null;
  match.decidedAt = meta.decidedAt || Date.now();
  promote(bracket, match);
  return bracket;
}

export function findMatch(bracket, matchId) {
  for (const round of bracket.rounds) {
    const m = round.matches.find((x) => x.id === matchId);
    if (m) return m;
  }
  return null;
}

// Matches that are ready to be played right now (both players known, no result).
export function pendingMatches(bracket) {
  const out = [];
  for (const round of bracket.rounds) {
    for (const m of round.matches) {
      if (!m.winner && m.a && m.b) out.push({ ...m, round: round.round });
    }
    // Only surface one round at a time — a later round can't start early.
    if (out.length) break;
  }
  return out;
}

// The champion, once the final is decided.
export function champion(bracket) {
  const final = bracket.rounds[bracket.rounds.length - 1]?.matches[0];
  return final?.winner || null;
}

export function isComplete(bracket) {
  return !!champion(bracket);
}

// Finishing order for prize distribution: champion first, then runner-up,
// then losers by how deep they got.
export function standings(bracket) {
  const out = [];
  const champ = champion(bracket);
  if (champ) out.push(champ);
  for (let r = bracket.rounds.length - 1; r >= 0; r--) {
    for (const m of bracket.rounds[r].matches) {
      if (m.loser && !out.includes(m.loser)) out.push(m.loser);
    }
  }
  return out;
}
