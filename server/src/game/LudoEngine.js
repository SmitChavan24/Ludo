import {
  TOKENS_PER_PLAYER,
  MAIN_PATH_STEPS,
  HOME_STEP,
  SAFE_CELLS,
  DEFAULT_RULES,
  globalCell,
} from './constants.js';

// Typed error so callers (socket layer) can translate to a clean client message
// without ever leaking a stack trace or letting a bad request mutate state.
export class GameError extends Error {
  constructor(message, code = 'GAME_ERROR') {
    super(message);
    this.name = 'GameError';
    this.code = code;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// LudoEngine — the single source of truth for one game.
//
// It is a PURE, deterministic state machine: it receives a die value (the
// caller is responsible for generating it securely) and the player's chosen
// token index, and it either applies a fully-validated mutation or throws.
//
// The client is never trusted: `applyRoll`/`applyMove` re-derive the set of
// legal moves from scratch and reject anything not in that set. There is no
// code path by which a crafted socket message can produce an illegal board.
// ──────────────────────────────────────────────────────────────────────────
export class LudoEngine {
  constructor({ players, rules = {} }) {
    if (!Array.isArray(players) || players.length < 2 || players.length > 4) {
      throw new GameError('A game needs 2 to 4 players', 'BAD_PLAYERS');
    }

    this.rules = { ...DEFAULT_RULES, ...rules };

    this.players = players.map((p, seatIndex) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      seatIndex,
      finished: false,
      finishedAt: null,
      tokens: Array.from({ length: TOKENS_PER_PLAYER }, () => ({
        state: 'yard', // 'yard' | 'active' | 'home'
        steps: -1,
      })),
    }));

    this.turnOrder = this.players.map((p) => p.id);
    this.turnIndex = 0;
    this.phase = 'awaitingRoll'; // 'awaitingRoll' | 'awaitingMove' | 'finished'
    this.lastDie = null;
    this.legalMoves = []; // valid moves for the current player after a roll
    this.consecutiveSixes = 0;
    this.winners = []; // player ids in finishing order
    this.version = 0; // bumps on every mutation; lets clients order/dedupe updates
    this.history = []; // append-only audit log for replay & dispute resolution
  }

  // ── lookups ───────────────────────────────────────────────────────────────

  currentPlayerId() {
    return this.turnOrder[this.turnIndex];
  }

  getPlayer(id) {
    return this.players.find((p) => p.id === id);
  }

  _activePlayers() {
    return this.players.filter((p) => !p.finished);
  }

  // ── move generation ─────────────────────────────────────────────────────

  // Every token that COULD legally move given `die`, with its destination and
  // any captures that would result. This is the allow-list the engine enforces.
  _legalMovesFor(player, die) {
    const moves = [];
    player.tokens.forEach((token, tokenIndex) => {
      if (token.state === 'home') return;

      if (token.state === 'yard') {
        // A token can only leave the yard on a 6.
        if (die === 6) {
          moves.push({
            tokenIndex,
            fromStep: -1,
            toStep: 0,
            captures: this._capturesAt(player, 0),
          });
        }
        return;
      }

      // Active token: it may move only if it does not overshoot home.
      const toStep = token.steps + die;
      if (toStep <= HOME_STEP) {
        moves.push({
          tokenIndex,
          fromStep: token.steps,
          toStep,
          captures: this._capturesAt(player, toStep),
        });
      }
    });
    return moves;
  }

  // Opponent tokens that would be sent home if `player` lands on `toStep`.
  // Captures never happen in the home column or on a safe cell.
  _capturesAt(player, toStep) {
    if (toStep > MAIN_PATH_STEPS - 1) return []; // entering home column
    const cell = globalCell(player.color, toStep);
    if (SAFE_CELLS.has(cell)) return [];

    const captures = [];
    for (const other of this.players) {
      if (other.id === player.id) continue;
      other.tokens.forEach((token, tokenIndex) => {
        if (token.state !== 'active') return;
        if (globalCell(other.color, token.steps) === cell) {
          captures.push({ playerId: other.id, tokenIndex });
        }
      });
    }
    return captures;
  }

  // ── turn management ─────────────────────────────────────────────────────

  _advanceTurn() {
    this.consecutiveSixes = 0;
    this.lastDie = null;
    this.legalMoves = [];
    this.phase = 'awaitingRoll';

    const n = this.turnOrder.length;
    for (let i = 1; i <= n; i++) {
      const idx = (this.turnIndex + i) % n;
      if (!this.getPlayer(this.turnOrder[idx]).finished) {
        this.turnIndex = idx;
        return;
      }
    }
    // Nobody left to play.
    this.phase = 'finished';
  }

  _log(entry) {
    this.history.push({ ...entry, version: this.version, at: Date.now() });
  }

  // ── public mutations ────────────────────────────────────────────────────

