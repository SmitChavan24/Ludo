import {
  COLORS,
  START_OFFSET,
  LOOP_COORDS,
  HOME_COORDS,
  SAFE_CELLS,
  YARD_RECTS,
  YARD_SLOTS,
  tokenCell,
} from '../game/coords.js';

// Precompute lookups for painting the static board.
const HOME_SET = Object.fromEntries(
  COLORS.map((c) => [c, new Set(HOME_COORDS[c].map(([r, k]) => `${r},${k}`))]),
);
const START_AT = {};
for (const c of COLORS) {
  const [r, k] = LOOP_COORDS[START_OFFSET[c]];
  START_AT[`${r},${k}`] = c;
}
const SAFE_SET = new Set([...SAFE_CELLS].map((i) => LOOP_COORDS[i].join(',')));

// Direction each colour travels off its start square (classic Ludo arrows).
const ARROW = { red: '▸', green: '▾', yellow: '◂', blue: '▴' };

function classify(r, c) {
  for (const color of COLORS) {
    const [yr, yc] = YARD_RECTS[color];
    if (r >= yr && r < yr + 6 && c >= yc && c < yc + 6) return { kind: 'yard', color };
  }
  for (const color of COLORS) {
    if (HOME_SET[color].has(`${r},${c}`)) return { kind: 'home', color };
  }
  if (r >= 6 && r <= 8 && c >= 6 && c <= 8) return { kind: 'center' };
  const key = `${r},${c}`;
  return { kind: 'path', start: START_AT[key], safe: SAFE_SET.has(key) };
}

const pct = (n) => `${(n / 15) * 100}%`;

export default function LudoBoard({ state, myId, onMove }) {
  // Static background: 225 cells.
  const cells = [];
  for (let r = 0; r < 15; r++) {
    for (let c = 0; c < 15; c++) {
      const info = classify(r, c);
      const cls = ['cell', `cell-${info.kind}`];
      if (info.color) cls.push(`c-${info.color}`);
      if (info.start) cls.push('cell-start', `c-${info.start}`);
      cls.push(info.kind === 'path' || info.kind === 'home' ? 'cell-track' : '');
      cells.push(
        <div key={`${r}-${c}`} className={cls.join(' ')}>
          {info.start ? (
            <span className="cell-arrow">{ARROW[info.start]}</span>
          ) : (
            info.safe && <span className="star">★</span>
          )}
        </div>,
      );
    }
  }

  // Yards get a rounded "tray" so the four parked tokens read as a group.
  const trays = COLORS.map((color) => {
    const [yr, yc] = YARD_RECTS[color];
    return (
      <div
        key={color}
        className={`yard-tray c-${color}`}
        style={{ top: pct(yr + 1), left: pct(yc + 1), width: pct(4), height: pct(4) }}
      />
    );
  });

  // The four classic "home slots" (rings) inside each yard.
  const slots = COLORS.flatMap((color) =>
    YARD_SLOTS[color].map(([r, c], i) => (
      <div
        key={`slot-${color}-${i}`}
        className={`yard-slot c-${color}`}
        style={{ top: pct(r + 0.5), left: pct(c + 0.5) }}
      />
    )),
  );

  // Whose turn + which token indices may move (only ever the local player's).
  const myTurn = state.currentPlayerId === myId && state.phase === 'awaitingMove';
  const movable = new Set(myTurn ? state.legalMoves.map((m) => m.tokenIndex) : []);

  // Build token list, then fan out any that share a cell so none hide.
  const placed = [];
  for (const p of state.players) {
    p.tokens.forEach((token, i) => {
      const [r, c] = tokenCell(p.color, token, i);
      placed.push({ id: `${p.id}-${i}`, color: p.color, r, c, mine: p.id === myId, tokenIndex: i, state: token.state });
    });
  }
  const stacks = {};
  for (const t of placed) {
    const key = `${t.r.toFixed(1)},${t.c.toFixed(1)}`;
    (stacks[key] ||= []).push(t);
  }

  const tokens = placed.map((t) => {
    const key = `${t.r.toFixed(1)},${t.c.toFixed(1)}`;
    const group = stacks[key];
    const idx = group.indexOf(t);
    const n = group.length;
    // Small fan offset (in cell fractions) when stacked.
    const off = n > 1 ? 0.22 : 0;
    const dx = n > 1 ? Math.cos((idx / n) * 2 * Math.PI) * off : 0;
    const dy = n > 1 ? Math.sin((idx / n) * 2 * Math.PI) * off : 0;
    const canMove = t.mine && movable.has(t.tokenIndex);
    return (
      <button
        key={t.id}
        className={`token c-${t.color} ${canMove ? 'token-movable' : ''} ${t.state === 'home' ? 'token-done' : ''}`}
        style={{ top: pct(t.r + 0.5 + dy), left: pct(t.c + 0.5 + dx) }}
        disabled={!canMove}
        onClick={() => canMove && onMove(t.tokenIndex)}
        aria-label={`${t.color} token ${t.tokenIndex + 1}`}
      />
    );
  });

  return (
    <div className="board-wrap">
      <div className="board">
        {cells}
        {trays}
        {slots}
        <div className="center-mark" />
        {tokens}
      </div>
    </div>
  );
}
