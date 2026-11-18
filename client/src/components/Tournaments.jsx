import { useEffect, useState } from 'react';
import { tournamentApi } from '../api/tournaments.js';

const rupees = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

// Countdown to a fixed moment, in plain words.
function useCountdown(target) {
  const [left, setLeft] = useState(() => (target ? target - Date.now() : 0));
  useEffect(() => {
    if (!target) return;
    const t = setInterval(() => setLeft(target - Date.now()), 1000);
    return () => clearInterval(t);
  }, [target]);
  if (!target) return null;
  if (left <= 0) return 'starting now';
  const mins = Math.floor(left / 60000);
  if (mins < 60) return `in ${mins || 1}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `in ${hrs}h ${mins % 60}m`;
  return `in ${Math.floor(hrs / 24)}d`;
}

// Upcoming tournaments on the main page. This is the real-money product, so it
// sits above the casual game and states the prize plainly.
export default function Tournaments({ onOpen }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    Promise.all([tournamentApi.list('open'), tournamentApi.list('lobby')])
      .then(([a, b]) => {
        if (!alive) return;
        // Two queries feed one list, and a tournament can move from open to
        // lobby between them — key by id so it can never be shown twice.
        const byId = new Map();
        for (const t of [...(a.tournaments || []), ...(b.tournaments || [])]) byId.set(t.id, t);
        setItems([...byId.values()]);
      })
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, []);

  if (loading) {
    return (
      <section className="card tourney-card" aria-busy="true">
        <div className="hero-head"><h2>🏆 Tournaments</h2></div>
        <div className="sk-row" />
        <div className="sk-row short" />
      </section>
    );
  }
  if (!items.length) return null; // nothing scheduled — don't show an empty shell

  return (
    <section className="card tourney-card">
      <div className="hero-head">
        <h2>🏆 Tournaments</h2>
      </div>
      <p className="card-sub">Pay an entry fee, win a share of the pot. Starts at a fixed time.</p>
      <div className="tourney-list">
        {items.map((t) => (
          <TournamentRow key={t.id} t={t} onOpen={() => onOpen(t.id)} />
        ))}
      </div>
    </section>
  );
}

// The pot after the platform cut. Same arithmetic the server uses.
const poolFor = (entryFeeInr, players, rakeBips) => {
  const gross = (entryFeeInr || 0) * players;
  return gross - Math.floor((gross * (rakeBips || 0)) / 10000);
};

function TournamentRow({ t, onOpen }) {
  const countdown = useCountdown(t.startsAt);
  // Coin tournaments run the same maths in coins.
  const isCoins = t.entryType === 'coins';
  const fee = isCoins ? t.entryFeeCoins : t.entryFeeInr;
  const fmt = (n) => (isCoins ? `🪙 ${Number(n || 0).toLocaleString('en-IN')}` : rupees(n));
  // The pot is built from entry fees, so it grows as players join. Lead with
  // what is actually in it and show the full-table figure as the ceiling —
  // quoting only the "if full" number promises money nobody has paid in yet.
  const joined = t.players || 0;
  const pool = poolFor(fee, joined, t.rakeBips);
  const poolIfFull = poolFor(fee, t.maxPlayers, t.rakeBips);

  return (
    <button className="tourney-row" onClick={onOpen}>
      <div className="tourney-main">
        <div className="tourney-title">{t.title}</div>
        <div className="tourney-sub">
          {fee ? `${fmt(fee)} entry` : 'Free entry'} · {joined}/{t.maxPlayers} joined · {countdown}
          {t.status === 'lobby' && <span className="tourney-live"> · lobby open</span>}
        </div>
      </div>
      <div className="tourney-prize">
        <div className="tourney-prize-value">{fmt(pool)}</div>
        <div className="tourney-prize-label">prize pool</div>
        {poolIfFull > pool && <div className="tourney-prize-max">up to {fmt(poolIfFull)}</div>}
      </div>
    </button>
  );
}
