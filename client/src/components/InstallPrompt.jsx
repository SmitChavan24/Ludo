import { useEffect, useState } from 'react';
import { canInstall, promptInstall, onInstallStateChange, isStandalone, isIos } from '../util/install.js';

// "Install the app" card. Shown on every visit until CoinLudo is installed:
// "Not now" only hides it for the current visit (sessionStorage), so it comes
// back next time. It disappears for good once installed, or when the app is
// opened from the home screen.
//
// Where the browser offers its own install dialog (Chrome / Edge on Android
// and desktop) one tap opens it. Everywhere else it shows the manual steps.
const KEY = 'coinludo-install-snoozed';

const isAndroid = () => typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent);

export default function InstallPrompt({ reason = null }) {
  const [, force] = useState(0);
  const [installed, setInstalled] = useState(isStandalone());
  const [snoozed, setSnoozed] = useState(() => {
    try {
      return sessionStorage.getItem(KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(
    () =>
      onInstallStateChange(() => {
        setInstalled(isStandalone());
        force((n) => n + 1);
      }),
    [],
  );
  useEffect(() => {
    const done = () => setInstalled(true);
    window.addEventListener('appinstalled', done);
    return () => window.removeEventListener('appinstalled', done);
  }, []);

  if (installed || isStandalone() || snoozed) return null;

  const snooze = () => {
    try {
      sessionStorage.setItem(KEY, '1');
    } catch {
      /* ignore */
    }
    setSnoozed(true);
  };

  const install = async () => {
    const outcome = await promptInstall();
    if (outcome === 'accepted') setInstalled(true);
  };

  return (
    <div className="install-card">
      <div className="install-head">
        <span className="install-icon">📲</span>
        <div>
          <div className="install-title">Install CoinLudo</div>
          <div className="install-sub">
            {reason || 'Play from your home screen: opens instantly, full screen, like a real app.'}
          </div>
        </div>
      </div>

      {canInstall() ? (
        <button className="btn btn-primary btn-block" onClick={install}>
          Install app
        </button>
      ) : isIos() ? (
        <ol className="install-steps">
          <li>Tap <b>Share</b> (the square with an arrow) at the bottom of Safari.</li>
          <li>Scroll down and tap <b>Add to Home Screen</b>.</li>
          <li>Tap <b>Add</b>.</li>
        </ol>
      ) : isAndroid() ? (
        <ol className="install-steps">
          <li>Tap the browser menu <b>⋮</b> (top right).</li>
          <li>Tap <b>Install app</b> or <b>Add to Home screen</b>.</li>
          <li>Tap <b>Install</b>.</li>
        </ol>
      ) : (
        <ol className="install-steps">
          <li>Click the <b>install icon</b> at the right end of the address bar,</li>
          <li>or open the browser menu and choose <b>Install CoinLudo</b>.</li>
        </ol>
      )}
      <button className="btn btn-ghost btn-block btn-sm" onClick={snooze}>Not now</button>
    </div>
  );
}
