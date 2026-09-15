import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../store/auth.js';
import { useGame } from '../store/game.js';
import { gameApi } from '../api/socket.js';
import { sfx, isMuted, toggleMuted } from '../util/sound.js';
import LudoBoard from './LudoBoard.jsx';
import Dice from './Dice.jsx';
import GameOver from './GameOver.jsx';

export default function Game() {
  const user = useAuth((s) => s.user);
  const { status, room, state, result } = useGame();
  const setError = useGame((s) => s.setError);
  const reset = useGame((s) => s.reset);
  const lastRoll = useGame((s) => s.lastRoll);
  const lastEvent = useGame((s) => s.lastEvent);
  const turnTimeoutMs = useGame((s) => s.turnTimeoutMs);
  const [copied, setCopied] = useState(false);
  const [rolling, setRolling] = useState(false);
  const [rollFace, setRollFace] = useState(1);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [botIn, setBotIn] = useState(null); // seconds until the practice bot joins
  const [muted, setMuted] = useState(isMuted());
  const [turnFrac, setTurnFrac] = useState(1);
  const turnStartRef = useRef(Date.now());

  const myId = user.id;
  // The server ranks the table after every move; the client only renders it.
  const rankOf = Object.fromEntries((state?.standings || []).map((r) => [r.playerId, r]));
  const ordinal = (n) => ['1st', '2nd', '3rd', '4th'][n - 1] || `${n}th`;
  const isPractice = !!room?.isPractice;
  // Practice is anonymous: never show a name, just who's who.
  const label = (p) => (isPractice ? (p.id === myId ? 'You' : 'Computer') : `${p.name}${p.id === myId ? ' (you)' : ''}`);

  // While "rolling", flick through random faces so the die tumbles naturally.
  useEffect(() => {
    if (!rolling) return;
    const t = setInterval(() => setRollFace(1 + Math.floor(Math.random() * 6)), 90);
    return () => clearInterval(t);
  }, [rolling]);

  // Practice: count down to the moment a bot fills the table. The server sends
  // the REMAINING time, which we anchor to the local clock so skew can't skew it.
  useEffect(() => {
    const ms = room?.botJoinsInMs;
    if (!(room?.isPractice && typeof ms === 'number' && status === 'waiting')) {
      setBotIn(null);
      return;
    }
    const deadline = Date.now() + ms;
    const tick = () => setBotIn(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    tick();
    const iv = setInterval(tick, 250);
    return () => clearInterval(iv);
  }, [room?.id, room?.botJoinsInMs, room?.isPractice, status]);

  // Turn countdown: reset on every state change, tick toward the auto-skip.
  useEffect(() => {
    turnStartRef.current = Date.now();
    setTurnFrac(1);
  }, [state?.version]);
  useEffect(() => {
    if (!state || state.status === 'finished') return;
    const iv = setInterval(() => {
      setTurnFrac(Math.max(0, 1 - (Date.now() - turnStartRef.current) / turnTimeoutMs));
    }, 100);
    return () => clearInterval(iv);
  }, [state?.status, turnTimeoutMs]);

  // Auto-move when there is exactly one legal option (Ludo convention).
  useEffect(() => {
    if (!state || state.currentPlayerId !== myId || state.phase !== 'awaitingMove') return;
    if (state.legalMoves.length !== 1) return;
    const t = setTimeout(() => gameApi.move(state.legalMoves[0].tokenIndex).catch(() => {}), 550);
    return () => clearTimeout(t);
  }, [state?.version, myId]);

  // Sound effects, driven by the latest broadcast event.
  useEffect(() => {
    if (!lastEvent) return;
    if (lastEvent.type === 'roll') sfx.roll();
    else if (lastEvent.type === 'move') {
      const r = lastEvent.result;
      if (r?.captured?.length) sfx.capture();
      else if (r?.reachedHome) sfx.home();
      else sfx.move();
    }
  }, [lastEvent]);
  useEffect(() => {
    if (state && state.status !== 'finished' && state.currentPlayerId === myId && state.phase === 'awaitingRoll') {
      sfx.yourTurn();
    }
  }, [state?.currentPlayerId, state?.phase, myId]);
  useEffect(() => {
    if (status === 'finished' && result && !result.aborted) {
      result.winnerId === myId ? sfx.win() : sfx.lose();
    }
  }, [status, result, myId]);

  const onToggleMute = () => setMuted(toggleMuted());

  const leave = async () => {
    try {
      await gameApi.leave();
    } catch (e) {
      setError(e.message);
    }
    reset();
  };

  // Leaving mid-game forfeits the stake, so confirm first. Cancelling a waiting
  // room (or an already-finished game) costs nothing, so just leave.
  const requestLeave = () => {
    if (!isPractice && status === 'playing' && state && state.status !== 'finished') setConfirmLeave(true);
    else if (user?.isGuest) exitPractice();
    else leave();
  };

  // "Play another practice game" — an explicit new request.
  const onAgain = () => {
    reset();
    if (user?.isGuest) useGame.getState().requestPractice();
  };

  // Cancelling/leaving a practice game drops the guest on the practice home
  // screen — NOT back into matchmaking (that made Cancel look broken), and not
  // signed out either, so replaying is one tap.
  const exitPractice = async () => {
    try {
      await gameApi.leave();
    } catch {
      /* room may already be gone */
    }
    useGame.getState().clearPendingPractice();
    reset();
  };

  // ── Waiting room (no game state yet) ──
  if (status === 'waiting' || !state) {
    const seats = room?.seats || [];
    const isPrivate = room?.isPrivate;
    const need = (room?.maxPlayers || 2) - seats.length;
    const copyCode = () => {
      navigator.clipboard?.writeText(room.id).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
    };
    return (
      <div className="game waiting">
        <div className="waiting-card">
          <div className="spinner" />
          <h2>{room?.isPractice ? 'Finding an opponent…' : isPrivate ? 'Waiting for friends…' : 'Finding players…'}</h2>
          <p className="result-sub">
            {room?.isPractice
              ? botIn === null
                ? 'Looking for a real opponent…'
                : botIn > 0
                  ? 'Looking for a real opponent…'
                  : 'Starting your game…'
              : `Stake 🪙 ${room?.stake} · ${seats.length}/${room?.maxPlayers} joined${need > 0 ? ` · need ${need} more` : ''}`}
          </p>

          {room?.isPractice && botIn !== null && (
            <div className="bot-countdown">
              <div className="bot-count-num">{botIn > 0 ? botIn : '—'}</div>
              <div className="bot-count-label">
                {botIn > 0 ? 'Computer joins in seconds' : 'Computer is joining…'}
              </div>
              <div className="bot-count-bar">
                <div
                  className="bot-count-fill"
                  style={{ width: `${Math.min(100, Math.max(0, (botIn / Math.max(1, Math.round((room.botJoinsInMs || 1) / 1000))) * 100))}%` }}
                />
              </div>
            </div>
          )}

          <div className="seat-list">
            {seats.map((s) => (
              <div key={s.userId} className="seat">
                <span className={`dot c-${s.color}`} />
                {s.name} {s.userId === myId && <em>(you)</em>}
              </div>
            ))}
            {Array.from({ length: Math.max(0, need) }).map((_, i) => (
              <div key={`empty-${i}`} className="seat seat-empty">
                <span className="dot dot-empty" />{' '}
                {room?.isPractice
                  ? botIn > 0
                    ? `Computer joins in ${botIn}s`
                    : 'Computer joining…'
                  : isPrivate
                    ? 'Open seat'
                    : 'Searching…'}
              </div>
            ))}
          </div>

          {/* The code only matters for private friend games. */}
          {isPrivate && room?.id && (
            <button className="btn btn-outline btn-block" onClick={copyCode}>
              {copied ? 'Copied!' : `Share code: ${room.id}`}
            </button>
          )}
          <button className="btn btn-ghost btn-block" onClick={user?.isGuest ? exitPractice : leave}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // ── Active / finished game ──
  const isMyTurn = state.currentPlayerId === myId;
  const canRoll = isMyTurn && state.phase === 'awaitingRoll';
  const mustMove = isMyTurn && state.phase === 'awaitingMove';
  const currentPlayer = state.players.find((p) => p.id === state.currentPlayerId);
  // The die tumbles while rolling. On your own turn-to-roll it shows a neutral
  // "?" (not a stale/opponent value); otherwise it shows the latest roll.
  const dieValue = rolling ? rollFace : state.lastDie ?? (isMyTurn ? null : lastRoll);

  const onRoll = async () => {
    if (rolling) return;
    setRolling(true);
    try {
      await gameApi.roll();
    } catch (e) {
      setError(e.message);
    }
    // Let the tumble play briefly, then settle on the server's result.
    setTimeout(() => setRolling(false), 600);
  };
  const onMove = async (tokenIndex) => {
    try {
      await gameApi.move(tokenIndex);
    } catch (e) {
      setError(e.message);
    }
  };

  const homeCount = (p) => p.tokens.filter((t) => t.state === 'home').length;

  return (
    <div className="game">
      <header className="game-top">
        <button className="btn btn-ghost btn-sm" onClick={requestLeave}>← Leave</button>
        {isPractice ? (
          <div className="practice-chip">Practice</div>
        ) : (
          <div className="pot-chip">Pot 🪙 {room?.pot ?? state.players.length * (room?.stake || 0)}</div>
        )}
        <div className="top-right">
          <button className="mute-btn" onClick={onToggleMute} aria-label={muted ? 'Unmute' : 'Mute'}>
            {muted ? '🔇' : '🔊'}
          </button>
          {!isPractice && <div className="wallet-chip sm">🪙 {user.coins.toLocaleString('en-IN')}</div>}
        </div>
      </header>

      <div className="players-bar">
        {state.players.map((p) => (
          <div key={p.id} className={`player-chip ${p.id === state.currentPlayerId ? 'turn' : ''}`}>
            <span className={`dot c-${p.color}`} />
            <div className="pc-meta">
              <div className="pc-name">
                {label(p)}
                {rankOf[p.id] && (
                  <span className={`pc-rank ${rankOf[p.id].place === 1 ? 'lead' : ''}`}>
                    {ordinal(rankOf[p.id].place)}
                  </span>
                )}
              </div>
              <div className="pc-sub">🏠 {homeCount(p)}/4</div>
              {rankOf[p.id] && (
                <div className="pc-progress" title={`${rankOf[p.id].percent}% of the way home`}>
                  <div className={`pc-progress-fill c-${p.color}`} style={{ width: `${rankOf[p.id].percent}%` }} />
                </div>
              )}
            </div>
            {p.id === state.currentPlayerId && state.lastDie && <span className="pc-die">{state.lastDie}</span>}
            {p.id === state.currentPlayerId && (
              <div className="turn-timer">
                <div className={`turn-timer-fill ${turnFrac < 0.34 ? 'low' : ''}`} style={{ width: `${turnFrac * 100}%` }} />
              </div>
            )}
          </div>
        ))}
      </div>

      <LudoBoard state={state} myId={myId} onMove={onMove} />

      <div className="action-bar">
        <Dice
          value={dieValue}
          rolling={rolling}
          idle={!canRoll && !mustMove}
          onRoll={canRoll && !rolling ? onRoll : undefined}
        />
        {state.status === 'finished' ? (
          <span className="turn-note">Game over</span>
        ) : !isMyTurn ? (
          <span className="turn-note">
            <span className={`dot c-${currentPlayer?.color}`} />{' '}
            {currentPlayer ? (isPractice ? (currentPlayer.id === myId ? 'Your turn' : "Computer's turn…") : `${currentPlayer.name}'s turn…`) : ''}
          </span>
        ) : null}
      </div>

      {status === 'finished' && result && (
        <GameOver result={result} myId={myId} players={state.players} onAgain={onAgain} isPractice={isPractice} />
      )}

      {confirmLeave && (
        <div className="overlay" onClick={() => setConfirmLeave(false)}>
          <div className="confirm-card" onClick={(e) => e.stopPropagation()}>
            <div className="result-emoji">⚠️</div>
            <h2>Leave the game?</h2>
            <p className="result-sub">
              {isPractice
                ? 'This practice game will end. Nothing is at stake.'
                : `You’ll forfeit your stake of 🪙 ${room?.stake} and your opponent wins the pot.`}
            </p>
            <div className="confirm-actions">
              <button className="btn btn-ghost" onClick={() => setConfirmLeave(false)}>Keep playing</button>
              <button className="btn btn-danger" onClick={() => { setConfirmLeave(false); leave(); }}>Leave &amp; forfeit</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
