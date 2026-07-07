import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../store/auth.js';
import { GOOGLE_CLIENT_ID } from '../config.js';

export default function Login() {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const loginDev = useAuth((s) => s.loginDev);
  const googleBtn = useRef(null);

  // Render the real Google Sign-In button only if a client id is configured.
  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return;

    const setup = () => {
      if (!window.google?.accounts || !googleBtn.current) return;
      // Guard: StrictMode/dev remounts must not re-initialize GSI.
      if (!window.__gsiInit) {
        window.google.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: async ({ credential }) => {
            try {
              await useAuth.getState().loginGoogle(credential);
            } catch (e) {
              setErr(e.message);
            }
          },
        });
        window.__gsiInit = true;
      }
      googleBtn.current.replaceChildren();
      window.google.accounts.id.renderButton(googleBtn.current, { theme: 'filled_blue', size: 'large', width: 280 });
    };

    // Reuse the GSI script if a previous mount already added it.
    const existing = document.querySelector('script[src^="https://accounts.google.com/gsi/client"]');
    if (window.google?.accounts) {
      setup();
    } else if (existing) {
      existing.addEventListener('load', setup, { once: true });
    } else {
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.onload = setup;
      document.body.appendChild(script);
    }
  }, []);

  const handleDev = async (e) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await loginDev(name.trim() || 'Player');
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login-card">
        <div className="brand">
          <span className="brand-logo">🎲</span>
          <h1>CoinLudo</h1>
        </div>
        <p className="tagline">Play Ludo with friends. Win coins. No download needed.</p>

        {GOOGLE_CLIENT_ID && (
          <>
            <div ref={googleBtn} className="google-btn" />
            <div className="divider"><span>or play as guest</span></div>
          </>
        )}

        <form onSubmit={handleDev} className="dev-login">
          <input
            type="text"
            placeholder="Enter your name"
            value={name}
            maxLength={24}
            onChange={(e) => setName(e.target.value)}
            aria-label="Your name"
          />
          <button type="submit" disabled={busy} className="btn btn-primary btn-block">
            {busy ? 'Starting…' : 'Start Playing'}
          </button>
        </form>

        {err && <p className="error-text">{err}</p>}

        <p className="fine-print">
          You start with <b>1,000 free coins</b>. Coins are for play only.
        </p>
      </div>
    </div>
  );
}
