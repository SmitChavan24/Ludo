import { useCallback, useEffect, useState } from 'react';
import { isPushEnabled, pushSupported, pushPermission } from '../util/push.js';

// Shared notification state, so the lobby can decide whether the "Match alerts"
// card is worth showing at all. A card whose only message is "everything is
// already fine" is noise — it should disappear once there is nothing to do.
export function usePushStatus() {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setEnabled(await isPushEnabled());
    } catch {
      setEnabled(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    // Never leave the UI stuck deciding: settle after a moment regardless.
    const t = setTimeout(() => alive && setLoading(false), 5000);
    refresh().finally(() => {
      if (alive) clearTimeout(t);
    });
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [refresh]);

  const supported = pushSupported();
  return {
    enabled,
    loading,
    supported,
    denied: supported && pushPermission() === 'denied',
    // Only worth prompting when the browser can do it and it isn't already on.
    needsAction: supported && !enabled,
    refresh,
    setEnabled,
  };
}
