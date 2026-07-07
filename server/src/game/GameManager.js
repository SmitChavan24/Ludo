import { nanoid } from 'nanoid';
import { LudoEngine, GameError } from './LudoEngine.js';
import { ProvablyFairDice } from './dice.js';
import { COLORS } from './constants.js';
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

  _emitRoom(room, event, payload) {
    this.io.to(`room:${room.id}`).emit(event, payload);
  }

  _emitUser(userId, event, payload) {
    this.io.to(`user:${userId}`).emit(event, payload);
  }

  serializeRoom(room) {
    return {
      id: room.id,
      status: room.status,
      stake: room.stake,
      maxPlayers: room.maxPlayers,
      isPrivate: room.isPrivate,
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

  _validateStake(stake) {
    if (!Number.isInteger(stake) || stake <= 0) {
      throw new GameError('Stake must be a positive whole number of coins', 'BAD_STAKE');
    }
  }

  // ── lobby / matchmaking ─────────────────────────────────────────────────

  async createRoom(user, { stake, maxPlayers = 2, rules = {}, isPrivate = false, clientSeed } = {}) {
    this._validateStake(stake);
    if (![2, 3, 4].includes(maxPlayers)) {
      throw new GameError('A game must have 2, 3, or 4 players', 'BAD_MAX_PLAYERS');
    }
    if (this._roomOf(user.id)) {
      throw new GameError('You are already in a game', 'ALREADY_IN_GAME');
    }
    if ((await wallet.getBalance(user.id)) < stake) {
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
      rules,
      hostId: user.id,
      seats: [],
      pot: 0,
      // Commit the dice server seed NOW, before any player contributes a seed.
      dice: new ProvablyFairDice(),
      engine: null,
      turnTimer: null,
      disconnectTimers: new Map(), // userId -> grace timer
      skipCount: 0,
      createdAt: Date.now(),
    };
    this._seatUser(room, user, clientSeed);
    this.rooms.set(room.id, room);
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
    if ((await wallet.getBalance(user.id)) < room.stake) {
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
  async quickMatch(user, stake, maxPlayers = 2, onSeated, clientSeed) {
    this._validateStake(stake);
    if (![2, 3, 4].includes(maxPlayers)) {
      throw new GameError('A game must have 2, 3, or 4 players', 'BAD_MAX_PLAYERS');
    }
    if (this._roomOf(user.id)) throw new GameError('You are already in a game', 'ALREADY_IN_GAME');

    for (const room of this.rooms.values()) {
      if (
        !room.isPrivate &&
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
    const room = await this.createRoom(user, { stake, maxPlayers, isPrivate: false, clientSeed });
    if (onSeated) onSeated(room);
    return room;
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
    return result;
  }

  // Explicit leave during play = forfeit. In a 2-player game the opponent wins
  // the pot; with more players the leaver's tokens are removed and play goes on.
  async handleLeave(userId) {
    const room = this._roomOf(userId);
    if (!room) return;

    if (room.status === 'waiting') {
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

    // If the table has gone idle for too many turns in a row, abort & refund so
    // nobody's stake is held hostage by an AFK opponent.
    if (room.skipCount >= room.seats.length * 4) {
      this._abortGame(room, 'inactivity');
      return;
    }
    this._armTurn(room);
  }

  // ── settlement ────────────────────────────────────────────────────────────

  // Pay out the pot, record the game, notify everyone. Shared by a natural
  // finish and a forfeit win. `room.seats` always holds every original player
  // (even one who left), so the game record and stats are complete.
  async _settleWinner(room, winnerId, extra = {}) {
    this._clearTurn(room);
    const engine = room.engine;

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
    this.userRoom.delete(leaverId);
    this._clearDisconnectTimer(room, leaverId);
    this._emitRoom(room, 'game:state', {
      state: room.engine.getState(),
      note: { type: 'forfeit', playerId: leaverId },
    });
    this._armTurn(room);
  }

  async _abortGame(room, reason) {
    this._clearTurn(room);
    const userIds = room.seats.map((s) => s.userId);
    await wallet.refundStakes(room.id, userIds, room.stake);
    room.status = 'finished';
    this._emitRoom(room, 'game:aborted', { reason, refunded: room.stake });
    for (const uid of userIds) {
      this._emitUser(uid, 'wallet:balance', { coins: await wallet.getBalance(uid) });
    }
    this._destroyRoom(room, 30_000);
  }

  // ── connection bookkeeping ─────────────────────────────────────────────────

  markConnected(userId, connected) {
    const room = this._roomOf(userId);
    if (!room) return;
    const seat = room.seats.find((s) => s.userId === userId);

    if (connected) {
      if (seat) seat.connected = true;
      this._clearDisconnectTimer(room, userId); // reconnected in time — cancel forfeit
      this._emitRoom(room, 'room:update', this.serializeRoom(room));
      return;
    }

    // Disconnected.
    if (seat) seat.connected = false;

    if (room.status === 'waiting') {
      // Nothing is staked yet — just drop them from the waiting room.
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
        const timer = setTimeout(() => {
          room.disconnectTimers.delete(userId);
          this.handleLeave(userId).catch(() => {});
        }, config.economy.disconnectGraceMs);
        timer.unref?.();
        room.disconnectTimers.set(userId, timer);
      }
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
    for (const s of room.seats) this.userRoom.delete(s.userId);
    if (room.disconnectTimers) {
      for (const t of room.disconnectTimers.values()) clearTimeout(t);
      room.disconnectTimers.clear();
    }
    this._clearTurn(room);
    const remove = () => this.rooms.delete(room.id);
    if (delayMs > 0) setTimeout(remove, delayMs).unref?.();
    else remove();
  }
}
