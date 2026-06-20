// Pip layout for each die face.
const PIPS = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

export default function Dice({ value, rolling, onRoll, disabled, label = 'Roll Dice' }) {
  const pips = value ? PIPS[value] : [];
  return (
    <div className="dice-area">
      <div className={`die ${rolling ? 'die-rolling' : ''}`} aria-label={value ? `Dice showing ${value}` : 'Dice'}>
        {Array.from({ length: 9 }).map((_, i) => (
          <span key={i} className={`pip ${pips.includes(i) ? 'on' : ''}`} />
        ))}
      </div>
      {onRoll && (
        <button className="btn btn-primary btn-roll" onClick={onRoll} disabled={disabled}>
          🎲 {label}
        </button>
      )}
    </div>
  );
}
