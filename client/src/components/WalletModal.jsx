import { useEffect, useState } from 'react';
import { useAuth } from '../store/auth.js';
import { apiFetch } from '../api/http.js';
import UpiQrScanner from './UpiQrScanner.jsx';

const rupees = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

// The wallet. Two balances, deliberately shown as clearly different things:
// cash is real money you can withdraw; coins are free and never convert to cash.
export default function WalletModal({ onClose }) {
  const token = useAuth((s) => s.accessToken);
  const setCoins = useAuth((s) => s.setCoins);
  const [tab, setTab] = useState('add');
  const [w, setW] = useState(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);

  const load = async () => {
    try {
      const data = await apiFetch('/wallet', { token });
      setW(data);
      setCoins(data.coins);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="overlay" onClick={onClose}>
      <div className="stats-card wallet-card" onClick={(e) => e.stopPropagation()}>
        <div className="stats-head">
          <h2 className="info-title">Wallet</h2>
          <button className="x-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {loading ? (
          <div className="stats-body"><div className="spinner" /></div>
        ) : (
          <div className="stats-body">
            <div className="balances balances-3">
              <div className="bal bal-cash">
                <div className="bal-label">Deposit</div>
                <div className="bal-value">{rupees(w?.balances?.deposit)}</div>
                <div className="bal-note">Play with it</div>
              </div>
              <div className="bal bal-win">
                <div className="bal-label">Winnings</div>
                <div className="bal-value">{rupees(w?.balances?.winnings)}</div>
                <div className="bal-note">Withdrawable</div>
              </div>
              <div className="bal bal-coins">
                <div className="bal-label">Coins</div>
                <div className="bal-value">🪙 {Number(w?.coins || 0).toLocaleString('en-IN')}</div>
                <div className="bal-note">Practice only</div>
              </div>
            </div>

            <div className="seg small">
              <button className={`seg-btn ${tab === 'add' ? 'active' : ''}`} onClick={() => setTab('add')}>How it works</button>
              {/* Withdrawal is only meaningful once a tournament has been won —
                  offering an empty form to everyone else just invites confusion. */}
              {(w?.balances?.withdrawable ?? 0) > 0 && (
                <button className={`seg-btn ${tab === 'out' ? 'active' : ''}`} onClick={() => setTab('out')}>
                  Withdraw {rupees(w.balances.withdrawable)}
                </button>
              )}
            </div>

            {(w?.balances?.withdrawable ?? 0) === 0 && (
              <p className="win-hint">🏆 Win a tournament to unlock withdrawals — prize money is withdrawable.</p>
            )}

            {tab === 'add' || (w?.balances?.withdrawable ?? 0) === 0 ? (
              <HowMoneyWorks wallet={w} />
            ) : (
              <Withdraw wallet={w} token={token} onDone={(m) => { setMsg(m); load(); }} />
            )}

            {msg && <p className="invite-stat">{msg}</p>}
            {err && <p className="error-text">{err}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

// There is no free-form top-up: a player never chooses an amount. Money enters
// only by paying the exact entry fee of a tournament, which the admin sets.
function HowMoneyWorks({ wallet }) {
  return (
    <div className="pay-panel">
      <div className="how-step">
        <span className="how-num">1</span>
        <div>
          <b>Join a tournament</b>
          <p>Pay the exact entry fee shown on it — nothing more. That fee goes straight into the prize pool.</p>
        </div>
      </div>
      <div className="how-step">
        <span className="how-num">2</span>
        <div>
          <b>Win a prize</b>
          <p>Prize money lands in your <b>Winnings</b> balance.</p>
        </div>
      </div>
      <div className="how-step">
        <span className="how-num">3</span>
        <div>
          <b>Withdraw it</b>
          <p>Send your winnings to any UPI ID. Winnings can also pay for your next entry.</p>
        </div>
      </div>
      {wallet?.pendingDeposit && (
        <p className="pay-status">
          ⏳ A payment of {rupees(wallet.pendingDeposit.amountInr)} is being checked.
        </p>
      )}
    </div>
  );
}

function Withdraw({ wallet, token, onDone }) {
  const [amount, setAmount] = useState(wallet?.limits?.minWithdrawalInr || 100);
  const [upiId, setUpiId] = useState('');
  const [payee, setPayee] = useState(null);
  const [showScanner, setShowScanner] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const pending = wallet?.pendingWithdrawal;

  if (pending) {
    return (
      <div className="pay-panel">
        <p className="pay-status">⏳ Withdrawal of {rupees(pending.amountInr)} is being processed.</p>
        <p className="card-sub">Going to {pending.upiId}. You’ll be notified when it’s sent.</p>
      </div>
    );
  }

  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await apiFetch('/wallet/withdraw', { method: 'POST', token, body: { amountInr: Number(amount), upiId } });
      onDone('Withdrawal requested — we’ll send it shortly.');
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="pay-panel" onSubmit={submit}>
      <p className="card-sub">
        Withdraw your tournament winnings to any UPI ID. Your deposit balance stays available to play with.
      </p>

      <label className="field-label">Amount (₹)</label>
      <input
        type="number"
        min={wallet?.limits?.minWithdrawalInr || 100}
        max={Math.min(wallet?.balances?.withdrawable || 0, wallet?.limits?.maxWithdrawalInr || 10000)}
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <p className="qr-note">
        Winnings available {rupees(wallet?.balances?.withdrawable)} · min {rupees(wallet?.limits?.minWithdrawalInr)} · max {rupees(wallet?.limits?.maxWithdrawalInr)} per request
      </p>

      <label className="field-label">Your UPI ID</label>
      <input value={upiId} onChange={(e) => { setUpiId(e.target.value); setPayee(null); }} placeholder="yourname@bank" />

      {showScanner ? (
        <UpiQrScanner
          onClose={() => setShowScanner(false)}
          onFound={(id, name) => {
            setUpiId(id);
            setPayee(name);
            setShowScanner(false);
          }}
        />
      ) : (
        <button type="button" className="btn btn-outline btn-block" onClick={() => setShowScanner(true)}>
          📷 Scan / upload my UPI QR
        </button>
      )}
      {payee && <p className="invite-stat">Scanned: {payee}</p>}

      <button className="btn btn-primary btn-block" disabled={busy}>
        {busy ? <><span className="btn-spin" />Requesting…</> : 'Request withdrawal'}
      </button>
      <p className="qr-note">Double-check the UPI ID — payouts cannot be reversed.</p>
      {err && <p className="error-text">{err}</p>}
    </form>
  );
}
