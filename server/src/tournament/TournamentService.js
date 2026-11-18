import { nanoid } from 'nanoid';
import { store } from '../db/store.js';
import { wallet, HOUSE_ACCOUNT } from '../wallet/Wallet.js';
import { normalizeUtr, isValidUtr } from '../util/payments.js';
import { financials, validateSplit, validateRake, computePayouts, prizeAwards } from './economics.js';
import { reasonText, scoreText } from './outcome.js';
import { push, notify } from '../push/PushService.js';
import { config } from '../config.js';
import { cash } from '../cash/CashService.js';
import { buildBracket, reportWinner, pendingMatches, champion, isComplete, standings, findMatch } from './bracket.js';

export class TournamentError extends Error {
  constructor(message, code = 'TOURNAMENT_ERROR') {
    super(message);
    this.name = 'TournamentError';
    this.code = code;
  }
}

// Entry can be paid two ways:
//   'coins'  — deducted automatically from the player's coin balance
//   'manual' — collected OUTSIDE the app (e.g. UPI); an admin confirms the
//              payment and adds the player, recording a payment reference.
// 'balance' — the admin-set entry fee is debited from the player's CASH wallet
//              (they topped up once; joining is then instant)
// 'manual'  — the player pays that fee by UPI per tournament and submits a UTR
// 'coins'   — free-play tournament, costs practice coins only
export const ENTRY_TYPES = ['coins', 'manual', 'balance'];
export const VALID_SIZES = [2, 4, 8, 16, 32];

// ──────────────────────────────────────────────────────────────────────────
// TournamentService — creation, entries, bracket progression and payouts.
//
// The bracket is the authority on who plays whom: results can only be recorded
// for a match that is actually pending, and only for a player in it.
// ──────────────────────────────────────────────────────────────────────────
export class TournamentService {
  // ── admin: lifecycle ──
  async create({
    title, entryType = 'manual', entryFeeCoins = 0, entryFeeInr = 0, prizeText = '', prizeCoins = 0,
    maxPlayers = 8, startsAt = null, rakeBips = 0, payoutSplit = [100], autoStart = true,
    lobbyMinutes = null,
  }) {
    if (!title || !String(title).trim()) throw new TournamentError('Title is required', 'BAD_TITLE');
    if (!ENTRY_TYPES.includes(entryType)) throw new TournamentError('Invalid entry type', 'BAD_ENTRY_TYPE');
    if (!VALID_SIZES.includes(maxPlayers)) {
      throw new TournamentError(`Player count must be one of ${VALID_SIZES.join(', ')}`, 'BAD_SIZE');
    }
    if (entryType === 'coins' && (!Number.isInteger(entryFeeCoins) || entryFeeCoins <= 0)) {
      throw new TournamentError('A coin tournament needs a positive entry fee', 'BAD_FEE');
    }
    if (entryType === 'balance' && (!Number.isInteger(Number(entryFeeInr)) || Number(entryFeeInr) <= 0)) {
      throw new TournamentError('A cash tournament needs a positive entry fee in rupees', 'BAD_FEE');
    }

    const rakeError = validateRake(rakeBips);
    if (rakeError) throw new TournamentError(rakeError, 'BAD_RAKE');
    const splitError = validateSplit(payoutSplit);
    if (splitError) throw new TournamentError(splitError, 'BAD_SPLIT');
    if (payoutSplit.length > maxPlayers) {
      throw new TournamentError('More prize places than players', 'BAD_SPLIT');
    }

    const t = {
      id: nanoid(12),
      title: String(title).trim().slice(0, 160),
      status: 'open',
      entryType,
      entryFeeCoins: entryType === 'coins' ? entryFeeCoins : 0,
      entryFeeInr: entryType === 'manual' || entryType === 'balance' ? Math.max(0, parseInt(entryFeeInr, 10) || 0) : 0,
      prizeText: String(prizeText || '').slice(0, 255),
      prizeCoins: Math.max(0, parseInt(prizeCoins, 10) || 0),
      maxPlayers,
      startsAt: startsAt ? Number(startsAt) : null,
      // Registration closes when the lobby opens, so players have a settled
      // window to arrive in before the first match is drawn.
      lobbyOpensAt: startsAt
        ? Number(startsAt) - (lobbyMinutes ?? config.economy.lobbyMinutes) * 60_000
        : null,
      createdAt: Date.now(),
      finishedAt: null,
      winnerId: null,
      rakeBips,
      payoutSplit,
      autoStart: autoStart !== false,
      bracket: null,
    };
    await store.createTournament(t);
    return t;
  }

