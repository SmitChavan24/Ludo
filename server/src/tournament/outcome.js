// How a match ended, in words a player can act on. A knockout is the sharpest
// moment in a tournament — being told only "you lost" invites the suspicion
// that something was rigged, so every exit names its cause and, where the game
// was decided rather than played out, the board it was decided on.

// Phrasing is written from the losing player's side, because that is the side
// that needs the explanation.
const LOST = {
  played: 'Lost on the board — your opponent got all four tokens home first',
  forfeit: 'You left the match, so it went to your opponent',
  inactivity: 'The match timed out and was decided on progress — you were behind',
  disconnect: "You disconnected and didn't return before the grace period ended",
  walkover: 'Walkover',
  admin: 'Recorded by the organiser',
};

const WON = {
  played: 'Won on the board — all four tokens home',
  forfeit: 'Your opponent left the match',
  inactivity: 'The match timed out and was decided on progress — you were ahead',
  disconnect: "Your opponent disconnected and didn't return",
  walkover: 'Walkover — no opponent in this round',
  admin: 'Recorded by the organiser',
};

export function reasonText(endedBy, won) {
  const table = won ? WON : LOST;
  return table[endedBy] || (won ? 'Won' : 'Lost');
}

// A one-line score summary, e.g. "3/4 home vs 4/4". Only meaningful when the
// match carried a final board; returns null otherwise.
export function scoreText(score, userId, opponentId) {
  if (!score) return null;
  const mine = score[userId];
  const theirs = opponentId ? score[opponentId] : null;
  if (!mine) return null;
  const side = (s) => `${s.home}/4 home`;
  return theirs ? `${side(mine)} vs ${side(theirs)}` : side(mine);
}

// Turn an engine standings array into the compact per-player score stored on a
// match. Keeping only what explains the result keeps brackets small.
export function scoreFromStandings(standings = []) {
  const out = {};
  for (const s of standings) {
    out[s.playerId] = { home: s.home, steps: s.steps, captures: s.captures, percent: s.percent };
  }
  return out;
}
