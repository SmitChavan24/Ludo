import { useEffect, useState } from 'react';
import { canInstall, promptInstall, onInstallStateChange, isStandalone, isIos } from '../util/install.js';

// "Add to home screen" nudge. Shown when the browser says we're installable,
// or on iOS (which has no install API) when running in a normal tab.
export default function InstallPrompt({ reason = null }) {
  const [, force] = useState(0);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return sessionStorage.getItem('coinludo-install-dismissed') === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => onInstallStateChange(() => force((n) => n + 1)), []);

  if (isStandalone() || dismissed) return null;
  const ios = isIos();
  if (!canInstall() && !ios) return null;

  const dismiss = () => {
    try {
      sessionStorage.setItem('coinludo-install-dismissed', '1');
    } catch {
      /* ignore */
    }
    setDismissed(true);
  };

  return (
    <div className="install-card">
      <div className="install-head">
        <span className="install-icon">📲</span>
        <div>
          <div className="install-title">Install CoinLudo</div>
          <div className="install-sub">
            {reason || 'Add it to your home screen — faster to open, and it works like a real app.'}
          </div>
        </div>
      </div>

      {ios ? (
        <p className="install-ios">
          In Safari: tap <b>Share</b> <span aria-hidden>􀈂</span> → <b>Add to Home Screen</b>.
          <br />
          <em>On iPhone, notifications only work after installing.</em>
        </p>
      ) : (
        <button className="btn btn-primary btn-block" onClick={() => promptInstall()}>
          Install app
        </button>
      )}
      <button className="btn btn-ghost btn-block btn-sm" onClick={dismiss}>Not now</button>
    </div>
  );
}