  // Apply a server-generated die value for `playerId`. The die MUST come from
  // the secure dice source — never from the client.
  applyRoll(playerId, die) {
    if (this.phase === 'finished') throw new GameError('Game is over', 'FINISHED');
    if (this.phase !== 'awaitingRoll') throw new GameError('Not awaiting a roll', 'BAD_PHASE');
    if (playerId !== this.currentPlayerId()) throw new GameError('Not your turn', 'NOT_YOUR_TURN');
    if (!Number.isInteger(die) || die < 1 || die > 6) {
      throw new GameError('Invalid die value', 'BAD_DIE');
    }

    this.lastDie = die;
    const player = this.getPlayer(playerId);

    // Triple-six forfeits the whole turn before any move is allowed.
    if (die === 6) {
      this.consecutiveSixes += 1;
      if (this.rules.forfeitOnTripleSix && this.consecutiveSixes >= 3) {
        this.version += 1;
        this._log({ type: 'tripleSix', playerId, die });
        this._advanceTurn();
        return { die, moves: [], turnPassed: true, reason: 'tripleSix' };
      }
    } else {
      this.consecutiveSixes = 0;
    }

    const moves = this._legalMovesFor(player, die);
    this.version += 1;

    if (moves.length === 0) {
      // No legal move — the turn passes even on a 6 (nothing to move).
      this._log({ type: 'roll', playerId, die, moves: 0, turnPassed: true });
      this._advanceTurn();
      return { die, moves: [], turnPassed: true, reason: 'noMoves' };
    }

    this.phase = 'awaitingMove';
    this.legalMoves = moves;
    this._log({ type: 'roll', playerId, die, moves: moves.length });
    return { die, moves, turnPassed: false };
  }

  // Apply the player's chosen token move. Only token indices present in the
  // current `legalMoves` allow-list are accepted.
  applyMove(playerId, tokenIndex) {
    if (this.phase !== 'awaitingMove') throw new GameError('Not awaiting a move', 'BAD_PHASE');
    if (playerId !== this.currentPlayerId()) throw new GameError('Not your turn', 'NOT_YOUR_TURN');

    const move = this.legalMoves.find((m) => m.tokenIndex === tokenIndex);
    if (!move) throw new GameError('Illegal move', 'ILLEGAL_MOVE');

    const player = this.getPlayer(playerId);
    const token = player.tokens[tokenIndex];
    const die = this.lastDie;

    // 1. Move the token.
    token.steps = move.toStep;
    token.state = move.toStep >= HOME_STEP ? 'home' : 'active';

    // 2. Resolve captures (recomputed from the move's allow-list).
    const captured = [];
    for (const cap of move.captures) {
      const victimToken = this.getPlayer(cap.playerId).tokens[cap.tokenIndex];
      victimToken.state = 'yard';
      victimToken.steps = -1;
      captured.push(cap);
    }

    const reachedHome = token.state === 'home';

    // 3. Did this player finish all four tokens?
    let playerFinished = false;
    if (player.tokens.every((t) => t.state === 'home')) {
      player.finished = true;
      player.finishedAt = this.winners.length;
      this.winners.push(player.id);
      playerFinished = true;
    }

    // 4. Is the game over?
    let gameOver = false;
    if (playerFinished && this.rules.winOnFirstFinish) gameOver = true;
    else if (this._activePlayers().length <= 1) gameOver = true;

    this.version += 1;

    if (gameOver) {
      // Anyone still unfinished is appended to the standings by remaining order.
      for (const p of this.players) {
        if (!this.winners.includes(p.id)) this.winners.push(p.id);
      }
      this.phase = 'finished';
      this.legalMoves = [];
      this.lastDie = null;
      this._log({ type: 'move', playerId, tokenIndex, from: move.fromStep, to: move.toStep, captured, reachedHome });
      this._log({ type: 'gameOver', winners: this.winners });
      return { moved: move, captured, reachedHome, extraTurn: false, playerFinished, gameOver: true, winners: this.winners };
    }

    // 5. Does the player roll again?
    const extraTurn =
      (this.rules.extraTurnOnSix && die === 6) ||
      (this.rules.extraTurnOnCapture && captured.length > 0) ||
      (this.rules.extraTurnOnReachHome && reachedHome);

    this.lastDie = null;
    this.legalMoves = [];

    if (extraTurn) {
      this.phase = 'awaitingRoll';
      // Keep the six-counter only while the streak is genuinely sixes.
      if (die !== 6) this.consecutiveSixes = 0;
    } else {
      this._advanceTurn();
    }

    this._log({ type: 'move', playerId, tokenIndex, from: move.fromStep, to: move.toStep, captured, reachedHome, extraTurn });
    return { moved: move, captured, reachedHome, extraTurn, playerFinished, gameOver: false, winners: this.winners };
  }

  // Force the current player's turn to end (used by the turn-timeout watchdog
  // so one idle/disconnected player can't freeze a money game forever).
  forceSkip(playerId, reason = 'timeout') {
    if (this.phase === 'finished') return null;
    if (playerId !== this.currentPlayerId()) return null;
    this.version += 1;
    this._log({ type: 'skip', playerId, reason });
    this._advanceTurn();
    return { skipped: playerId, reason };
  }

  // ── serialization ─────────────────────────────────────────────────────────

  // The full board, safe to broadcast to every player in the room. It contains
  // no secrets (the dice serverSeed lives in the GameManager, not here).
  getState() {
    return {
      status: this.phase === 'finished' ? 'finished' : 'playing',
      phase: this.phase,
      version: this.version,
      turnOrder: this.turnOrder,
      currentPlayerId: this.phase === 'finished' ? null : this.currentPlayerId(),
      lastDie: this.lastDie,
      legalMoves: this.legalMoves,
      consecutiveSixes: this.consecutiveSixes,
      winners: this.winners,
      rules: this.rules,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        seatIndex: p.seatIndex,
        finished: p.finished,
        finishedAt: p.finishedAt,
        tokens: p.tokens.map((t) => ({
          state: t.state,
          steps: t.steps,
          cell: globalCell(p.color, t.steps), // 0..51 on the loop, else null
          homeIndex: t.steps >= MAIN_PATH_STEPS ? t.steps - MAIN_PATH_STEPS : null,
        })),
      })),
    };
  }
}
