import { useEffect } from 'react';
import { useAuth, capturePendingReferral } from './store/auth.js';
import { useAppConfig } from './store/appConfig.js';
import { useGame } from './store/game.js';
import { connectSocket, disconnectSocket, gameApi } from './api/socket.js';
import Login from './components/Login.jsx';
import Lobby from './components/Lobby.jsx';
import Game from './components/Game.jsx';
import Toast from './components/Toast.jsx';

export default function App() {
  const user = useAuth((s) => s.user);
  const accessToken = useAuth((s) => s.accessToken);
  const status = useGame((s) => s.status);

  // Grab any invite code from the URL and load the server's lobby options once.
  useEffect(() => {
    capturePendingReferral();
    useAppConfig.getState().load();
  }, []);

  useEffect(() => {
    let active = true;
    if (accessToken) {
      (async () => {
        await useAuth.getState().bootstrap();
        if (!active) return;
        const token = useAuth.getState().accessToken;
        if (token) connectSocket(token);
      })();
    }
    return () => {
      active = false;
      disconnectSocket();
    };
  }, [accessToken]);

  const isGuest = !!user?.isGuest;
  const pendingPractice = useGame((s) => s.pendingPractice);
  const connected = useGame((s) => s.connected);
  const inGame = status === 'waiting' || status === 'playing' || status === 'finished';

  // Start the requested practice game — but only once the socket is actually
  // connected. Firing on `accessToken` alone raced the connection and failed
  // with "Not connected to the server".
  useEffect(() => {
    if (!isGuest || !accessToken || !pendingPractice || !connected) return;
    useGame.getState().clearPendingPractice();
    gameApi.practice().catch((e) => useGame.getState().setError(e.message));
  }, [isGuest, accessToken, pendingPractice, connected]);

  if (!user || !accessToken) return <Login />;

  if (isGuest) {
    // A guest out of a game with nothing requested goes back to the start
    // screen — but we do NOT end their session. Re-minting a guest each time
    // would burn rate limits and orphan their push subscription, which is
    // stored against the guest id.
    if (!inGame && !pendingPractice) return <Login />;
    return (
      <div className="app">
        {inGame ? <Game /> : <StartingPractice />}
        <Toast />
      </div>
    );
  }

  return (
    <div className="app">
      {inGame ? <Game /> : <Lobby />}
      <Toast />
    </div>
  );
}

// Shown only for the brief moment between requesting a practice game and the
// server seating you. Guests never get a menu — they go straight to a match.
function StartingPractice() {
  return (
    <div className="game waiting">
      <div className="waiting-card">
        <div className="spinner" />
        <h2>Starting practice match…</h2>
      </div>
    </div>
  );
}
