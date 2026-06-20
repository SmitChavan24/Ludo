// ──────────────────────────────────────────────────────────────────────────
// Standard 4-player Ludo board geometry.
//
// The board is a single shared loop of 52 cells (indices 0..51). Each colour
// enters the loop at a fixed cell, travels 51 cells clockwise, then peels off
// into its own private 6-cell "home column" ending at the centre (home).
//
// We model a token's progress as a single integer `steps`:
//   steps = -1            -> token is in its yard (not yet on the board)
//   steps =  0 .. 50      -> on the shared loop (51 cells)
//   steps = 51 .. 56      -> in the home column (6 cells); 56 == finished/home
//
// The global loop cell for an on-loop token is:
//   (START_OFFSET[colour] + steps) % 52
//
// This single-integer model is what makes move validation cheap and total:
// there is no way to express an illegal position, so the server can never be
// tricked into one.
// ──────────────────────────────────────────────────────────────────────────

export const COLORS = ['red', 'green', 'yellow', 'blue'];

export const TOKENS_PER_PLAYER = 4;

// Size of the shared loop.
export const MAIN_TRACK_SIZE = 52;

// Cells a token occupies on the shared loop before turning into its home column
// (steps 0..50 inclusive).
export const MAIN_PATH_STEPS = 51;

// Home column length, including the final "home" cell (steps 51..56).
export const HOME_COLUMN_SIZE = 6;

// The step value that means "this token has reached home".
export const HOME_STEP = MAIN_PATH_STEPS + HOME_COLUMN_SIZE - 1; // 56

// Where each colour joins the shared loop (global cell index). Spaced 13 apart.
export const START_OFFSET = {
  red: 0,
  green: 13,
  yellow: 26,
  blue: 39,
};

// "Safe" cells on the shared loop: the four coloured start cells plus the four
// star cells (8 ahead of each start). A token sitting on a safe cell can never
// be captured. Home-column cells are implicitly safe (only the owner reaches
// them).
export const SAFE_CELLS = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

// Default rule toggles. Money games usually want a fast, deterministic race:
// first player to bring all four tokens home wins the whole pot.
export const DEFAULT_RULES = {
  // Game ends the instant one player finishes all four tokens.
  winOnFirstFinish: true,
  // Rolling a 6 grants another roll.
  extraTurnOnSix: true,
  // Three 6s in a row forfeits the turn (and the move it would have allowed).
  forfeitOnTripleSix: true,
  // Capturing an opponent grants another roll.
  extraTurnOnCapture: true,
  // Sending one of your own tokens home grants another roll.
  extraTurnOnReachHome: true,
  // Two same-colour tokens on one loop cell form a blockade opponents cannot
  // pass or capture. Off by default to keep v1 simple; the engine has a hook.
  blockades: false,
};

// Compute the global loop cell index for a given colour + steps.
// Returns null when the token is in the yard or the home column (not on loop).
export function globalCell(color, steps) {
  if (steps < 0 || steps > MAIN_PATH_STEPS - 1) return null;
  return (START_OFFSET[color] + steps) % MAIN_TRACK_SIZE;
}

// Is a token at this step value safe from capture?
export function isSafeStep(color, steps) {
  if (steps < 0) return true; // yard
  if (steps >= MAIN_PATH_STEPS) return true; // home column
  return SAFE_CELLS.has(globalCell(color, steps));
}