  async get(id) {
    const t = await store.getTournament(id);
    if (!t) throw new TournamentError('Tournament not found', 'NOT_FOUND');
    return t;
  }

  // Listings carry the live paid-entry count, so a card can show the pot as it
  // actually stands rather than only what it would be if every seat sold.
  async list(opts) {
    const rows = await store.listTournaments(opts);
    const counts = await store.countEntriesByTournament(rows.map((t) => t.id));
    return rows.map((t) => ({ ...t, players: counts[t.id] || 0 }));
  }

  async entries(id) {
    return store.listTournamentEntries(id);
  }

  // Full view: tournament + entries + live money + bracket.
  async detail(id) {
    const tournament = await this.get(id);
    const entries = await store.listTournamentEntries(id);
    return {
      tournament,
      entries,
      playing: tournament.bracket ? pendingMatches(tournament.bracket) : [],
      money: this.financialsFor(tournament, entries.length),
    };
  }

  // Live pot / your cut / prize breakdown. Derived from what has ACTUALLY been
  // paid, so the numbers can never overstate the prize.
  // For a coin tournament the same maths runs in COINS (the *Inr field names
  // are then coin amounts); `unit` tells callers which one they are reading.
  financialsFor(t, playerCount) {
    const unit = t.entryType === 'coins' ? 'coins' : 'inr';
    const money = financials({
      entryFeeInr: unit === 'coins' ? t.entryFeeCoins : t.entryFeeInr,
      players: playerCount,
      maxPlayers: t.maxPlayers,
      rakeBips: t.rakeBips || 0,
      payoutSplit: t.payoutSplit?.length ? t.payoutSplit : [100],
    });
    return { ...money, unit };
  }

  // Who is owed what, once a tournament has finished.
  async prizeSheet(id) {
    const t = await this.get(id);
    const entries = await store.listTournamentEntries(id);
    const money = this.financialsFor(t, entries.length);
    const order = t.bracket ? standings(t.bracket) : [];
    const names = Object.fromEntries(entries.map((e) => [e.userId, e.name]));
    return prizeAwards({ standings: order, payouts: money.payouts })
      .map((a) => ({ ...a, name: names[a.userId] || null }));
  }

  // ── entries ──

  // A player joins a COIN tournament themselves (fee debited immediately).
  async joinWithCoins(user, tournamentId) {
    const t = await this.get(tournamentId);
    if (t.entryType !== 'coins') {
      throw new TournamentError('This tournament is not open for coin entry', 'WRONG_ENTRY_TYPE');
    }
    await this._assertJoinable(t, user.id);

    if ((await wallet.getBalance(user.id)) < t.entryFeeCoins) {
      throw new TournamentError('Not enough coins for the entry fee', 'INSUFFICIENT_FUNDS');
    }
    await wallet.debit(user.id, t.entryFeeCoins, 'tournament_entry', t.id);
    return this._addEntry(t, user.id, { addedBy: user.id });
  }

