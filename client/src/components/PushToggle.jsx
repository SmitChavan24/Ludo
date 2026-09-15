import { useEffect, useState } from 'react';
import { enablePush, disablePush, isPushEnabled, pushPermission, pushSupported } from '../util/push.js';
import NotificationHelp from './NotificationHelp.jsx';

// Opt-in control for match alerts. Deliberately a button the player presses:
// browsers reject permission prompts that aren't tied to a gesture, and an
// unprompted ask usually gets denied for good.
export default function PushToggle({ compact = false, onEnabled }) {
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    isPushEnabled().then(setOn).catch(() => {});
  }, []);

  // Nothing to offer if the browser can't do it, or it's already on.
  if (!pushSupported() || on) return null;
  const denied = pushPermission() === 'denied';

  const toggle = async () => {
    setBusy(true);
    setMsg(null);
    try {
      if (on) {
        await disablePush();
        setOn(false);
      } else {
        const result = await enablePush();
        if (result === 'subscribed') {
          setOn(true);
          onEnabled?.(); // lets the parent hide this card immediately
        }
        else if (result === 'denied') setMsg(null); // the help panel explains what to do
        else if (result === 'unavailable') setMsg('Notifications are not set up on this server yet.');
        else setMsg('This browser does not support notifications.');
      }
    } catch {
      setMsg('Could not update notifications.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={compact ? 'push-toggle compact' : 'push-toggle'}>
      {!denied && (
        <button className="btn btn-primary btn-block" onClick={toggle} disabled={busy}>
          {busy ? 'Waiting for your answer…' : '🔔 Turn on notifications'}
        </button>
      )}
      {denied && <NotificationHelp onEnabled={() => setOn(true)} />}
      {!denied && (
        <p className="push-note">We’ll tell you when your lobby opens and your match is ready.</p>
      )}
      {msg && <p className="error-text">{msg}</p>}
    </div>
  );
}
