import { useEffect, useState } from 'react';
import { useAuth } from '../store/auth.js';
import { apiFetch } from '../api/http.js';

const rupees = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;
const coins = (n) => Number(n || 0).toLocaleString('en-IN');

const STATUS = {
  pending: 'Waiting for payment',
  credited: 'Coins added',
  failed: 'Could not start',
  expired: 'Expired',
  refunded: 'Refunded',
  mismatch: 'Under review',
};

// Buy coins. Payment happens on pay.billtrack.me; the server credits the coins
// only after the pay server confirms it, so this screen never grants anything.
// `returnedOrderId` is set when the player has just come back from paying.
export default function CoinShopModal({ onClose, returnedOrderId = null }) {
  const token = useAuth((s) => s.accessToken);
  const balance = useAuth((s) => s.user?.coins ?? 0);
  const setCoins = useAuth((s) => s.setCoins);
  const [packs, setPacks] = useState(null);
  const [enabled, setEnabled] = useState(true);
  const [orders, setOrders] = useState([]);
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);
  const [err, setErr] = useState(null);

  const loadOrders = () =>
    apiFetch('/shop/orders', { token }).then((d) => setOrders(d.orders)).catch(() => {});

  useEffect(() => {
    apiFetch('/shop/packs')
      .then((d) => {
        setEnabled(d.enabled);
        setPacks(d.packs);
      })
      .catch((e) => setErr(e.message));
    loadOrders();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Just back from pay.billtrack.me: ask OUR server (which asks the pay server)
  // a few times, because the payment can take a moment to be confirmed.
  useEffect(() => {
    if (!returnedOrderId) return;
    let stop = false;
    let timer;
    let tries = 0;
    setNotice('Checking your payment…');
    const check = async () => {
      try {
        const d = await apiFetch(`/shop/orders/${returnedOrderId}/sync`, { method: 'POST', token });
        if (stop) return;
        setCoins(d.coins);
        if (d.order.status === 'credited') {
          setNotice(`✅ ${coins(d.order.coins)} coins added!`);
          loadOrders();
          return;
        }
        if (d.order.status !== 'pending' || ++tries >= 8) {
          setNotice(
            d.order.status === 'pending'
              ? 'Payment not confirmed yet. If you paid, the coins will appear within a few minutes.'
              : `Order ${STATUS[d.order.status]?.toLowerCase() || d.order.status}.`,
          );
          loadOrders();
          return;
        }
        timer = setTimeout(check, 3000);
      } catch (e) {
        if (!stop) setNotice(e.message);
      }
    };
    check();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [returnedOrderId]); // eslint-disable-line react-hooks/exhaustive-deps

  const buy = async (packId) => {
    setErr(null);
    setBusy(packId);
    try {
      const { order } = await apiFetch('/shop/orders', { method: 'POST', token, body: { packId } });
      window.location.assign(order.checkoutUrl);
    } catch (e) {
      setErr(e.message);
      setBusy(null);
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="stats-card wallet-card" onClick={(e) => e.stopPropagation()}>
        <div className="stats-head">
          <h2 className="info-title">Coins</h2>
          <button className="x-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="stats-body">
          <div className="bal bal-coins shop-balance">
            <div className="bal-label">Your coins</div>
            <div className="bal-value">🪙 {coins(balance)}</div>
            <div className="bal-note">Use coins to play matches and enter tournaments.</div>
          </div>

          {notice && <p className="invite-stat">{notice}</p>}

          {!packs ? (
            <div className="spinner" />
          ) : !enabled ? (
            <p className="card-sub">The coin shop is closed right now. Claim your daily bonus to keep playing.</p>
          ) : (
            <div className="shop-packs">
              {packs.map((p) => (
                <button key={p.id} className="shop-pack" onClick={() => buy(p.id)} disabled={!!busy}>
                  <span className="shop-coins">🪙 {coins(p.coins)}</span>
                  <span className="shop-price">
                    {busy === p.id ? <><span className="btn-spin" />Opening…</> : rupees(p.priceInr)}
                  </span>
                </button>
              ))}
            </div>
          )}

          <p className="qr-note">
            Secure payment by UPI, card or netbanking on pay.billtrack.me. Coins are game currency only:
            they have no cash value and cannot be withdrawn, transferred or exchanged for money.{' '}
            <a href="/terms" target="_blank" rel="noreferrer">Terms</a>
          </p>

          {err && <p className="error-text">{err}</p>}

          {orders.length > 0 && (
            <div className="shop-orders">
              <div className="bal-label">Recent purchases</div>
              {orders.slice(0, 5).map((o) => (
                <div key={o.id} className="shop-order">
                  <span>🪙 {coins(o.coins)} · {rupees(o.amountInr)}</span>
                  <span className={`shop-status ${o.status}`}>{STATUS[o.status] || o.status}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
