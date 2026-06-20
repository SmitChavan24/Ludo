import { useEffect } from 'react';
import { useGame } from '../store/game.js';

// Tiny transient error banner driven by the game store's `error` field.
export default function Toast() {
  const error = useGame((s) => s.error);
  const clearError = useGame((s) => s.clearError);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(clearError, 3500);
    return () => clearTimeout(t);
  }, [error, clearError]);

  if (!error) return null;
  return (
    <div className="toast" role="alert" onClick={clearError}>
      {error}
    </div>
  );
}