  // Pay the admin-set entry fee straight from the player's cash balance.
  // One top-up, then instant entry — no per-tournament UTR to check.
  async joinWithBalance(user, tournamentId) {
    const t = await this.get(tournamentId);
    if (t.entryType !== 'balance') {
      throw new TournamentError('This tournament is not open for balance entry', 'WRONG_ENTRY_TYPE');
    }
    await this._assertJoinable(t, user.id);

    try {
      await cash.payEntryFee(user.id, t.entryFeeInr, t.id);
    } catch (e) {
      throw new TournamentError(e.message, e.code || 'INSUFFICIENT_FUNDS');
    }
    return this._addEntry(t, user.id, { paymentRef: 'balance', addedBy: user.id });
  }

  // An ADMIN adds a player after confirming an off-app payment (UPI etc.).
  // `paymentRef` records how it was paid — keep it, it is your audit trail.
  async addEntryManually(tournamentId, userId, { paymentRef = '', addedBy = 'admin' } = {}) {
    const t = await this.get(tournamentId);
    const user = await store.getUser(userId);
    if (!user) throw new TournamentError('User not found', 'NO_USER');
    await this._assertJoinable(t, userId);
    return this._addEntry(t, userId, { paymentRef, addedBy });
  }

  async removeEntry(tournamentId, userId) {
    const t = await this.get(tournamentId);
    if (t.status !== 'open') throw new TournamentError('Entries are locked once the tournament starts', 'LOCKED');
    const removed = await store.removeTournamentEntry(tournamentId, userId);
    if (!removed) throw new TournamentError('That player is not entered', 'NOT_ENTERED');
    // Entries paid from a balance are refunded when withdrawn before the start.
    if (t.entryType === 'coins' && t.entryFeeCoins > 0) {
      await wallet.credit(userId, t.entryFeeCoins, 'tournament_refund', t.id);
    } else if (t.entryType === 'balance' && t.entryFeeInr > 0) {
      await cash.refundEntryFee(userId, t.entryFeeInr, t.id);
    }
    return true;
  }

  async _assertJoinable(t, userId) {
    if (t.status !== 'open') throw new TournamentError('This tournament is not open for entries', 'NOT_OPEN');
    const entries = await store.listTournamentEntries(t.id);
    if (entries.length >= t.maxPlayers) throw new TournamentError('Tournament is full', 'FULL');
    if (entries.some((e) => e.userId === userId)) throw new TournamentError('Already entered', 'ALREADY_ENTERED');
  }

  async _addEntry(t, userId, { paymentRef = '', addedBy = null } = {}) {
    const entries = await store.listTournamentEntries(t.id);
    const entry = {
      tournamentId: t.id,
      userId,
      seed: entries.length + 1,
      paymentRef: paymentRef || null,
      addedBy,
      joinedAt: Date.now(),
      placement: null,
    };
    const added = await store.addTournamentEntry(entry);
    if (!added) throw new TournamentError('Already entered', 'ALREADY_ENTERED');
    return entry;
  }

  // ── payment claims (player submits, admin verifies) ──
  //
  // Nothing here proves a payment happened — only you, looking at your bank
  // statement, can do that. These rules exist to make your review safe:
  //   • one transaction reference can never buy two entries (unique UTR)
  //   • a player can't stack multiple live claims on one tournament
  //   • approval re-checks capacity and status, because time passes between
  //     the claim and your review
  // NOTE: the amount is taken from the tournament, never from the request. A
  // player pays exactly the entry fee you set — they cannot choose their own.
  async submitClaim(user, tournamentId, { utr, note = '' } = {}) {
    const t = await this.get(tournamentId);
    if (t.entryType !== 'manual') {
      throw new TournamentError('This tournament does not take manual payments', 'WRONG_ENTRY_TYPE');
    }
    if (t.status !== 'open') throw new TournamentError('This tournament is not open for entries', 'NOT_OPEN');

    const clean = normalizeUtr(utr);
    if (!isValidUtr(clean)) {
      throw new TournamentError('Enter the 12-digit UPI reference (UTR) from your payment', 'BAD_UTR');
    }

    const entries = await store.listTournamentEntries(tournamentId);
    if (entries.some((e) => e.userId === user.id)) throw new TournamentError('You are already entered', 'ALREADY_ENTERED');
    if (entries.length >= t.maxPlayers) throw new TournamentError('Tournament is full', 'FULL');

    const existing = await store.getActiveClaim(tournamentId, user.id);
    if (existing) {
      throw new TournamentError(
        existing.status === 'approved' ? 'You are already entered' : 'Your payment is already awaiting review',
        existing.status === 'approved' ? 'ALREADY_ENTERED' : 'CLAIM_PENDING',
      );
    }

    const claim = {
      id: nanoid(16),
      tournamentId,
      userId: user.id,
      utr: clean,
      amountInr: t.entryFeeInr || 0,
      note: String(note || '').slice(0, 255),
      status: 'pending',
      createdAt: Date.now(),
      reviewedAt: null,
      reviewedBy: null,
      reviewNote: null,
    };
    const created = await store.createClaim(claim);
    if (!created) {
      // The UTR is already on another claim — same payment being reused.
      throw new TournamentError('That transaction reference has already been submitted', 'DUPLICATE_UTR');
    }
    return created;
  }

