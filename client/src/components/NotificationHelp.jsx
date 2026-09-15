import { useState } from 'react';
import { detectBrowser, unblockSteps } from '../util/browser.js';
import { enablePush, pushPermission } from '../util/push.js';

// Shown when a player has BLOCKED notifications. A browser will never re-prompt
// after a block, so the only way back is through settings — and nobody finds
// that on their own. These are the actual taps for their actual browser.
export default function NotificationHelp({ onEnabled }) {
  const browser = detectBrowser();
  const steps = unblockSteps(browser);
  const [checking, setChecking] = useState(false);
  const [msg, setMsg] = useState(null);

  const recheck = async () => {
    setChecking(true);
    setMsg(null);
    try {
      if (pushPermission() === 'denied') {
        setMsg('Still blocked — make sure you changed it for this site, then try again.');
        return;
      }
      const result = await enablePush();
      if (result === 'subscribed') {
        setMsg(null);
        onEnabled?.();
      } else if (result === 'denied') {
        setMsg('Still blocked — check the steps above once more.');
      } else {
        setMsg('Notifications aren’t available in this browser.');
      }
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="unblock">
      <div className="unblock-head">
        Notifications are blocked in {browser.name}
      </div>
      <p className="unblock-intro">
        Your browser won’t ask again, so it has to be switched on by hand. It takes about 15 seconds:
      </p>
      <ol className="unblock-steps">
        {steps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
      <button className="btn btn-primary btn-block" onClick={recheck} disabled={checking}>
        {checking ? 'Checking…' : "I've allowed it — check again"}
      </button>
      <button className="btn btn-ghost btn-block btn-sm" onClick={() => window.location.reload()}>
        Reload page
      </button>
      {msg && <p className="error-text">{msg}</p>}
    </div>
  );
}
