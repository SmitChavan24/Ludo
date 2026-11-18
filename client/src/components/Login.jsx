import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../store/auth.js';
import { useAppConfig } from '../store/appConfig.js';
import { useGame } from '../store/game.js';
import { GOOGLE_CLIENT_ID } from '../config.js';
import { enablePush, isPushEnabled, pushPermission, pushSupported } from '../util/push.js';
import InstallPrompt from './InstallPrompt.jsx';
import NotificationHelp from './NotificationHelp.jsx';

export default function Login() {
  const [busy, setBusy] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [err, setErr] = useState(null);
  const loginGuest = useAuth((s) => s.loginGuest);
  const practiceEnabled = useAppConfig((s) => s.practiceEnabled);
  const pushRequired = useAppConfig((s) => s.pushRequiredForPractice || s.pushRequiredForTournaments);
  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [checkingPush, setCheckingPush] = useState(true);
  const googleBtn = useRef(null);

  useEffect(() => {
    let done = false;
    const settle = (v) => {
      if (done) return;
      done = true;
      setPushOn(!!v);
      setCheckingPush(false);
    };
    isPushEnabled().then(settle).catch(() => settle(false));
    // Belt and braces: never leave the card in a permanent "checking" state.
    const t = setTimeout(() => settle(false), 5000);
    return () => clearTimeout(t);
  }, []);

  // Notifications are required to play, so ask for them here rather than
  // ambushing the player mid-flow.
  const onAllowNotifications = async () => {
    setErr(null);
    setPushBusy(true);
    try {
      const result = await enablePush();
      if (result === 'subscribed') setPushOn(true);
      else if (result === 'denied') {
        // The panel below shows browser-specific steps — no need to repeat here.
      } else if (result === 'unsupported') {
        setErr('This browser cannot receive notifications. Install the app to your home screen and try again.');
      } else if (result === 'no-sw') {
        setErr('Notifications need the app to finish loading. Reload the page and try again.');
      } else {
        setErr('Notifications are not configured on the server yet.');
      }
    } catch {
      setErr('Could not enable notifications.');
    } finally {
      setPushBusy(false);
    }
  };

  // Render the real Google Sign-In button only if a client id is configured.
  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return;

    const setup = () => {
      if (!window.google?.accounts || !googleBtn.current) return;
      // Guard: StrictMode/dev remounts must not re-initialize GSI.
      // Verifying the token with Google and creating the session is a network
      // round trip; without this the button just sits there looking broken.
      window.__gsiHandler = async ({ credential }) => {
        setErr(null);
        setSigningIn(true);
        try {
          await useAuth.getState().loginGoogle(credential);
          // On success this component unmounts — leave the overlay up so the
          // card never flashes back to its idle state on the way out.
        } catch (e) {
          setErr(e.message);
          setSigningIn(false);
        }
      };
      if (!window.__gsiInit) {
        window.google.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          // Indirect through the global so a remount can't leave GSI calling
          // into a dead closure.
          callback: (res) => window.__gsiHandler?.(res),
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

  // Straight into a free game — no account, no name, nothing to fill in.
  const onPractice = async () => {
    setErr(null);
    setBusy(true);
    try {
      useGame.getState().requestPractice(); // App starts the game once connected
      await loginGuest();
    } catch (e) {
      useGame.getState().clearPendingPractice();
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login-card">
        {signingIn && (
          <div className="card-busy" role="status" aria-live="polite">
            <div className="spinner" />
            <div className="card-busy-text">Signing you in…</div>
            <div className="card-busy-sub">Setting up your account</div>
          </div>
        )}
        <div className="brand">
          <span className="brand-logo">🎲</span>
          <h1>CoinLudo</h1>
        </div>
        <p className="tagline">Play Ludo online. Compete in tournaments.</p>

        {/* Notifications are mandatory: tournaments are scheduled events, and a
            player who can't be reached can't be told their match has started. */}
        {pushRequired && !pushOn && !checkingPush && (
          <div className="push-required">
            <div className="push-required-head">🔔 Notifications are required to play</div>
            <p>
              Tournaments start at a fixed time and matches are drawn automatically.
              We need to notify you when your lobby opens and your match is ready —
              otherwise you lose your entry.
            </p>
            {pushPermission() !== 'denied' && (
              <button className="btn btn-primary btn-block btn-lg" disabled={pushBusy} onClick={onAllowNotifications}>
                {pushBusy ? <><span className="btn-spin" />Waiting for your answer…</> : 'Allow notifications'}
              </button>
            )}
            {!pushSupported() && (
              <p className="push-required-note">
                This browser can’t receive notifications. Install the app to your home screen first.
              </p>
            )}
            {pushPermission() === 'denied' && <NotificationHelp onEnabled={() => setPushOn(true)} />}
          </div>
        )}

        {practiceEnabled && (
          <>
            <button
              className="btn btn-primary btn-block btn-lg"
              disabled={busy || signingIn || (pushRequired && !pushOn)}
              onClick={onPractice}
            >
              {busy ? <><span className="btn-spin" />Starting…</> : '▶  Practice Match'}
            </button>
            <p className="practice-note">
              {pushRequired && !pushOn ? 'Allow notifications above to start playing' : 'Free game — play instantly, no sign-in'}
            </p>
          </>
        )}

        {GOOGLE_CLIENT_ID && (
          <>
            <div className="divider"><span>or sign in to join tournaments</span></div>
            <div ref={googleBtn} className="google-btn" />
          </>
        )}

        {err && <p className="error-text">{err}</p>}

        <InstallPrompt reason="Install CoinLudo for reliable match notifications." />

        <p className="fine-print">
          Sign in to join <b>Ludo tournaments</b> and climb the leaderboard.
        </p>
        <p className="eligibility">18+ only. Entry fees apply. Play where permitted by local law.</p>
      </div>
    </div>
  );
}
