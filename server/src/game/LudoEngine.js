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
      eliminated: false, // left/forfeited mid-game — skipped in turn order
      captures: 0, // opponents' tokens sent home — the last skill-based tiebreak
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
    return this.players.filter((p) => !p.finished && !p.eliminated);
  }

  // ── move generation ─────────────────────────────────────────────────────

  // Every token that COULD legally move given `die`, with its destination and
  // any captures that would result. This is the allow-list the engine enforces.
  _legalMovesFor(player, die) {
    const moves = [];
    const blockades = this.rules.blockades ? this._blockadeCells() : null;

    player.tokens.forEach((token, tokenIndex) => {
      if (token.state === 'home') return;

      if (token.state === 'yard') {
        // A token can only leave the yard on a 6, unless a blockade guards its
        // own start square.
        if (die === 6 && !(blockades && this._pathBlocked(player, -1, 0, blockades))) {
          moves.push({
            tokenIndex,
            fromStep: -1,
            toStep: 0,
            captures: this._capturesAt(player, 0),
          });
        }
        return;
      }

      // Active token: it may move only if it does not overshoot home and no
      // opponent blockade lies in its path.
      const toStep = token.steps + die;
      if (toStep <= HOME_STEP && !(blockades && this._pathBlocked(player, token.steps, toStep, blockades))) {
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

  // Loop cells where one player has ≥2 active tokens (a blockade). Safe cells,
  // where tokens of different colours may coexist, never count.
  _blockadeCells() {
    const perCell = new Map(); // cell -> { color: count }
    for (const p of this.players) {
      for (const token of p.tokens) {
        if (token.state !== 'active' || token.steps > MAIN_PATH_STEPS - 1) continue;
        const cell = globalCell(p.color, token.steps);
        if (SAFE_CELLS.has(cell)) continue;
        const counts = perCell.get(cell) || {};
        counts[p.color] = (counts[p.color] || 0) + 1;
        perCell.set(cell, counts);
      }
    }
    const blocks = new Map(); // cell -> owning color
    for (const [cell, counts] of perCell) {
      for (const [color, n] of Object.entries(counts)) {
        if (n >= 2) blocks.set(cell, color);
      }
    }
    return blocks;
  }

  // Does an OPPONENT blockade sit on any loop cell the token enters moving from
  // `fromStep` (exclusive) to `toStep` (inclusive)? Home-column steps can't hold
  // a blockade, so we only scan the shared loop.
  _pathBlocked(player, fromStep, toStep, blockades) {
    for (let k = fromStep + 1; k <= toStep && k <= MAIN_PATH_STEPS - 1; k++) {
      const owner = blockades.get(globalCell(player.color, k));
      if (owner && owner !== player.color) return true;
    }
    return false;
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
      const player = this.getPlayer(this.turnOrder[idx]);
      if (!player.finished && !player.eliminated) {
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
      player.captures += 1;
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
      // Anyone still unfinished takes the places below, ordered by how far they
      // actually got — placement pays out in tournaments, so it must be earned.
      for (const id of this._rankIds(this.players.map((p) => p.id).filter((id) => !this.winners.includes(id)))) {
        this.winners.push(id);
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

  // Remove a player from the game (they left / forfeited / disconnected). Their
  // tokens come off the board and their turns are skipped. If only one player is
  // left standing, the game ends and that player wins.
  // Returns { gameOver, winnerId } or null if the player wasn't in play.
  eliminatePlayer(playerId) {
    if (this.phase === 'finished') return null;
    const player = this.getPlayer(playerId);
    if (!player || player.finished || player.eliminated) return null;

    player.eliminated = true;
    player.tokens.forEach((t) => {
      t.state = 'yard';
      t.steps = -1;
    });
    this.version += 1;
    this._log({ type: 'eliminated', playerId });

    const active = this._activePlayers();
    if (active.length <= 1) {
      // Last player standing wins the whole pot.
      if (active.length === 1 && !this.winners.includes(active[0].id)) {
        this.winners.unshift(active[0].id);
      }
      for (const id of this._rankIds(this.players.map((p) => p.id).filter((id) => !this.winners.includes(id)))) {
        this.winners.push(id);
      }
      this.phase = 'finished';
      this.legalMoves = [];
      this.lastDie = null;
      this._log({ type: 'gameOver', winners: this.winners, reason: 'forfeit' });
      return { gameOver: true, winnerId: this.winners[0] };
    }

    // Still going: if it was their turn, move on to the next player.
    if (this.currentPlayerId() === playerId) this._advanceTurn();
    return { gameOver: false, winnerId: null };
  }

  // ── progress, ranking & decided endings ───────────────────────────────────

  // How far a player has actually got. This is the basis for the live table
  // position, for the final placings, and for deciding a game that runs out of
  // time — so a result is never arbitrary and never left undecided.
  progressOf(playerId) {
    const p = this.getPlayer(playerId);
    if (!p) return null;
    let home = 0;
    let active = 0;
    let steps = 0;
    for (const t of p.tokens) {
      if (t.state === 'home') home += 1;
      else if (t.state === 'active') active += 1;
      if (t.steps > 0) steps += t.steps;
    }
    return {
      home,
      active,
      steps,
      captures: p.captures,
      // 0..100, for a progress bar: every token walking the full path is 100%.
      percent: Math.round((steps / (TOKENS_PER_PLAYER * HOME_STEP)) * 100),
    };
  }

  // Deterministic ordering, best first. Every input is public and reproducible
  // from the move log, so players can check a decided game for themselves.
  // Tokens home first, then distance travelled, then tokens out of the yard,
  // then captures, and finally seat order so the result is never a coin toss.
  _rankIds(ids) {
    return [...ids].sort((a, b) => {
      const pa = this.getPlayer(a);
      const pb = this.getPlayer(b);
      // Anyone who walked away ranks below everyone still at the table.
      if (pa.eliminated !== pb.eliminated) return pa.eliminated ? 1 : -1;
      const A = this.progressOf(a);
      const B = this.progressOf(b);
      return (
        B.home - A.home ||
        B.steps - A.steps ||
        B.active - A.active ||
        B.captures - A.captures ||
        pa.seatIndex - pb.seatIndex
      );
    });
  }

  // Live table position. Players who already finished keep the place they
  // earned; everyone else is ranked on progress, updated after every move.
  standings() {
    const done = this.winners.filter((id) => this.getPlayer(id)?.finished);
    const rest = this._rankIds(this.players.map((p) => p.id).filter((id) => !done.includes(id)));
    return [...done, ...rest].map((id, i) => {
      const p = this.getPlayer(id);
      return {
        playerId: id,
        place: i + 1,
        finished: p.finished,
        eliminated: p.eliminated,
        ...this.progressOf(id),
      };
    });
  }

  // End a game that cannot continue (the whole table went idle) with a real
  // result rather than no result at all. A knockout bracket cannot advance on a
  // void match, and a player who was clearly ahead should not lose that lead
  // just because their opponent stopped playing.
  finishByProgress(reason = 'timeout') {
    if (this.phase === 'finished') return null;
    const order = this.standings().map((s) => s.playerId);
    this.winners = order;
    this.phase = 'finished';
    this.legalMoves = [];
    this.lastDie = null;
    this.version += 1;
    this._log({ type: 'gameOver', winners: this.winners, reason });
    return { gameOver: true, winnerId: order[0], reason };
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
      standings: this.standings(),
      rules: this.rules,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        seatIndex: p.seatIndex,
        finished: p.finished,
        finishedAt: p.finishedAt,
        eliminated: p.eliminated,
        captures: p.captures,
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
