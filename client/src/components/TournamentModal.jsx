import { useEffect, useState } from 'react';
import { useAuth } from '../store/auth.js';
import { tournamentApi } from '../api/tournaments.js';

const rupees = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;
const when = (ms) => (ms ? new Date(ms).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

// One tournament: what it costs, what you can win, how to get in, and — once it
// starts — who you're playing.
export default function TournamentModal({ id, onClose, onNeedWallet }) {
  const me = useAuth((s) => s.user);
  const [d, setD] = useState(null);
  const [pay, setPay] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [utr, setUtr] = useState('');

  const load = async () => {
    try {
      const detail = await tournamentApi.detail(id);
      setD(detail);
      if (detail.tournament.entryType === 'manual' && !detail.joined) {
        setPay(await tournamentApi.payment(id).catch(() => null));
      }
    } catch (e) {
      setErr(e.message);
    }
  };
  useEffect(() => {
    load();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!d) {
    return (
      <div className="overlay" onClick={onClose}>
        <div className="stats-card" onClick={(e) => e.stopPropagation()}>
          <div className="stats-body">{err ? <p className="error-text">{err}</p> : <div className="spinner" />}</div>
        </div>
      </div>
    );
  }

  const t = d.tournament;
  const money = d.money;
  // Coin tournaments run the same maths in coins (money.unit === 'coins').
  const isCoins = t.entryType === 'coins';
  const fee = isCoins ? t.entryFeeCoins : t.entryFeeInr;
  const fmt = (n) => (isCoins ? `🪙 ${Number(n || 0).toLocaleString('en-IN')}` : rupees(n));
  const full = d.entries.length >= t.maxPlayers;

  const act = async (fn, okMsg) => {
    setErr(null);
    setBusy(true);
    try {
      await fn();
      setMsg(okMsg);
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="stats-card" onClick={(e) => e.stopPropagation()}>
        <div className="stats-head">
          <h2 className="info-title">{t.title}</h2>
          <button className="x-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="stats-body">
          <div className="t-summary">
            <div className="t-stat">
              <div className="t-stat-value">{fee ? fmt(fee) : 'Free'}</div>
              <div className="t-stat-label">entry</div>
            </div>
            <div className="t-stat">
              <div className="t-stat-value">{fmt(money.prizePoolInr)}</div>
              <div className="t-stat-label">prize pool</div>
              {money.ifFull.prizePoolInr > money.prizePoolInr && (
                <div className="t-stat-note">up to {fmt(money.ifFull.prizePoolInr)} if full</div>
              )}
            </div>
            <div className="t-stat">
              <div className="t-stat-value">{d.entries.length}/{t.maxPlayers}</div>
              <div className="t-stat-label">joined</div>
            </div>
          </div>

          <p className="card-sub">
            Starts {when(t.startsAt)} · winner takes {money.payouts[0] ? fmt(money.payouts[0].amountInr) : '—'}
            {money.payouts[1] ? `, runner-up ${fmt(money.payouts[1].amountInr)}` : ''}
          </p>
          {/* The pot is funded entirely by entry fees, so it is not a fixed
              advertised prize — say so plainly rather than letting a player
              assume the full-table figure is guaranteed. */}
          {fee > 0 && money.ifFull.prizePoolInr > money.prizePoolInr && (
            <p className="pool-note">
              The prize pool grows as players join — it reaches {fmt(money.ifFull.prizePoolInr)} if all{' '}
              {t.maxPlayers} seats fill.
            </p>
          )}
          {/* Say plainly that the entry fee is the ONLY charge — the platform
              fee is deducted from the pot, not added on top. */}
          {fee > 0 && (
            <p className="fee-note">
              You pay {fmt(fee)} — nothing else. Our {(t.rakeBips || 0) / 100}% fee comes out of the
              prize pool, never on top of your entry.
            </p>
          )}

          {/* ── Joining ── */}
          {d.joined ? (
            <div className="t-joined">
              ✅ You’re in. We’ll notify you when the lobby opens.
              {t.status === 'open' && (
                <button
                  className="btn btn-ghost btn-block btn-sm"
                  disabled={busy}
                  onClick={() => act(() => tournamentApi.withdraw(id), 'Left the tournament — entry refunded.')}
                >
                  Leave and get refunded
                </button>
              )}
            </div>
          ) : t.status !== 'open' ? (
            <p className="t-closed">Entries are closed for this tournament.</p>
          ) : full ? (
            <p className="t-closed">This tournament is full.</p>
          ) : d.myClaim?.status === 'pending' ? (
            <p className="t-closed">⏳ Your payment is being checked. You’ll get a notification once it’s confirmed.</p>
          ) : t.entryType === 'balance' ? (
            <>
              <button
                className="btn btn-primary btn-block btn-lg"
                disabled={busy}
                onClick={() => act(() => tournamentApi.join(id), "You're in!")}
              >
                {busy ? <><span className="btn-spin" />Joining…</> : `Join for ${fmt(fee)}`}
              </button>
              <p className="qr-note">Paid from your cash balance. <button className="link-btn" onClick={onNeedWallet}>Add money</button></p>
            </>
          ) : t.entryType === 'coins' ? (
            <>
              <button
                className="btn btn-primary btn-block btn-lg"
                disabled={busy}
                onClick={() => act(() => tournamentApi.join(id), "You're in!")}
              >
                {busy ? <><span className="btn-spin" />Joining…</> : `Join for ${fmt(t.entryFeeCoins)}`}
              </button>
              <p className="qr-note">
                You have {fmt(me?.coins)}. <button className="link-btn" onClick={onNeedWallet}>Buy coins</button>
              </p>
            </>
          ) : (
            // Manual: pay by UPI for this specific tournament, then submit the UTR.
            <div className="t-pay">
              <p className="card-sub">Pay {fmt(fee)} by UPI, then enter your payment reference.</p>
              {pay?.upiId && (
                <div className="pay-to">
                  <div className="pay-to-row"><span>Pay to</span><b>{pay.upiId}</b></div>
                  {pay.upiQrUrl && <img className="pay-qr" src={pay.upiQrUrl} alt="UPI QR" />}
                  {pay.payLink && <a className="btn btn-whatsapp btn-block" href={pay.payLink}>Open UPI app to pay</a>}
                </div>
              )}
              <input value={utr} onChange={(e) => setUtr(e.target.value)} placeholder="12-digit UPI reference (UTR)" />
              <button
                className="btn btn-primary btn-block"
                disabled={busy}
                onClick={() => act(() => tournamentApi.claim(id, { utr }), 'Submitted — we’ll confirm shortly.')}
              >
                {busy ? <><span className="btn-spin" />Submitting…</> : 'I have paid — submit'}
              </button>
              <p className="qr-note">You’re entered once we confirm the payment.</p>
            </div>
          )}

          {/* ── Players / bracket ── */}
          <h3 className="t-h3">Players</h3>
          <div className="t-players">
            {d.entries.length === 0 && <p className="card-sub">No one has joined yet — be first.</p>}
            {d.entries.map((e) => (
              <div key={e.userId} className={`t-player ${e.userId === me?.id ? 'me' : ''}`}>
                <span className="t-seed">{e.seed}</span>
                {e.name || 'Player'}{e.userId === me?.id && ' (you)'}
              </div>
            ))}
          </div>

          {d.milestone?.entered && (
            <div className={`t-milestone ${d.milestone.isChampion ? 'won' : ''} ${d.milestone.eliminated ? 'out' : ''}`}>
              <div className="tm-label">{d.milestone.label}</div>

              {/* One pip per round: filled = won, hollow = still to play. */}
              {d.milestone.totalRounds > 0 && (
                <div className="tm-steps" aria-label={`Round ${d.milestone.round} of ${d.milestone.totalRounds}`}>
                  {Array.from({ length: d.milestone.totalRounds }, (_, i) => (
                    <span
                      key={i}
                      className={`tm-pip ${i < d.milestone.winsSoFar ? 'done' : ''} ${
                        i === d.milestone.winsSoFar && !d.milestone.eliminated ? 'now' : ''
                      }`}
                    />
                  ))}
                </div>
              )}

              <div className="tm-meta">
                {d.milestone.eliminated || d.milestone.isChampion ? (
                  <>
                    {d.milestone.place && <span>Finished {d.milestone.place} of {d.milestone.players}</span>}
                    <span>{d.milestone.prizeAtCurrentPlace > 0 ? `Prize ${fmt(d.milestone.prizeAtCurrentPlace)}` : 'No prize'}</span>
                  </>
                ) : (
                  <>
                    <span>Round {Math.max(1, d.milestone.round)} of {d.milestone.totalRounds}</span>
                    <span>Title pays {fmt(d.milestone.prizeIfChampion)}</span>
                  </>
                )}
              </div>

              {d.milestone.exit && (
                <div className="tm-exit">
                  <div className="tm-exit-why">{d.milestone.exit.reason}</div>
                  {d.milestone.exit.score && <div className="tm-exit-score">Final board: {d.milestone.exit.score}</div>}
                </div>
              )}

              {d.milestone.journey?.length > 0 && (
                <ol className="tm-journey">
                  {d.milestone.journey.map((leg) => (
                    <li key={leg.matchId} className={`tmj ${leg.result}`}>
                      <span className="tmj-round">R{leg.round}</span>
                      <span className="tmj-body">
                        <span className="tmj-vs">
                          {leg.opponentName ? `vs ${leg.opponentName}` : 'No opponent'}
                        </span>
                        <span className="tmj-reason">{leg.reason}</span>
                      </span>
                      <span className="tmj-mark">
                        {leg.result === 'won' ? 'WON' : leg.result === 'lost' ? 'OUT' : '···'}
                      </span>
                    </li>
                  ))}
                </ol>
              )}

              {d.milestone.nextMatch && (
                <div className="tm-next">
                  {d.milestone.nextMatch.waitingForOpponent
                    ? 'Waiting for your opponent to be decided'
                    : `Next up: ${d.milestone.nextMatch.opponentName}`}
                </div>
              )}
            </div>
          )}

          {d.playing?.length > 0 && (
            <>
              <h3 className="t-h3">Live matches</h3>
              <div className="t-players">
                {d.playing.map((m) => {
                  const names = Object.fromEntries(d.entries.map((e) => [e.userId, e.name || 'Player']));
                  const mine = m.a === me?.id || m.b === me?.id;
                  return (
                    <div key={m.id} className={`t-match ${mine ? 'me' : ''}`}>
                      {names[m.a] || '?'} vs {names[m.b] || '?'}
                      {mine && <b> — your match</b>}
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {t.status === 'finished' && t.winnerId && (
            <p className="t-winner">🏆 Winner: {d.entries.find((e) => e.userId === t.winnerId)?.name || 'Player'}</p>
          )}

          {msg && <p className="invite-stat">{msg}</p>}
          {err && <p className="error-text">{err}</p>}
        </div>
      </div>
    </div>
  );
}
