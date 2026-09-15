// "How fairness works" — the trust page for a money game. Written for normal
// players first, with an exact recipe at the end for anyone technical enough
// to verify the dice themselves.
export default function FairnessInfo({ onClose }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="stats-card info-card" onClick={(e) => e.stopPropagation()}>
        <div className="stats-head">
          <h2 className="info-title">🔒 How CoinLudo stays fair</h2>
          <button className="x-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="stats-body info-body">
          <section>
            <h3>🖥️ The server checks every move</h3>
            <p>
              Your phone only <em>asks</em> to roll or move — the game itself runs on our
              server. Every roll and every move is validated against the official Ludo
              rules before it happens. A hacked or modified app can&rsquo;t move tokens
              illegally, roll extra dice, or touch anyone&rsquo;s coins.
            </p>
          </section>

          <section>
            <h3>🎲 Dice no one can rig — not even us</h3>
            <p>
              Before your game starts, the server locks in its dice sequence and shows you
              a fingerprint (hash) of it. Your app then adds its own random seed —
              <em> after</em> ours is already locked. Every roll is computed from both
              seeds together, so neither we nor any player can choose what comes next.
            </p>
            <p>
              When the game ends we reveal the server seed. Tap <b>&ldquo;Verify
              fairness&rdquo;</b> on the result screen to see it and check it matches the
              fingerprint shown at the start — proof the rolls were never changed mid-game.
            </p>
          </section>

          <section>
            <h3>🪙 Your coins are held in escrow</h3>
            <p>
              The moment a game starts, every player&rsquo;s stake moves into a locked pot.
              The winner is paid instantly and automatically when the game ends — minus our
              5% platform fee. If a game is cancelled (for example an inactive table),
              every stake is refunded in full. Every coin movement is recorded in a
              permanent ledger.
            </p>
          </section>

          <section>
            <h3>⏱️ No one can stall or dodge a loss</h3>
            <p>
              Each turn has a countdown — idle players get skipped. Leaving a game you&rsquo;re
              losing counts as a forfeit and pays your opponent. If someone disconnects,
              they get a short window to return; after that, the game settles in their
              opponent&rsquo;s favour. Games that go fully idle are cancelled and refunded.
            </p>
          </section>

          <section className="info-tech">
            <h3>🧪 For the technically curious</h3>
            <p>
              Roll <code>n</code> is derived as
              <code> HMAC-SHA256(serverSeed, clientSeed + ":" + n + ":" + round)</code>.
              The first byte below 252 maps to <code>(byte % 6) + 1</code> (rejection
              sampling, so all six faces are exactly equally likely). Check
              <code> SHA-256(serverSeed)</code> against the hash published at game start,
              then recompute any roll of the game yourself.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