  async listClaims(opts) {
    return store.listClaims(opts);
  }

  async myClaim(tournamentId, userId) {
    return store.getActiveClaim(tournamentId, userId);
  }

  // Admin verified the money arrived → grant the entry.
  async approveClaim(claimId, { reviewedBy = 'admin', note = '' } = {}) {
    const claim = await store.getClaim(claimId);
    if (!claim) throw new TournamentError('Claim not found', 'NOT_FOUND');
    if (claim.status !== 'pending') {
      throw new TournamentError(`This claim was already ${claim.status}`, 'ALREADY_REVIEWED');
    }

    // Re-validate against the CURRENT state — the tournament may have filled or
    // started while the claim sat in the queue.
    const t = await this.get(claim.tournamentId);
    await this._assertJoinable(t, claim.userId);

    const entry = await this._addEntry(t, claim.userId, { paymentRef: claim.utr, addedBy: reviewedBy });
    await store.updateClaim(claimId, {
      status: 'approved',
      reviewedAt: Date.now(),
      reviewedBy,
      reviewNote: String(note || '').slice(0, 255),
    });
    push.sendToUser(claim.userId, notify.claimApproved(t)).catch(() => {});
    return { claim: await store.getClaim(claimId), entry };
  }

  // Payment not found / wrong amount / duplicate — say why, so the player can
  // fix it and submit a corrected reference.
  async rejectClaim(claimId, { reviewedBy = 'admin', reason = '' } = {}) {
    const claim = await store.getClaim(claimId);
    if (!claim) throw new TournamentError('Claim not found', 'NOT_FOUND');
    if (claim.status !== 'pending') {
      throw new TournamentError(`This claim was already ${claim.status}`, 'ALREADY_REVIEWED');
    }
    const t = await this.get(claim.tournamentId).catch(() => null);
    if (t) push.sendToUser(claim.userId, notify.claimRejected(t, reason)).catch(() => {});
    return store.updateClaim(claimId, {
      status: 'rejected',
      reviewedAt: Date.now(),
      reviewedBy,
      reviewNote: String(reason || '').slice(0, 255),
    });
  }

  // ── running ──

  // Lock entries and draw the bracket.
  async start(tournamentId) {
    const t = await this.get(tournamentId);
    if (!['open', 'lobby'].includes(t.status)) {
      throw new TournamentError('Tournament already started', 'NOT_OPEN');
    }
    const entries = await store.listTournamentEntries(tournamentId);
    if (entries.length < 2) throw new TournamentError('At least 2 players are needed', 'TOO_FEW');

    const bracket = buildBracket(entries.map((e) => e.userId));
    const patch = { status: 'running', bracket };

    // A tiny field can be fully decided by byes — handle that immediately.
    if (isComplete(bracket)) Object.assign(patch, await this._finishPatch(t, bracket));
    await store.updateTournament(tournamentId, patch);

    push.sendToUsers(entries.map((e) => e.userId), notify.starting(t)).catch(() => {});
    this._notifyLiveMatches(t, bracket, entries).catch(() => {});
    return this.detail(tournamentId);
  }

