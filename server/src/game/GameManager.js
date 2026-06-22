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
    };
  }

  _validateStake(stake) {
    if (!Number.isInteger(stake) || stake <= 0) {
      throw new GameError('Stake must be a positive whole number of coins', 'BAD_STAKE');
    }
  }

  // ── lobby / matchmaking ─────────────────────────────────────────────────

  async createRoom(user, { stake, maxPlayers = 2, rules = {}, isPrivate = false } = {}) {
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
      engine: null,
      dice: null,
      turnTimer: null,
      skipCount: 0,
      createdAt: Date.now(),
    };
    this._seatUser(room, user);
    this.rooms.set(room.id, room);
    return room;
  }

  // `onSeated(room)` runs synchronously the moment the user takes a seat — the
  // socket layer uses it to join the broadcast room BEFORE `game:start` fires,
  // so a player who fills the last seat never misses the kickoff event.
  async joinRoom(user, roomId, onSeated) {
    const room = this.rooms.get(roomId);
    if (!room) throw new GameError('Room not found', 'NO_ROOM');
    if (room.status !== 'waiting') throw new GameError('Game already started', 'ALREADY_STARTED');
    if (room.seats.length >= room.maxPlayers) throw new GameError('Room is full', 'ROOM_FULL');
    if (this._roomOf(user.id)) throw new GameError('You are already in a game', 'ALREADY_IN_GAME');
    if ((await wallet.getBalance(user.id)) < room.stake) {
      throw new GameError('Not enough coins for this stake', 'INSUFFICIENT_FUNDS');
    }

    this._seatUser(room, user);
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
  async quickMatch(user, stake, maxPlayers = 2, onSeated) {
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
        await this.joinRoom(user, room.id, onSeated);
        return room;
      }
    }
    const room = await this.createRoom(user, { stake, maxPlayers, isPrivate: false });
    if (onSeated) onSeated(room);
    return room;
  }

  _seatUser(room, user) {
    const seat = {
      userId: user.id,
      name: user.name,
      picture: user.picture,
      color: COLORS[room.seats.length],
      connected: true,
    };
    room.seats.push(seat);
    this.userRoom.set(user.id, room.id);
  }

  // ── game lifecycle ──────────────────────────────────────────────────────

  async _startGame(room) {
    const userIds = room.seats.map((s) => s.userId);
    let escrow;
    try {
      escrow = await wallet.escrowStakes(room.id, userIds, room.stake);
    } catch (err) {
      // Someone can no longer cover the stake — keep the room open, tell them.
      this._emitRoom(room, 'room:error', {
        code: err.code || 'ESCROW_FAILED',
        message: 'Could not start: a player has insufficient coins.',
      });
      return;
    }

    room.pot = escrow.pot;
    room.dice = new ProvablyFairDice();
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

  async _finalizeGame(room) {
    this._clearTurn(room);
    const engine = room.engine;
    const winnerId = engine.winners[0];

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
      players: room.seats.map((s) => ({ userId: s.userId, color: s.color })),
      endedAt: Date.now(),
      fairness,
      history: engine.history,
    });

    room.status = 'finished';
    this._emitRoom(room, 'game:over', {
      state: engine.getState(),
      winnerId,
      pot: room.pot,
      payout: settle.payout,
      rake: settle.rake,
      fairness, // reveal seeds so anyone can verify every roll
    });
    for (const s of room.seats) {
      this._emitUser(s.userId, 'wallet:balance', { coins: await wallet.getBalance(s.userId) });
    }
    this._destroyRoom(room, 60_000); // keep briefly so clients can read the result
  }

  async _forfeit(room, leaverId) {
    this._clearTurn(room);
    const remaining = room.seats.filter((s) => s.userId !== leaverId);

    // Heads-up game: the remaining player wins the whole pot.
    if (remaining.length === 1) {
      const winnerId = remaining[0].userId;
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
        players: room.seats.map((s) => ({ userId: s.userId, color: s.color })),
        endedAt: Date.now(),
        endedBy: 'forfeit',
        forfeitedBy: leaverId,
        fairness,
      });
      room.status = 'finished';
      this._emitRoom(room, 'game:over', {
        state: room.engine.getState(),
        winnerId,
        pot: room.pot,
        payout: settle.payout,
        rake: settle.rake,
        reason: 'forfeit',
        fairness,
      });
      this._emitUser(winnerId, 'wallet:balance', { coins: await wallet.getBalance(winnerId) });
      this._destroyRoom(room, 60_000);
      return;
    }

    // 3–4 player game: just remove the leaver and continue.
    this._removeSeat(room, leaverId);
    this._emitRoom(room, 'room:update', this.serializeRoom(room));
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
    if (seat) {
      seat.connected = connected;
      this._emitRoom(room, 'room:update', this.serializeRoom(room));
    }
    // Note: we deliberately do NOT end a game on a transient disconnect — the
    // player may reconnect, and the turn watchdog keeps the game moving.
    if (!connected && room.status === 'waiting') {
      this._removeSeat(room, userId);
      if (room.seats.length === 0) this._destroyRoom(room);
      else this._emitRoom(room, 'room:update', this.serializeRoom(room));
    }
  }

  _removeSeat(room, userId) {
    room.seats = room.seats.filter((s) => s.userId !== userId);
    this.userRoom.delete(userId);
    if (room.hostId === userId && room.seats.length > 0) {
      room.hostId = room.seats[0].userId;
    }
  }

  _destroyRoom(room, delayMs = 0) {
    // Free players to start a new game immediately.
    for (const s of room.seats) this.userRoom.delete(s.userId);
    const remove = () => this.rooms.delete(room.id);
    if (delayMs > 0) setTimeout(remove, delayMs).unref?.();
    else remove();
  }
}
