import { useEffect } from 'react';
import { useAuth } from './store/auth.js';
import { useGame } from './store/game.js';
import { connectSocket, disconnectSocket } from './api/socket.js';
import Login from './components/Login.jsx';
import Lobby from './components/Lobby.jsx';
import Game from './components/Game.jsx';
import Toast from './components/Toast.jsx';

export default function App() {
  const user = useAuth((s) => s.user);
  const accessToken = useAuth((s) => s.accessToken);
  const status = useGame((s) => s.status);

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

  if (!user || !accessToken) return <Login />;

  const inGame = status === 'waiting' || status === 'playing' || status === 'finished';
  return (
    <div className="app">
      {inGame ? <Game /> : <Lobby />}
      <Toast />
    </div>
  );
}