  // Tell the players whose match just became playable that they're up.
  async _notifyLiveMatches(t, bracket, entries) {
    const names = Object.fromEntries(entries.map((e) => [e.userId, e.name]));
    for (const m of pendingMatches(bracket)) {
      await push.sendToUser(m.a, notify.matchReady(t, names[m.b]));
      await push.sendToUser(m.b, notify.matchReady(t, names[m.a]));
    }
  }

  // Move a tournament into its lobby: entries close, everyone is told.
  async openLobby(tournamentId) {
    const t = await this.get(tournamentId);
    if (t.status !== 'open') throw new TournamentError('Not in registration', 'NOT_OPEN');
    await store.updateTournament(tournamentId, { status: 'lobby' });
    const entries = await store.listTournamentEntries(tournamentId);
    const minutes = t.startsAt ? Math.max(1, Math.round((t.startsAt - Date.now()) / 60_000)) : 0;
    push.sendToUsers(entries.map((e) => e.userId), notify.lobbyOpen(t, minutes)).catch(() => {});
    return this.get(tournamentId);
  }

  // Record a match result and advance the bracket. Called by the game layer
  // when a tournament match finishes, or by an admin for a manual result.
  async recordResult(tournamentId, matchId, winnerId, meta = {}) {
    const t = await this.get(tournamentId);
    if (t.status !== 'running') throw new TournamentError('Tournament is not running', 'NOT_RUNNING');
    if (!t.bracket) throw new TournamentError('Bracket not drawn', 'NO_BRACKET');

    const bracket = t.bracket;
    try {
      reportWinner(bracket, matchId, winnerId, meta);
    } catch (e) {
      throw new TournamentError(e.message, 'BAD_RESULT');
    }

    const patch = { bracket };
    if (isComplete(bracket)) Object.assign(patch, await this._finishPatch(t, bracket));
    await store.updateTournament(tournamentId, patch);

    const entries = await store.listTournamentEntries(tournamentId);
    if (isComplete(bracket)) {
      const prizes = await this.prizeSheet(tournamentId);
      const top = prizes[0];
      if (top?.userId) push.sendToUser(top.userId, notify.won(t, top.amountInr)).catch(() => {});
    } else {
      this._notifyLiveMatches(t, bracket, entries).catch(() => {});
    }
    return this.detail(tournamentId);
  }

  // Attach a room id to a match, so the UI can link players into their game.
  async attachRoom(tournamentId, matchId, roomId) {
    const t = await this.get(tournamentId);
    const match = t.bracket && findMatch(t.bracket, matchId);
    if (!match) throw new TournamentError('Unknown match', 'NO_MATCH');
    match.roomId = roomId;
    await store.updateTournament(tournamentId, { bracket: t.bracket });
    return match;
  }

  // Winner + coin prize (if any). Real-money prizes are paid OUT of band —
  // the tournament only records who won.
  async _finishPatch(t, bracket) {
    const winnerId = champion(bracket);
    if (winnerId && t.prizeCoins > 0) {
      await wallet.credit(winnerId, t.prizeCoins, 'tournament_prize', t.id);
    }
    // Coin tournaments pay their entry-fee pool out in coins, split by place.
    if (t.entryType === 'coins' && t.entryFeeCoins > 0) {
      const entries = await store.listTournamentEntries(t.id);
      const money = this.financialsFor(t, entries.length);
      let paid = 0;
      for (const award of prizeAwards({ standings: standings(bracket), payouts: money.payouts })) {
        if (award.amountInr > 0) {
          await wallet.credit(award.userId, award.amountInr, 'tournament_prize', t.id);
          paid += award.amountInr;
        }
      }
      // Everything collected that was not paid out as prizes is the platform's
      // cut; it goes to the house account so every entry coin is accounted for.
      const cut = money.collectedInr - paid;
      if (cut > 0) await wallet.credit(HOUSE_ACCOUNT, cut, 'tournament_rake', t.id);
    }
    // Cash tournaments settle straight into players' withdrawable balances, so
    // you never have to pay winners by hand.
    if (t.entryType === 'balance') {
      const entries = await store.listTournamentEntries(t.id);
      const money = this.financialsFor(t, entries.length);
      const order = standings(bracket);
      for (const award of prizeAwards({ standings: order, payouts: money.payouts })) {
        await cash.creditWinnings(award.userId, award.amountInr, 'tournament_prize', t.id);
      }
    }
    return { status: 'finished', finishedAt: Date.now(), winnerId };
  }

