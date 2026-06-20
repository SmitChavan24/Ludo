// ──────────────────────────────────────────────────────────────────────────
// Board geometry for rendering on a 15×15 grid ([row, col], 0-indexed).
//
// LOOP_COORDS[i] is the pixel cell for the engine's GLOBAL loop index i
// (0..51). The order and the per-colour offsets MUST match the server's
// constants.js: red=0, green=13, yellow=26, blue=39, going clockwise. That's
// the whole contract — the server decides positions, the client just draws them.
// ──────────────────────────────────────────────────────────────────────────

export const COLORS = ['red', 'green', 'yellow', 'blue'];
export const START_OFFSET = { red: 0, green: 13, yellow: 26, blue: 39 };

// 52 cells, clockwise, starting at red's entry square [6,1].
export const LOOP_COORDS = [
  [6, 1], [6, 2], [6, 3], [6, 4], [6, 5],            // 0-4
  [5, 6], [4, 6], [3, 6], [2, 6], [1, 6], [0, 6],    // 5-10
  [0, 7],                                            // 11
  [0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8],    // 12-17  (green start = 13 -> [1,8])
  [6, 9], [6, 10], [6, 11], [6, 12], [6, 13], [6, 14], // 18-23
  [7, 14],                                           // 24
  [8, 14], [8, 13], [8, 12], [8, 11], [8, 10], [8, 9], // 25-30 (yellow start = 26 -> [8,13])
  [9, 8], [10, 8], [11, 8], [12, 8], [13, 8], [14, 8], // 31-36
  [14, 7],                                           // 37
  [14, 6], [13, 6], [12, 6], [11, 6], [10, 6], [9, 6], // 38-43 (blue start = 39 -> [13,6])
  [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0],    // 44-49
  [7, 0],                                            // 50
  [6, 0],                                            // 51
];

// Each colour's private home column (engine steps 51..56, index 0..5).
export const HOME_COORDS = {
  red: [[7, 1], [7, 2], [7, 3], [7, 4], [7, 5], [7, 6]],
  green: [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7], [6, 7]],
  yellow: [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9], [7, 8]],
  blue: [[13, 7], [12, 7], [11, 7], [10, 7], [9, 7], [8, 7]],
};

// Four parking slots inside each corner yard (token resting spots).
export const YARD_SLOTS = {
  red: [[1.5, 1.5], [1.5, 3.5], [3.5, 1.5], [3.5, 3.5]],
  green: [[1.5, 10.5], [1.5, 12.5], [3.5, 10.5], [3.5, 12.5]],
  yellow: [[10.5, 10.5], [10.5, 12.5], [12.5, 10.5], [12.5, 12.5]],
  blue: [[10.5, 1.5], [10.5, 3.5], [12.5, 1.5], [12.5, 3.5]],
};

// The eight safe loop cells (start squares + star squares). Mirrors the server.
export const SAFE_CELLS = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

// Corner yard rectangles [rowStart, colStart] (each 6×6).
export const YARD_RECTS = {
  red: [0, 0],
  green: [0, 9],
  yellow: [9, 9],
  blue: [9, 0],
};

// Resolve a token's grid cell from the server's serialized token + its colour
// and slot index. Returns [row, col].
export function tokenCell(color, token, slotIndex) {
  if (token.cell != null) return LOOP_COORDS[token.cell];
  if (token.homeIndex != null) return HOME_COORDS[color][token.homeIndex];
  return YARD_SLOTS[color][slotIndex];
}
