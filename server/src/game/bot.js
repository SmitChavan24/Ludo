import { MAIN_PATH_STEPS, HOME_STEP, SAFE_CELLS, globalCell } from './constants.js';

// ──────────────────────────────────────────────────────────────────────────
// Practice-mode bot.
//
// It plays through exactly the same authoritative engine as a human — it only
// CHOOSES among the legal moves the engine already generated. It cannot cheat,
// because it has no privileged path into the game state.
//
// The heuristic is deliberately "good but beatable": it takes obvious captures
// and finishes, gets tokens out, prefers safety — but it doesn't search ahead,
// so a thinking player wins often enough to stay motivated.
// ──────────────────────────────────────────────────────────────────────────

const BOT_PREFIX = 'bot:';

export const isBotId = (id) => typeof id === 'string' && id.startsWith(BOT_PREFIX);
export const makeBotId = () => `${BOT_PREFIX}${Math.random().toString(36).slice(2, 10)}`;

// How exposed is a token sitting at `steps`? Counts opponent tokens 1..6 behind
// it on the shared loop (i.e. able to land on it with one roll).
function threatLevel(state, me, steps) {
  if (steps < 0 || steps > MAIN_PATH_STEPS - 1) return 0; // yard or home column
  const cell = globalCell(me.color, steps);
  if (SAFE_CELLS.has(cell)) return 0;

  let threats = 0;
  for (const p of state.players) {
    if (p.id === me.id || p.eliminated) continue;
    for (const t of p.tokens) {
      if (t.state !== 'active') continue;
      const from = globalCell(p.color, t.steps);
      if (from == null) continue;
      // Distance forward around the 52-cell loop.
      const gap = (cell - from + 52) % 52;
      if (gap >= 1 && gap <= 6) threats++;
    }
  }
  return threats;
}

// Score a single candidate move. Higher is better.
function scoreMove(state, me, move, die) {
  let score = 0;

  // Sending an opponent home is almost always the best thing available.
  if (move.captures?.length) score += 100 + 25 * move.captures.length;

  // Bringing a token home ends its risk permanently.
  if (move.toStep >= HOME_STEP) score += 90;
  // Entering the home column (safe from capture from here on).
  else if (move.toStep >= MAIN_PATH_STEPS) score += 45;

  // Getting a new token onto the board is strong early — more options later.
  if (move.fromStep < 0) {
    const inYard = me.tokens.filter((t) => t.state === 'yard').length;
    score += 35 + inYard * 4;
  }

  // Prefer landing somewhere safe, and avoid parking in front of opponents.
  const landedThreat = threatLevel(state, me, move.toStep);
  const cell = move.toStep <= MAIN_PATH_STEPS - 1 ? globalCell(me.color, move.toStep) : null;
  if (cell != null && SAFE_CELLS.has(cell)) score += 18;
  score -= landedThreat * 14;

  // Escaping a token that is currently under threat is valuable.
  const escapedThreat = threatLevel(state, me, move.fromStep);
  score += escapedThreat * 12;

  // All else equal, push the furthest-along token (races toward finishing).
  score += move.toStep * 0.25;

  // Small jitter so repeated games don't play out identically.
  return score + Math.random() * 4;
}

// Choose which token to move from the engine's legal-move list.
export function chooseMove(state, botId) {
  const me = state.players.find((p) => p.id === botId);
  if (!me || !state.legalMoves?.length) return null;
  let best = state.legalMoves[0];
  let bestScore = -Infinity;
  for (const move of state.legalMoves) {
    const s = scoreMove(state, me, move, state.lastDie);
    if (s > bestScore) {
      bestScore = s;
      best = move;
    }
  }
  return best.tokenIndex;
}
