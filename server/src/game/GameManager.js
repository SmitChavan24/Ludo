import { nanoid } from 'nanoid';
import { LudoEngine, GameError } from './LudoEngine.js';
import { ProvablyFairDice } from './dice.js';
import { COLORS } from './constants.js';
import { chooseMove, isBotId, makeBotId } from './bot.js';
import { wallet } from '../wallet/Wallet.js';
import { store } from '../db/store.js';
import { config } from '../config.js';

// ──────────────────────────────────────────────────────────────────────────
// GameManager — orchestrates rooms, matchmaking, and the lifecycle of a game.
//
// It is the ONLY place that mutates game state in response to player actions,
// and it always does so through the authoritative LudoEngine. It also owns the
// money side-effects (escrow on start, settle on finish, refund on abort) and
// the turn-timeout watchdog that stops one idle player freezing a staked game.
//
// All broadcasts go through socket.io rooms:
//   • `room:<id>`  — everyone seated in that game
//   • `user:<id>`  — all sockets for one user (private notifications, balances)
// ──────────────────────────────────────────────────────────────────────────
export class GameManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map(); // roomId -> room
    this.userRoom = new Map(); // userId -> roomId (one game at a time)
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  _roomOf(userId) {
    const id = this.userRoom.get(userId);
    return id ? this.rooms.get(id) : null;
  }

  // Every room broadcast is tagged with its roomId so a client can ignore
  // late events from a game it has already left.
  _emitRoom(room, event, payload) {
    this.io.to(`room:${room.id}`).emit(event, { ...payload, roomId: room.id });
  }

  _emitUser(userId, event, payload) {
    this.io.to(`user:${userId}`).emit(event, payload);
  }

  // Take a user's sockets out of a room's broadcast channel. Essential: without
  // this, a finished/abandoned room keeps broadcasting to a player who has since
  // joined a NEW game, and those stale events overwrite their live game state.
  _leaveChannel(room, userId) {
    this.io.in(`user:${userId}`).socketsLeave(`room:${room.id}`);
  }

  serializeRoom(room) {
    return {
      id: room.id,
      status: room.status,
      stake: room.stake,
      maxPlayers: room.maxPlayers,
      isPrivate: room.isPrivate,
      isPractice: !!room.isPractice,
      // Practice only: how long until a bot fills the table, so the waiting
      // screen can count down. Relative, to be immune to clock skew.
      botJoinsInMs: room.botJoinsAt ? Math.max(0, room.botJoinsAt - Date.now()) : null,
      hostId: room.hostId,
      rules: room.rules,
      pot: room.pot,
      // Published from room creation so players see the dice commitment BEFORE
      // they contribute their seeds.
      serverSeedHash: room.dice ? room.dice.serverSeedHash : null,
      seats: room.seats.map((s) => ({
        userId: s.userId,
        name: s.name,
        picture: s.picture,
        color: s.color,
        connected: s.connected,
        isBot: !!s.isBot,
      })),
    };
  }

  // Full snapshot for a (re)joining client.
  stateForUser(userId) {
    const room = this._roomOf(userId);
    if (!room) return null;
    return {
      room: this.serializeRoom(room),
      state: room.engine ? room.engine.getState() : null,
      commitment: room.dice ? room.dice.commitment() : null,
      turnTimeoutMs: config.economy.turnTimeoutMs,
    };
  }

  // Practice games are free (stake 0) and never touch the wallet, so the stake
  // allow-list doesn't apply to them.
  _validateStake(stake, { practice = false } = {}) {
    if (practice) {
      if (stake !== 0) throw new GameError('Practice games are free', 'BAD_STAKE');
      return;
    }
    return this._validateStakeStrict(stake);
  }

  // Stakes and table sizes must come from the server's allow-list — never just
  // "any positive integer" from the client. This both protects the economy and
  // keeps the matchmaking pool from fragmenting.
  _validateStakeStrict(stake) {
    if (!Number.isInteger(stake) || stake <= 0) {
      throw new GameError('Stake must be a positive whole number of coins', 'BAD_STAKE');
    }
    if (!config.economy.stakes.includes(stake)) {
      throw new GameError('That stake is not available', 'BAD_STAKE');
    }
  }

  _validatePlayerCount(maxPlayers) {
    if (!config.economy.playerCounts.includes(maxPlayers)) {
      throw new GameError('That table size is not available', 'BAD_MAX_PLAYERS');
    }
  }

  // ── lobby / matchmaking ─────────────────────────────────────────────────

  async createRoom(user, { stake, maxPlayers = 2, rules = {}, isPrivate = false, clientSeed, isPractice = false } = {}) {
    if (!isPractice && user.isGuest) {
      throw new GameError('Sign in to play with coins', 'GUEST_FORBIDDEN');
    }
    this._validateStake(stake, { practice: isPractice });
    this._validatePlayerCount(maxPlayers);
    if (this._roomOf(user.id)) {
      throw new GameError('You are already in a game', 'ALREADY_IN_GAME');
    }
    if (!isPractice && (await wallet.getBalance(user.id)) < stake) {
      throw new GameError('Not enough coins for this stake', 'INSUFFICIENT_FUNDS');
    }

    const room = {
      id: nanoid(10),
      status: 'waiting',
      stake,
      maxPlayers,
      // Private rooms are friend games joined by code; they are never returned
      // by random matchmaking.
      isPrivate,
      // Practice: free, anonymous, bot-backed, and completely off the ledger.
      isPractice,
      rules,
      hostId: user.id,
      seats: [],
      pot: 0,
      // Commit the dice server seed NOW, before any player contributes a seed.
      dice: new ProvablyFairDice(),
      engine: null,
      turnTimer: null,
      disconnectTimers: new Map(), // userId -> grace timer
      botTimer: null, // practice: fills the table with a bot after a wait
      botMoveTimer: null,
      skipCount: 0,
      createdAt: Date.now(),
    };
    this._seatUser(room, user, clientSeed);
    this.rooms.set(room.id, room);
    // Practice tables must never leave someone staring at an empty lobby: if no
    // human arrives within the wait window, a bot sits down and the game starts.
    if (isPractice) this._armBotFill(room);
    return room;
  }

  // `onSeated(room)` runs synchronously the moment the user takes a seat — the
  // socket layer uses it to join the broadcast room BEFORE `game:start` fires,
  // so a player who fills the last seat never misses the kickoff event.
  async joinRoom(user, roomId, onSeated, clientSeed) {
    const room = this.rooms.get(roomId);
    if (!room) throw new GameError('Room not found', 'NO_ROOM');
    if (room.status !== 'waiting') throw new GameError('Game already started', 'ALREADY_STARTED');
    if (room.seats.length >= room.maxPlayers) throw new GameError('Room is full', 'ROOM_FULL');
    if (this._roomOf(user.id)) throw new GameError('You are already in a game', 'ALREADY_IN_GAME');
    if (!room.isPractice && user.isGuest) {
      throw new GameError('Sign in to play with coins', 'GUEST_FORBIDDEN');
    }
    if (!room.isPractice && (await wallet.getBalance(user.id)) < room.stake) {
      throw new GameError('Not enough coins for this stake', 'INSUFFICIENT_FUNDS');
    }

    this._seatUser(room, user, clientSeed);
    if (onSeated) onSeated(room);
    this._emitRoom(room, 'room:update', this.serializeRoom(room));

    if (room.seats.length === room.maxPlayers) {
      await this._startGame(room);
    }
    return room;
  }

  // Random matchmaking: drop the player into any waiting PUBLIC room at the same
  // stake AND player count, or open a new public one. The game only starts once
  // that many real players have joined (no bots, no early start).
  async quickMatch(user, stake, maxPlayers = 2, onSeated, clientSeed, isPractice = false) {
    if (!isPractice && user.isGuest) {
      throw new GameError('Sign in to play with coins', 'GUEST_FORBIDDEN');
    }
    this._validateStake(stake, { practice: isPractice });
    this._validatePlayerCount(maxPlayers);
    if (this._roomOf(user.id)) throw new GameError('You are already in a game', 'ALREADY_IN_GAME');

    // Prefer a real opponent: look for a waiting table of the same kind first.
    for (const room of this.rooms.values()) {
      if (
        !room.isPrivate &&
        !!room.isPractice === !!isPractice &&
        room.status === 'waiting' &&
        room.stake === stake &&
        room.maxPlayers === maxPlayers &&
        room.seats.length < room.maxPlayers &&
        room.hostId !== user.id
      ) {
        await this.joinRoom(user, room.id, onSeated, clientSeed);
        return room;
      }
    }
    const room = await this.createRoom(user, { stake, maxPlayers, isPrivate: false, clientSeed, isPractice });
    if (onSeated) onSeated(room);
    return room;
  }

  // ── practice bots ────────────────────────────────────────────────────────

  // Wait a while for a human; if the table hasn't filled, seat bot(s) and start.
  _armBotFill(room) {
    this._clearBotFill(room);
    room.botJoinsAt = Date.now() + config.practice.botWaitMs;
    room.botTimer = setTimeout(() => {
      room.botTimer = null;
      room.botJoinsAt = null;
      if (room.status !== 'waiting') return;
      while (room.seats.length < room.maxPlayers) {
        const botId = makeBotId();
        room.seats.push({
          userId: botId,
          name: 'Computer',
          picture: null,
          color: COLORS[room.seats.length],
          connected: true,
          isBot: true,
          clientSeed: '',
        });
        // Bots act through the same public API as players, so they need the same
        // user→room mapping or handleRoll/handleMove can't find their game.
        this.userRoom.set(botId, room.id);
      }
      this._emitRoom(room, 'room:update', this.serializeRoom(room));
      this._startGame(room).catch(() => {});
    }, config.practice.botWaitMs);
    room.botTimer.unref?.();
  }

  _clearBotFill(room) {
    room.botJoinsAt = null;
    if (room.botTimer) {
      clearTimeout(room.botTimer);
      room.botTimer = null;
    }
  }

  // If it's a bot's turn, play it after a short, human-feeling pause.
  _maybeBotTurn(room) {
    if (room.botMoveTimer) {
      clearTimeout(room.botMoveTimer);
      room.botMoveTimer = null;
    }
    const engine = room.engine;
    if (!engine || engine.phase === 'finished' || room.status !== 'playing') return;

    const current = engine.currentPlayerId();
    if (!isBotId(current)) return;

    const { botMinThinkMs: lo, botMaxThinkMs: hi } = config.practice;
    const delay = lo + Math.random() * Math.max(0, hi - lo);
    room.botMoveTimer = setTimeout(async () => {
      room.botMoveTimer = null;
      try {
        if (room.status !== 'playing' || engine.phase === 'finished') return;
        if (engine.currentPlayerId() !== current) return; // turn moved on
        if (engine.phase === 'awaitingRoll') {
          this.handleRoll(current);
        } else if (engine.phase === 'awaitingMove') {
          const tokenIndex = chooseMove(engine.getState(), current);
          if (tokenIndex != null) await this.handleMove(current, tokenIndex);
        }
      } catch {
        /* a bot must never be able to crash the room */
      }
    }, delay);
    room.botMoveTimer.unref?.();
  }

  _seatUser(room, user, clientSeed) {
    const seat = {
      userId: user.id,
      name: user.name,
      picture: user.picture,
      color: COLORS[room.seats.length],
      connected: true,
      clientSeed: clientSeed || '', // player contribution to the provably-fair seed
    };
    room.seats.push(seat);
    this.userRoom.set(user.id, room.id);
  }

  // ── game lifecycle ──────────────────────────────────────────────────────

  async _startGame(room) {
    this._clearBotFill(room); // table filled — no bot needed (or already added)

    // Practice games are free: no balance checks, no escrow, nothing on the ledger.
    if (room.isPractice) {
      room.pot = 0;
      room.dice.setClientSeed(room.seats.map((s) => s.clientSeed).filter(Boolean).join(':'));
      room.engine = new LudoEngine({
        players: room.seats.map((s) => ({ id: s.userId, name: s.name, color: s.color })),
        rules: room.rules,
      });
      room.status = 'playing';
      room.skipCount = 0;
      this._emitRoom(room, 'game:start', {
        room: this.serializeRoom(room),
        state: room.engine.getState(),
        commitment: room.dice.commitment(),
        pot: 0,
        stake: 0,
        turnTimeoutMs: config.economy.turnTimeoutMs,
      });
      this._armTurn(room);
      this._maybeBotTurn(room);
      return;
    }

    // Anyone who can no longer cover the stake is ejected (with a notice) so the
    // room drops below full and can take a replacement — instead of deadlocking
    // full-but-unstartable.
    const broke = [];
    for (const s of room.seats) {
      if ((await wallet.getBalance(s.userId)) < room.stake) broke.push(s.userId);
    }
    if (broke.length) {
      for (const uid of broke) this._ejectFromWaiting(room, uid);
      if (room.seats.length === 0) this._destroyRoom(room);
      else this._emitRoom(room, 'room:update', this.serializeRoom(room));
      return;
    }

    const userIds = room.seats.map((s) => s.userId);
    let escrow;
    try {
      escrow = await wallet.escrowStakes(room.id, userIds, room.stake);
    } catch {
      // Should be unreachable after the pre-check, but never leave a full dead room.
      for (const uid of userIds) this._ejectFromWaiting(room, uid);
      this._destroyRoom(room);
      return;
    }

    room.pot = escrow.pot;
    // Finalize the provably-fair client seed from every player's contribution
    // (the server seed was already committed when the room opened).
    room.dice.setClientSeed(room.seats.map((s) => s.clientSeed).filter(Boolean).join(':'));
    room.engine = new LudoEngine({
      players: room.seats.map((s) => ({ id: s.userId, name: s.name, color: s.color })),
      rules: room.rules,
    });
    room.status = 'playing';
    room.skipCount = 0;

    this._emitRoom(room, 'game:start', {
      room: this.serializeRoom(room),
      state: room.engine.getState(),
      commitment: room.dice.commitment(),
      pot: room.pot,
      stake: room.stake,
      turnTimeoutMs: config.economy.turnTimeoutMs,
    });
    for (const uid of userIds) {
      this._emitUser(uid, 'wallet:balance', { coins: await wallet.getBalance(uid) });
    }
    this._armTurn(room);
  }

  handleRoll(userId) {
    const room = this._roomOf(userId);
    if (!room || room.status !== 'playing') throw new GameError('No active game', 'NO_GAME');

    const die = room.dice.roll();
    const result = room.engine.applyRoll(userId, die);
    room.skipCount = 0; // genuine activity

    this._emitRoom(room, 'game:rolled', { die, result, state: room.engine.getState() });
    this._armTurn(room);
    this._maybeBotTurn(room);
    return result;
  }

  async handleMove(userId, tokenIndex) {
    const room = this._roomOf(userId);
    if (!room || room.status !== 'playing') throw new GameError('No active game', 'NO_GAME');

    const result = room.engine.applyMove(userId, tokenIndex);
    room.skipCount = 0;

    if (result.gameOver) {
      this._emitRoom(room, 'game:moved', { result, state: room.engine.getState() });
      await this._finalizeGame(room);
      return result;
    }

    this._emitRoom(room, 'game:moved', { result, state: room.engine.getState() });
    this._armTurn(room);
    this._maybeBotTurn(room);
    return result;
  }

  // Explicit leave during play = forfeit. In a 2-player game the opponent wins
  // the pot; with more players the leaver's tokens are removed and play goes on.
  async handleLeave(userId) {
    const room = this._roomOf(userId);
    if (!room) return;

    if (room.status === 'waiting') {
      this._leaveChannel(room, userId);
      this._removeSeat(room, userId);
      if (room.seats.length === 0) this._destroyRoom(room);
      else this._emitRoom(room, 'room:update', this.serializeRoom(room));
      return;
    }

    if (room.status === 'playing') {
      await this._forfeit(room, userId);
    }
  }

  // ── turn-timeout watchdog ─────────────────────────────────────────────────

  _armTurn(room) {
    this._clearTurn(room);
    if (!room.engine || room.engine.phase === 'finished') return;
    room.turnTimer = setTimeout(() => this._onTurnTimeout(room), config.economy.turnTimeoutMs);
    // Don't let a pending turn timer alone keep the process alive.
    room.turnTimer.unref?.();
  }

  _clearTurn(room) {
    if (room.turnTimer) {
      clearTimeout(room.turnTimer);
      room.turnTimer = null;
    }
  }

  _onTurnTimeout(room) {
    if (!room.engine || room.engine.phase === 'finished') return;
    const pid = room.engine.currentPlayerId();
    room.engine.forceSkip(pid, 'timeout');
    room.skipCount += 1;

    this._emitRoom(room, 'game:state', {
      state: room.engine.getState(),
      note: { type: 'skip', playerId: pid, reason: 'timeout' },
    });

    // The table has gone idle for too many turns in a row. Decide it on the
    // board rather than voiding it: a knockout bracket cannot advance on a match
    // with no result, and whoever was ahead earned that lead. Only a game where
    // literally nobody moved is refunded instead — there is no result to read
    // off an empty board, and no one earned a pot by going AFK first.
    if (room.skipCount >= room.seats.length * 4) {
      const played = room.engine.standings().some((p) => p.steps > 0 || p.home > 0);
      if (played) {
        const decided = room.engine.finishByProgress('inactivity');
        this._emitRoom(room, 'game:state', {
          state: room.engine.getState(),
          note: { type: 'decided', reason: 'inactivity' },
        });
        this._settleWinner(room, decided.winnerId, { endedBy: 'inactivity' });
      } else {
        this._abortGame(room, 'inactivity');
      }
      return;
    }
    this._armTurn(room);
    this._maybeBotTurn(room);
  }

  // ── settlement ────────────────────────────────────────────────────────────

  // Pay out the pot, record the game, notify everyone. Shared by a natural
  // finish and a forfeit win. `room.seats` always holds every original player
  // (even one who left), so the game record and stats are complete.
  async _settleWinner(room, winnerId, extra = {}) {
    this._clearTurn(room);
    const engine = room.engine;

    // Practice: nothing is staked, so nothing is paid, recorded or ranked.
    if (room.isPractice) {
      room.status = 'finished';
      this._emitRoom(room, 'game:over', {
        state: engine.getState(),
        winnerId,
        pot: 0,
        payout: 0,
        rake: 0,
        isPractice: true,
        fairness: room.dice.reveal(),
        ...(extra.endedBy ? { reason: extra.endedBy } : {}),
      });
      this._destroyRoom(room, 60_000);
      return;
    }

    const settle = await wallet.settlePot(room.id, winnerId, room.pot, config.economy.rakeBips);
    for (const s of room.seats) {
      await store.incrementStats(s.userId, s.userId === winnerId);
    }

    const fairness = room.dice.reveal();
    await store.recordGame({
      id: room.id,
      stake: room.stake,
      pot: room.pot,
      winnerId,
      payout: settle.payout,
      rake: settle.rake,
      players: room.seats.map((s) => ({ userId: s.userId, name: s.name, color: s.color })),
      endedAt: Date.now(),
      fairness,
      history: engine.history,
      ...extra,
    });

    room.status = 'finished';
    this._emitRoom(room, 'game:over', {
      state: engine.getState(),
      winnerId,
      pot: room.pot,
      payout: settle.payout,
      rake: settle.rake,
      fairness, // reveal seeds so anyone can verify every roll
      ...(extra.endedBy ? { reason: extra.endedBy } : {}),
    });
    for (const s of room.seats) {
      this._emitUser(s.userId, 'wallet:balance', { coins: await wallet.getBalance(s.userId) });
    }
    this._destroyRoom(room, 60_000); // keep briefly so clients can read the result
  }

  async _finalizeGame(room) {
    await this._settleWinner(room, room.engine.winners[0]);
  }

  // A player left/forfeited. The engine removes them cleanly; if that leaves one
  // player standing, they win the pot — otherwise play continues (3–4 players).
  async _forfeit(room, leaverId) {
    this._clearTurn(room);
    const result = room.engine.eliminatePlayer(leaverId);
    if (!result) return; // already out / game already over

    if (result.gameOver) {
      await this._settleWinner(room, result.winnerId, { endedBy: 'forfeit', forfeitedBy: leaverId });
      return;
    }

    // Still going with 3–4 players: free the leaver to play elsewhere, but keep
    // their seat for the record. Their tokens are already off the board.
    this._leaveChannel(room, leaverId);
    if (this.userRoom.get(leaverId) === room.id) this.userRoom.delete(leaverId);
    this._clearDisconnectTimer(room, leaverId);
    this._emitRoom(room, 'game:state', {
      state: room.engine.getState(),
      note: { type: 'forfeit', playerId: leaverId },
    });
    this._armTurn(room);
    this._maybeBotTurn(room);
  }

  async _abortGame(room, reason) {
    this._clearTurn(room);
    const userIds = room.seats.map((s) => s.userId);
    if (room.isPractice) {
      room.status = 'finished';
      this._emitRoom(room, 'game:aborted', { reason, refunded: 0, isPractice: true });
      this._destroyRoom(room, 30_000);
      return;
    }
    await wallet.refundStakes(room.id, userIds, room.stake);
    room.status = 'finished';
    this._emitRoom(room, 'game:aborted', { reason, refunded: room.stake });
    for (const uid of userIds) {
      this._emitUser(uid, 'wallet:balance', { coins: await wallet.getBalance(uid) });
    }
    this._destroyRoom(room, 30_000);
  }

  // ── connection bookkeeping ─────────────────────────────────────────────────

  async markConnected(userId, connected) {
    const room = this._roomOf(userId);
    if (!room) return;
    const seat = room.seats.find((s) => s.userId === userId);

    if (connected) {
      if (seat) seat.connected = true;
      this._clearDisconnectTimer(room, userId); // reconnected in time — cancel forfeit
      this._emitRoom(room, 'room:update', this.serializeRoom(room));
      return;
    }

    // Disconnected — but a user may have several sockets (multiple tabs). Only
    // treat them as gone when NO socket of theirs remains, so closing one tab
    // never forfeits a game they're still playing in another.
    if (await this._hasLiveSocket(userId)) return;

    if (seat) seat.connected = false;

    if (room.status === 'waiting') {
      // Nothing is staked yet — just drop them from the waiting room.
      this._leaveChannel(room, userId);
      this._removeSeat(room, userId);
      if (room.seats.length === 0) this._destroyRoom(room);
      else this._emitRoom(room, 'room:update', this.serializeRoom(room));
      return;
    }

    if (room.status === 'playing') {
      this._emitRoom(room, 'room:update', this.serializeRoom(room));
      // Give them a grace period to reconnect; if they don't, they forfeit so
      // the opponent isn't left waiting on a rage-quitter for minutes.
      if (!room.disconnectTimers.has(userId)) {
        const timer = setTimeout(async () => {
          room.disconnectTimers.delete(userId);
          // Re-check at fire time: they may have reconnected on another socket.
          if (await this._hasLiveSocket(userId)) return;
          this.handleLeave(userId).catch(() => {});
        }, config.economy.disconnectGraceMs);
        timer.unref?.();
        room.disconnectTimers.set(userId, timer);
      }
    }
  }

  // Does this user still have at least one connected socket?
  async _hasLiveSocket(userId) {
    try {
      const sockets = await this.io.in(`user:${userId}`).fetchSockets();
      return sockets.length > 0;
    } catch {
      return false; // no adapter (e.g. in tests) — treat as fully disconnected
    }
  }

  _clearDisconnectTimer(room, userId) {
    const timer = room.disconnectTimers?.get(userId);
    if (timer) {
      clearTimeout(timer);
      room.disconnectTimers.delete(userId);
    }
  }

  _removeSeat(room, userId) {
    room.seats = room.seats.filter((s) => s.userId !== userId);
    this.userRoom.delete(userId);
    if (room.hostId === userId && room.seats.length > 0) {
      room.hostId = room.seats[0].userId;
    }
  }

  // Drop a player from a not-yet-started room (e.g. they can't afford the stake),
  // send them back to the lobby, and take their sockets out of the room channel.
  _ejectFromWaiting(room, userId) {
    this._emitUser(userId, 'room:error', {
      code: 'INSUFFICIENT_FUNDS',
      message: 'You no longer have enough coins for this stake.',
    });
    this._emitUser(userId, 'room:left', {});
    this.io.in(`user:${userId}`).socketsLeave(`room:${room.id}`);
    this._removeSeat(room, userId);
  }

  _destroyRoom(room, delayMs = 0) {
    // Free players to start a new game immediately, and cancel any pending timers.
    // Only clear a mapping that still points HERE — a player may already have
    // joined a new room, and we must not orphan them from it.
    for (const s of room.seats) {
      if (this.userRoom.get(s.userId) === room.id) this.userRoom.delete(s.userId);
    }
    if (room.disconnectTimers) {
      for (const t of room.disconnectTimers.values()) clearTimeout(t);
      room.disconnectTimers.clear();
    }
    this._clearBotFill(room);
    if (room.botMoveTimer) {
      clearTimeout(room.botMoveTimer);
      room.botMoveTimer = null;
    }
    this._clearTurn(room);
    // Empty the broadcast channel NOW (the final event has already been emitted).
    // Anything this room might still emit must not reach a player who has moved
    // on to a new game.
    this.io.socketsLeave(`room:${room.id}`);
    const remove = () => this.rooms.delete(room.id);
    if (delayMs > 0) setTimeout(remove, delayMs).unref?.();
    else remove();
  }
}
