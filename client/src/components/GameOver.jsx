import { useState } from 'react';

// End-of-game overlay. For a money game, the "Verify fairness" panel is the
// trust feature: it shows the revealed seeds so a player can recompute every
// roll and confirm nothing was rigged.
export default function GameOver({ result, myId, players, onAgain }) {
  const [showFair, setShowFair] = useState(false);

  if (result.aborted) {
    return (
      <Overlay>
        <div className="result-emoji">↩️</div>
        <h2>Game cancelled</h2>
        <p className="result-sub">Inactive table — your stake of 🪙 {result.refunded} was refunded.</p>
        <button className="btn btn-primary btn-block" onClick={onAgain}>Back to Lobby</button>
      </Overlay>
    );
  }

  const iWon = result.winnerId === myId;
  const winner = players?.find((p) => p.id === result.winnerId);

  return (
    <Overlay>
      <div className="result-emoji">{iWon ? '🏆' : '🎯'}</div>
      <h2>{iWon ? 'You won!' : `${winner?.name || 'Opponent'} won`}</h2>
      {iWon ? (
        <p className="result-win">+ 🪙 {result.payout?.toLocaleString('en-IN')}</p>
      ) : (
        <p className="result-sub">Better luck next round.</p>
      )}
      <div className="result-meta">
        <span>Pot 🪙 {result.pot}</span>
        <span>Fee 🪙 {result.rake}</span>
      </div>

      {result.fairness && (
        <div className="fairness">
          <button className="link-btn" onClick={() => setShowFair((v) => !v)}>
            {showFair ? 'Hide' : '🔒 Verify fairness'}
          </button>
          {showFair && (
            <div className="fairness-body">
              <p>Rolls were committed before play. Recompute them yourself:</p>
              <Field label="Server seed (revealed)" value={result.fairness.serverSeed} />
              <Field label="Server seed hash (shown at start)" value={result.fairness.serverSeedHash} />
              <Field label="Client seed" value={result.fairness.clientSeed} />
              <Field label="Rolls" value={String(result.fairness.rolls)} />
            </div>
          )}
        </div>
      )}

      <button className="btn btn-primary btn-block" onClick={onAgain}>Play again</button>
    </Overlay>
  );
}

function Overlay({ children }) {
  return (
    <div className="overlay">
      <div className="result-card">{children}</div>
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <code className="field-value">{value}</code>
    </div>
  );
}
