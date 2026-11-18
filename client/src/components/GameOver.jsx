import { useState } from 'react';
import { useAuth } from '../store/auth.js';
import { shareWin } from '../util/share.js';

// End-of-game overlay. For a money game, the "Verify fairness" panel is the
// trust feature: it shows the revealed seeds so a player can recompute every
// roll and confirm nothing was rigged.
export default function GameOver({ result, myId, players, onAgain, isPractice = false }) {
  const [showFair, setShowFair] = useState(false);
  const [shared, setShared] = useState(null);
  const referralCode = useAuth((s) => s.user?.referralCode);

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
      <h2>{iWon ? 'You won!' : isPractice ? 'Computer won' : `${winner?.name || 'Opponent'} won`}</h2>
      {isPractice ? (
        <p className="result-sub">
          {iWon ? 'Nice — that was a practice game.' : 'Good try! That was a practice game.'}
        </p>
      ) : iWon ? (
        <p className="result-win">+ 🪙 {result.payout?.toLocaleString('en-IN')}</p>
      ) : (
        <p className="result-sub">Better luck next round.</p>
      )}
      {!isPractice && (
        <div className="result-meta">
          <span>Pot 🪙 {result.pot}</span>
          <span>Fee 🪙 {result.rake}</span>
        </div>
      )}

      {/* Practice is the top of the funnel — this is the moment to convert. */}
      {isPractice && (
        <div className="signin-cta">
          <p>Enjoyed it? Sign in to join <b>Ludo tournaments</b> and climb the leaderboard.</p>
          <button className="btn btn-primary btn-block" onClick={() => useAuth.getState().logout()}>
            Sign in with Google
          </button>
          <p className="eligibility">18+ only. Entry fees apply.</p>
        </div>
      )}

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

      {/* Winning is the moment people actually want to share — and the share
          carries their referral link, so a brag doubles as an invite. */}
      {iWon && !isPractice && (
        <button
          className="btn btn-whatsapp btn-block"
          onClick={async () => {
            const res = await shareWin({
              payout: result.payout,
              opponents: players?.filter((p) => p.id !== myId).map((p) => p.name),
              referralCode,
            });
            if (res === 'copied') setShared('Link copied — paste it anywhere!');
            else if (res === 'failed') setShared('Could not open share');
            if (res) setTimeout(() => setShared(null), 2500);
          }}
        >
          📣 Share your win
        </button>
      )}
      {shared && <p className="result-sub">{shared}</p>}

      <button className={`btn btn-block ${isPractice ? 'btn-outline' : 'btn-primary'}`} onClick={onAgain}>
        {isPractice ? 'Play another practice game' : 'Play again'}
      </button>
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
