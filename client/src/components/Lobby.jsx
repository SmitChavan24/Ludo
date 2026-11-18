import { useEffect, useState } from 'react';
import { useAuth } from '../store/auth.js';
import { useGame } from '../store/game.js';
import { useAppConfig } from '../store/appConfig.js';
import { gameApi } from '../api/socket.js';
import { apiFetch } from '../api/http.js';
import { shareInvite, inviteUrl } from '../util/share.js';
import StatsModal from './StatsModal.jsx';
import FairnessInfo from './FairnessInfo.jsx';
import WalletModal from './WalletModal.jsx';
import CoinShopModal from './CoinShopModal.jsx';
import InstallPrompt from './InstallPrompt.jsx';
import { takeReturnedCoinOrder } from '../util/coinOrder.js';
import Tournaments from './Tournaments.jsx';
import TournamentModal from './TournamentModal.jsx';

export default function Lobby() {
  const user = useAuth((s) => s.user);
  const accessToken = useAuth((s) => s.accessToken);
  const logout = useAuth((s) => s.logout);
  const claimDailyBonus = useAuth((s) => s.claimDailyBonus);
  const setError = useGame((s) => s.setError);
  const presence = useGame((s) => s.presence);
  const { stakes, playerCounts, rakeBips, referralBonus, dailyBonus, cashEnabled } = useAppConfig();

  const [players, setPlayers] = useState(playerCounts[0] ?? 2);
  const [stake, setStake] = useState(stakes[0] ?? 50);
  const [joinCode, setJoinCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [bonusMsg, setBonusMsg] = useState(null);
  const [copied, setCopied] = useState(null);
  const [statsTab, setStatsTab] = useState(null);
  const [showFairness, setShowFairness] = useState(false);
  const [referral, setReferral] = useState(null);
  const [shareMsg, setShareMsg] = useState(null);
  const [showWallet, setShowWallet] = useState(false);
  const [openTournament, setOpenTournament] = useState(null);
  const [cashInr, setCashInr] = useState(null);
  // Back from paying on pay.billtrack.me → open the shop to confirm the order.
  const [returnedOrder] = useState(() => takeReturnedCoinOrder());
  const [showShop, setShowShop] = useState(!!returnedOrder);

  // Keep selections inside whatever the server currently allows.
  useEffect(() => {
    if (!stakes.includes(stake)) setStake(stakes[0]);
    if (!playerCounts.includes(players)) setPlayers(playerCounts[0]);
  }, [stakes, playerCounts]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    apiFetch('/me/referral', { token: accessToken })
      .then(setReferral)
      .catch(() => {});
    if (!cashEnabled) return;
    apiFetch('/wallet', { token: accessToken })
      .then((wl) => setCashInr(wl.cashInr))
      .catch(() => {});
  }, [accessToken, showWallet, cashEnabled]);

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

  const onShareInvite = async () => {
    const res = await shareInvite(referral?.code, referral?.bonusPerInvite ?? referralBonus);
    if (res === 'copied') setShareMsg('Invite link copied!');
    else if (res === 'failed') setShareMsg('Could not open share');
    if (res) setTimeout(() => setShareMsg(null), 2500);
  };

  const winRate = user.gamesPlayed ? Math.round((user.gamesWon / user.gamesPlayed) * 100) : 0;
  const tooPoor = stake > user.coins;
  const pot = stake * players;

  return (
    <div className="lobby">
      <header className="topbar">
        <div className="brand-sm">🎲 CoinLudo</div>
        {cashEnabled ? (
          <button className="wallet-chip wallet-open" onClick={() => setShowWallet(true)} title="Open wallet">
            <span className="chip-cash">₹{Number(cashInr ?? 0).toLocaleString('en-IN')}</span>
            <span className="chip-sep" />
            <span className="chip-coins">🪙 {user.coins.toLocaleString('en-IN')}</span>
          </button>
        ) : (
          <button className="wallet-chip wallet-open" onClick={() => setShowShop(true)} title="Buy coins">
            <span className="chip-coins">🪙 {user.coins.toLocaleString('en-IN')}</span>
            <span className="chip-sep" />
            <span className="chip-cash">＋ Buy</span>
          </button>
        )}
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

      {dailyBonus > 0 && (
        <button className="bonus-btn" onClick={onBonus}>
          🎁 Claim daily bonus {bonusMsg && <span className="bonus-flash">{bonusMsg}</span>}
        </button>
      )}

      <div className="stats-row">
        <button className="stat-btn" onClick={() => setStatsTab('leaderboard')}>🏆 Leaderboard</button>
        <button className="stat-btn" onClick={() => setStatsTab('history')}>📜 My Games</button>
      </div>

      <Tournaments onOpen={setOpenTournament} />

      {/* ── Random matchmaking (the main way to play) ── */}
      <section className="card hero-card">
        <div className="hero-head">
          <h2>Play online</h2>
          <span className="live-chip" title="Players connected right now">
            <span className={`live-dot ${presence.online > 0 ? 'on' : ''}`} />
            {presence.online} online
          </span>
        </div>
        <p className="card-sub">
          {presence.waiting > 0
            ? `${presence.waiting} player${presence.waiting > 1 ? 's' : ''} looking for a match right now.`
            : 'Get matched with a random player. The game starts when the table is full.'}
        </p>

        {playerCounts.length > 1 && (
          <>
            <label className="field-label">Players</label>
            <div className="seg">
              {playerCounts.map((n) => (
                <button key={n} className={`seg-btn ${players === n ? 'active' : ''}`} onClick={() => setPlayers(n)}>
                  {n} Players
                </button>
              ))}
            </div>
          </>
        )}

        {stakes.length > 1 && (
          <>
            <label className="field-label">Stake</label>
            <div className="stake-grid">
              {stakes.map((s) => (
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
          </>
        )}

        <button className="btn btn-primary btn-block btn-lg" disabled={busy || tooPoor} onClick={onQuick}>
          ⚡ Play Now · 🪙 {stake}
        </button>
        <p className="hint">
          {tooPoor ? 'Not enough coins for this stake.' : `Winner takes 🪙 ${pot} · ${rakeBips / 100}% platform fee`}
        </p>
      </section>

      {/* ── Invite friends (referral) ── */}
      <section className="card invite-card">
        {(referral?.bonusPerInvite ?? referralBonus) > 0 ? (
          <>
            <h2>Invite friends, both get coins</h2>
            <p className="card-sub">
              You and your friend each get 🪙 {referral?.bonusPerInvite ?? referralBonus} when they join with your link.
            </p>
          </>
        ) : (
          <>
            <h2>Invite friends</h2>
            <p className="card-sub">Share your link and play Ludo together.</p>
          </>
        )}
        <button className="btn btn-whatsapp btn-block" onClick={onShareInvite}>
          Share invite link
        </button>
        {referral?.code && (
          <button className="code-row" onClick={() => copy(inviteUrl(referral.code), 'invite')}>
            <span>Your code: <b>{referral.code}</b></span>
            <span className="id-copy">{copied === 'invite' ? 'Copied ✓' : '📋 Copy link'}</span>
          </button>
        )}
        {referral?.invited > 0 && referral?.earned > 0 && (
          <p className="invite-stat">
            🎉 {referral.invited} joined · earned 🪙 {referral.earned.toLocaleString('en-IN')}
          </p>
        )}
        {shareMsg && <p className="invite-stat">{shareMsg}</p>}
      </section>


      <InstallPrompt />

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

      <button className="id-chip" onClick={() => copy(user.id, 'id')} title="Give this to support for coin top-ups">
        <span>Player ID: <code>{user.id}</code></span>
        <span className="id-copy">{copied === 'id' ? 'Copied ✓' : '📋 Copy'}</span>
      </button>

      <footer className="lobby-foot">
        <nav className="legal-links">
          <a href="/terms">Terms</a>
          <a href="/privacy">Privacy</a>
        </nav>
        <button className="foot-link" onClick={() => setShowFairness(true)}>
          Server-verified moves · Provably-fair dice 🔒 <span className="foot-more">How it works</span>
        </button>
      </footer>

      {statsTab && <StatsModal initialTab={statsTab} onClose={() => setStatsTab(null)} />}
      {showFairness && <FairnessInfo onClose={() => setShowFairness(false)} />}
      {showWallet && <WalletModal onClose={() => setShowWallet(false)} />}
      {showShop && <CoinShopModal returnedOrderId={returnedOrder} onClose={() => setShowShop(false)} />}
      {openTournament && (
        <TournamentModal
          id={openTournament}
          onClose={() => setOpenTournament(null)}
          onNeedWallet={() => { setOpenTournament(null); cashEnabled ? setShowWallet(true) : setShowShop(true); }}
        />
      )}
    </div>
  );
}
