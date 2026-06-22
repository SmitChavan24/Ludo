import { useEffect, useState } from 'react';
import { useAuth } from '../store/auth.js';
import { fetchMyGames, fetchLeaderboard } from '../api/stats.js';

const fmtDate = (ts) => new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
const medal = (rank) => (rank <= 3 ? ['🥇', '🥈', '🥉'][rank - 1] : rank);

export default function StatsModal({ initialTab = 'leaderboard', onClose }) {
  const me = useAuth((s) => s.user);
  const [tab, setTab] = useState(initialTab);
  const [period, setPeriod] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [games, setGames] = useState([]);
  const [board, setBoard] = useState([]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    const load = tab === 'history' ? fetchMyGames(30) : fetchLeaderboard(period, 50);
    load
      .then((d) => {
        if (!active) return;
        if (tab === 'history') setGames(d.games || []);
        else setBoard(d.leaderboard || []);
      })
      .catch((e) => active && setError(e.message))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [tab, period]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="stats-card" onClick={(e) => e.stopPropagation()}>
        <div className="stats-head">
          <div className="tabs">
            <button className={`tab ${tab === 'leaderboard' ? 'active' : ''}`} onClick={() => setTab('leaderboard')}>🏆 Leaderboard</button>
            <button className={`tab ${tab === 'history' ? 'active' : ''}`} onClick={() => setTab('history')}>📜 My Games</button>
          </div>
          <button className="x-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {tab === 'leaderboard' && (
          <div className="seg small">
            <button className={`seg-btn ${period === 'all' ? 'active' : ''}`} onClick={() => setPeriod('all')}>All time</button>
            <button className={`seg-btn ${period === 'week' ? 'active' : ''}`} onClick={() => setPeriod('week')}>This week</button>
          </div>
        )}

        <div className="stats-body">
          {loading ? (
            <div className="spinner" />
          ) : error ? (
            <p className="error-text">{error}</p>
          ) : tab === 'leaderboard' ? (
            <Leaderboard rows={board} meId={me.id} />
          ) : (
            <History games={games} meId={me.id} />
          )}
        </div>
      </div>
    </div>
  );
}

function Leaderboard({ rows, meId }) {
  if (!rows.length) return <Empty text="No games played yet — be the first on the board!" />;
  return (
    <div className="lb-list">
      {rows.map((r) => (
        <div key={r.userId} className={`lb-row ${r.userId === meId ? 'me' : ''}`}>
          <span className="lb-rank">{medal(r.rank)}</span>
          <div className="lb-meta">
            <div className="lb-name">{r.name || 'Player'}{r.userId === meId && ' (you)'}</div>
            <div className="lb-sub">{r.wins}/{r.games} won</div>
          </div>
          <span className={`net ${r.net >= 0 ? 'pos' : 'neg'}`}>🪙 {r.net >= 0 ? '+' : ''}{r.net.toLocaleString('en-IN')}</span>
        </div>
      ))}
    </div>
  );
}

function History({ games, meId }) {
  if (!games.length) return <Empty text="You haven't finished a game yet." />;
  return (
    <div className="hist-list">
      {games.map((g) => {
        const opp = g.players.filter((p) => p.userId !== meId).map((p) => p.name || 'Player').join(', ');
        return (
          <div key={g.gameId} className="hist-row">
            <span className={`hist-badge ${g.isWinner ? 'win' : 'loss'}`}>{g.isWinner ? 'WON' : 'LOST'}</span>
            <div className="hist-meta">
              <div className="hist-vs">vs {opp || '—'}</div>
              <div className="hist-sub">Stake 🪙 {g.stake} · {fmtDate(g.endedAt)}</div>
            </div>
            <span className={`net ${g.net >= 0 ? 'pos' : 'neg'}`}>{g.net >= 0 ? '+' : ''}{g.net}</span>
          </div>
        );
      })}
    </div>
  );
}

function Empty({ text }) {
  return <p className="empty-text">{text}</p>;
}