  async cancel(tournamentId, { refund = true } = {}) {
    const t = await this.get(tournamentId);
    const entrants = await store.listTournamentEntries(tournamentId);
    if (t.status === 'finished') throw new TournamentError('Tournament already finished', 'FINISHED');
    if (refund && t.entryType === 'coins' && t.entryFeeCoins > 0) {
      for (const e of entrants) {
        await wallet.credit(e.userId, t.entryFeeCoins, 'tournament_refund', t.id);
      }
    } else if (refund && t.entryType === 'balance' && t.entryFeeInr > 0) {
      for (const e of entrants) {
        await cash.refundEntryFee(e.userId, t.entryFeeInr, t.id);
      }
    }
    await store.updateTournament(tournamentId, { status: 'cancelled', finishedAt: Date.now() });
    push.sendToUsers(entrants.map((e) => e.userId), notify.cancelled(t)).catch(() => {});
    return this.get(tournamentId);
  }

  // Everything one player needs to understand their position at a glance: which
  // round they are in, how many wins still stand between them and the title,
  // what those wins are worth, and who they play next. Computed server-side so
  // every player sees the same authoritative picture.
  async milestoneFor(tournamentId, userId) {
    const t = await this.get(tournamentId);
    const entries = await store.listTournamentEntries(tournamentId);
    const seat = entries.find((e) => e.userId === userId);
    if (!seat) return { entered: false };

    const money = this.financialsFor(t, entries.length);
    const nameOf = (id) => entries.find((e) => e.userId === id)?.name || 'Opponent';
    const base = {
      entered: true,
      status: t.status,
      players: entries.length,
      prizeIfChampion: money.payouts[0]?.amountInr ?? 0,
      payouts: money.payouts,
    };

    // Before the draw there are no matches yet — show what winning is worth and
    // how many rounds it will take once the bracket is built.
    if (!t.bracket) {
      const rounds = Math.max(1, Math.ceil(Math.log2(Math.max(2, entries.length))));
      return {
        ...base,
        round: 0,
        totalRounds: rounds,
        winsSoFar: 0,
        winsNeeded: rounds,
        eliminated: false,
        nextMatch: null,
        label: `Win ${rounds} match${rounds === 1 ? '' : 'es'} to take the title`,
      };
    }

    const b = t.bracket;
    const totalRounds = b.rounds.length;
    let winsSoFar = 0;
    let eliminated = false;
    let nextMatch = null;
    let currentRound = 0;
    const journey = [];   // every round this player actually reached
    let exit = null;      // where and why their run ended

    for (const round of b.rounds) {
      const m = round.matches.find((x) => x.a === userId || x.b === userId);
      if (!m) continue;
      currentRound = round.round;
      const opponentId = (m.a === userId ? m.b : m.a) || null;
      const leg = {
        round: round.round,
        matchId: m.id,
        opponentId,
        opponentName: opponentId ? nameOf(opponentId) : null,
        roomId: m.roomId || null,
      };

      if (!m.winner) {
        // Still to be played — this is the match in front of them.
        nextMatch = { ...leg, waitingForOpponent: !opponentId };
        journey.push({ ...leg, result: 'playing', reason: 'Yet to be played', score: null });
        break;
      }

      const won = m.winner === userId;
      const entry = {
        ...leg,
        result: won ? 'won' : 'lost',
        endedBy: m.endedBy || 'played',
        reason: reasonText(m.endedBy || 'played', won),
        score: scoreText(m.score, userId, opponentId),
        decidedAt: m.decidedAt || null,
      };
      journey.push(entry);

      if (won) {
        winsSoFar += 1;
      } else {
        eliminated = true;
        exit = entry;
        break;
      }
    }

    const winsNeeded = Math.max(0, totalRounds - winsSoFar);
    const isChampion = champion(b) === userId;
    const place = standings(b).indexOf(userId);
    const placeAward = place >= 0 ? money.payouts[place]?.amountInr ?? 0 : 0;

    let label;
    if (isChampion) label = `You won the tournament — ${money.payouts[0]?.amountInr ?? 0} rupees`;
    else if (eliminated) {
      const where = currentRound === totalRounds ? 'the final' : `round ${currentRound} of ${totalRounds}`;
      const beat = exit?.opponentName ? ` to ${exit.opponentName}` : '';
      label = placeAward > 0
        ? `Knocked out in ${where}${beat} — you still finished in the prizes (${placeAward} rupees)`
        : `Knocked out in ${where}${beat}`;
    } else if (winsNeeded === 1) label = 'Win this match and the title is yours';
    else label = `${winsNeeded} more wins to take the title`;

    return {
      ...base,
      round: currentRound,
      totalRounds,
      winsSoFar,
      winsNeeded,
      eliminated,
      isChampion,
      place: place >= 0 ? place + 1 : null,
      prizeAtCurrentPlace: placeAward,
      nextMatch,
      journey,
      exit,
      label,
    };
  }

