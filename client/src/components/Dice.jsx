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
//   • a plain face before the first roll of the game
// `color` rings the die in the colour of whoever rolled it.
export default function Dice({ value, rolling = false, idle = false, onRoll, size = 64, color = null }) {
  const pips = PIPS[value || 1];
  const clickable = !!onRoll && !rolling;

  return (
    <div
      className={`die ${rolling ? 'die-rolling' : ''} ${idle && !value ? 'die-idle' : ''} ${clickable ? 'die-clickable' : ''} ${value && color && !clickable ? `die-by c-${color}` : ''}`}
      style={{ width: size, height: size }}
      onClick={clickable ? onRoll : undefined}
      role={clickable ? 'button' : undefined}
      aria-label={clickable ? 'Dice: tap to roll' : value ? `Dice showing ${value}` : 'Dice'}
    >
      <div className="pip-grid">
        {Array.from({ length: 9 }).map((_, i) => (
          <span key={i} className={`pip ${pips.includes(i) ? 'on' : ''}`} />
        ))}
      </div>
    </div>
  );
}
