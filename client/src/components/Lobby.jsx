import { useState } from 'react';
import { useAuth } from '../store/auth.js';
import { useGame } from '../store/game.js';
import { gameApi } from '../api/socket.js';
import { STAKES } from '../config.js';

export default function Lobby() {
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const claimDailyBonus = useAuth((s) => s.claimDailyBonus);
  const setError = useGame((s) => s.setError);

  const [players, setPlayers] = useState(2);
  const [stake, setStake] = useState(STAKES[1]);
  const [joinCode, setJoinCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [bonusMsg, setBonusMsg] = useState(null);
  const [copied, setCopied] = useState(null);

  const run = (fn) => async () => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const onQuick = run(() => gameApi.quick(stake, players));
  const onCreate = run(() => gameApi.create(stake, players));
  const onJoin = run(() => {
    if (!joinCode.trim()) throw new Error('Enter a room code');
    return gameApi.join(joinCode.trim());
  });

  const onBonus = async () => {
    try {
      const res = await claimDailyBonus();
      setBonusMsg(res.granted ? `+${res.amount} coins!` : 'Already claimed today');
      setTimeout(() => setBonusMsg(null), 2500);
    } catch (e) {
      setError(e.message);
    }
  };

  const copy = (text, what) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    });
  };

  const winRate = user.gamesPlayed ? Math.round((user.gamesWon / user.gamesPlayed) * 100) : 0;
  const tooPoor = stake > user.coins;

  return (
    <div className="lobby">
      <header className="topbar">
        <div className="brand-sm">🎲 CoinLudo</div>
        <div className="wallet-chip" title="Your coins">🪙 {user.coins.toLocaleString('en-IN')}</div>
      </header>

      <section className="profile-row">
        <div className="avatar" aria-hidden>
          {user.picture ? <img src={user.picture} alt="" /> : (user.name?.[0] || 'P').toUpperCase()}
        </div>
        <div className="profile-meta">
          <div className="profile-name">{user.name}</div>
          <div className="profile-sub">
            {user.gamesPlayed} played · {user.gamesWon} won · {winRate}% win
          </div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={logout}>Logout</button>
      </section>

      {/* Player ID — give this to support to top up coins */}
      <button className="id-chip" onClick={() => copy(user.id, 'id')} title="Tap to copy">
        <span>Player ID: <code>{user.id}</code></span>
        <span className="id-copy">{copied === 'id' ? 'Copied ✓' : '📋 Copy'}</span>
      </button>

      <button className="bonus-btn" onClick={onBonus}>
        🎁 Claim daily bonus {bonusMsg && <span className="bonus-flash">{bonusMsg}</span>}
      </button>

      {/* ── Random matchmaking (the main way to play) ── */}
      <section className="card hero-card">
        <h2>Play online</h2>
        <p className="card-sub">Get matched with random players. The game starts when the table is full.</p>

        <label className="field-label">Players</label>
        <div className="seg">
          {[2, 3, 4].map((n) => (
            <button key={n} className={`seg-btn ${players === n ? 'active' : ''}`} onClick={() => setPlayers(n)}>
              {n} Players
            </button>
          ))}
        </div>

        <label className="field-label">Stake</label>
        <div className="stake-grid">
          {STAKES.map((s) => (
            <button
              key={s}
              className={`stake-pill ${stake === s ? 'active' : ''} ${s > user.coins ? 'disabled' : ''}`}
              disabled={s > user.coins}
              onClick={() => setStake(s)}
            >
              🪙 {s}
            </button>
          ))}
        </div>

        <button className="btn btn-primary btn-block btn-lg" disabled={busy || tooPoor} onClick={onQuick}>
          ⚡ Find {players}-Player Match · 🪙 {stake}
        </button>
        <p className="hint">Winner takes the pot of 🪙 {stake * players}. Platform fee 5%.</p>
      </section>

      {/* ── Private friend game ── */}
      <section className="card">
        <h2>Play with friends</h2>
        <p className="card-sub">Create a private table and share the code, or join one.</p>
        <button className="btn btn-outline btn-block" disabled={busy || tooPoor} onClick={onCreate}>
          Create private room · {players}P · 🪙 {stake}
        </button>
        <div className="join-row">
          <input
            placeholder="Enter friend's room code"
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value)}
          />
          <button className="btn btn-secondary" disabled={busy} onClick={onJoin}>Join</button>
        </div>
      </section>

      <footer className="lobby-foot">Server-verified moves · Provably-fair dice 🔒</footer>
    </div>
  );
}
