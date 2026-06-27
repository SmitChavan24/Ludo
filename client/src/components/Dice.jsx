// Pip layout (which of the 3×3 cells are filled) for each die face.
const PIPS = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

// A natural-looking die. Always shows something:
//   • a tumbling face while `rolling`
//   • the rolled value once settled
//   • a "?" before the first roll (so it's never a blank white box)
export default function Dice({ value, rolling = false, idle = false, onRoll, size = 64 }) {
  const showPips = rolling || !!value;
  const pips = PIPS[value || 1];
  const clickable = !!onRoll && !rolling;

  return (
    <div
      className={`die ${rolling ? 'die-rolling' : ''} ${idle && !value ? 'die-idle' : ''} ${clickable ? 'die-clickable' : ''}`}
      style={{ width: size, height: size }}
      onClick={clickable ? onRoll : undefined}
      role={clickable ? 'button' : undefined}
      aria-label={value ? `Dice showing ${value}` : 'Dice — tap to roll'}
    >
      {showPips ? (
        <div className="pip-grid">
          {Array.from({ length: 9 }).map((_, i) => (
            <span key={i} className={`pip ${pips.includes(i) ? 'on' : ''}`} />
          ))}
        </div>
      ) : (
        <span className="die-q">?</span>
      )}
    </div>
  );
}