  // Every tournament this player has entered, with where they finished and why
  // their run ended. This is the record they can point at when they want to
  // know what happened — one row per tournament, newest first.
  async historyFor(userId, limit = 20) {
    const entered = await store.listTournamentsForUser(userId, limit);
    const rows = [];
    for (const t of entered) {
      const m = await this.milestoneFor(t.id, userId);
      if (!m.entered) continue;
      rows.push({
        tournamentId: t.id,
        title: t.title,
        status: t.status,
        startsAt: t.startsAt,
        entryFeeInr: t.entryFeeInr,
        players: m.players,
        place: m.place,
        isChampion: !!m.isChampion,
        eliminated: !!m.eliminated,
        roundsWon: m.winsSoFar,
        totalRounds: m.totalRounds,
        prizeInr: m.prizeAtCurrentPlace,
        outcome: m.label,
        exit: m.exit,       // the losing match: opponent, reason, score
        journey: m.journey, // every round they played, in order
      });
    }
    return rows;
  }

  // Permanently remove a tournament from the list. Only ever a tidy-up action:
  // a tournament still holding seats must be CANCELLED first, because that is
  // what refunds the entrants. Deleting is not allowed to be a way to make
  // money owed to players quietly disappear.
  async remove(tournamentId) {
    const t = await this.get(tournamentId);
    if (!['cancelled', 'finished'].includes(t.status)) {
      throw new TournamentError(
        'Cancel the tournament first — that refunds every entrant. Then it can be deleted.',
        'NOT_TERMINAL',
      );
    }
    // A pending claim is a player saying "I paid you" with nobody having ruled
    // on it yet. Deleting the tournament would bury that decision.
    const pending = await store.listClaims({ tournamentId, status: 'pending' });
    if (pending.length) {
      throw new TournamentError(
        `${pending.length} payment claim(s) still awaiting review — approve or reject them first.`,
        'PENDING_CLAIMS',
      );
    }
    await store.deleteTournament(tournamentId);
    return { deleted: true, id: tournamentId, title: t.title };
  }

  // Final placings, for display.
  async standings(tournamentId) {
    const t = await this.get(tournamentId);
    return t.bracket ? standings(t.bracket) : [];
  }
}

export const tournaments = new TournamentService();
