// ──────────────────────────────────────────────────────────────────────────
// Tournament money maths. Pure functions — no I/O — so every rupee can be
// unit-tested.
//
// You set three knobs in the admin panel:
//   • entryFeeInr  — what each player pays
//   • rakeBips     — your cut, in basis points (500 = 5%)
//   • payoutSplit  — how the remaining prize pool is shared, e.g. [100] or [70,30]
//
// Everything else is derived:
//   gross     = entryFee × players
//   rake      = floor(gross × rakeBips / 10000)      ← your revenue
//   prizePool = gross − rake                          ← paid out to players
//
// ALL amounts are whole rupees. Integer maths only: floats lose money.
// Rounding remainders go to the top prize, never to the house — a player is
// never short-changed by a rounding rule they can't see.
// ──────────────────────────────────────────────────────────────────────────

export const MAX_RAKE_BIPS = 3000; // a 30% cut is already very steep

// Validate a payout split: whole percentages, all positive, summing to 100.
export function validateSplit(split) {
  if (!Array.isArray(split) || split.length === 0) return 'Payout split is required';
  if (split.some((p) => !Number.isInteger(p) || p <= 0)) return 'Each payout share must be a positive whole percent';
  const total = split.reduce((a, b) => a + b, 0);
  if (total !== 100) return `Payout shares must add up to 100% (currently ${total}%)`;
  return null;
}

export function validateRake(rakeBips) {
  if (!Number.isInteger(rakeBips) || rakeBips < 0) return 'Your cut must be a whole number of basis points';
  if (rakeBips > MAX_RAKE_BIPS) return `Your cut cannot exceed ${MAX_RAKE_BIPS / 100}%`;
  return null;
}

// The pot as it stands right now, given how many players have actually paid.
export function computePot({ entryFeeInr = 0, players = 0, rakeBips = 0 }) {
  const fee = Math.max(0, Math.trunc(entryFeeInr));
  const n = Math.max(0, Math.trunc(players));
  const gross = fee * n;
  const rake = Math.floor((gross * Math.max(0, rakeBips)) / 10000);
  return { gross, rake, prizePool: gross - rake, players: n, entryFeeInr: fee };
}

// Split a prize pool into per-place amounts. Any rounding remainder is added
// to first place so the parts always sum EXACTLY back to the pool.
export function computePayouts({ prizePool = 0, split = [100] }) {
  const pool = Math.max(0, Math.trunc(prizePool));
  const amounts = split.map((pct) => Math.floor((pool * pct) / 100));
  const distributed = amounts.reduce((a, b) => a + b, 0);
  const remainder = pool - distributed;
  if (amounts.length) amounts[0] += remainder;
  return amounts.map((amountInr, i) => ({
    place: i + 1,
    percent: split[i],
    amountInr,
  }));
}

// Everything the admin panel needs for one tournament, in one shape.
// `players` is the number who have actually PAID (approved entries) — the pot
// is only ever what has really been collected, never what might be collected.
export function financials({ entryFeeInr, players, rakeBips, payoutSplit, maxPlayers }) {
  const now = computePot({ entryFeeInr, players, rakeBips });
  const full = computePot({ entryFeeInr, players: maxPlayers, rakeBips });
  return {
    entryFeeInr: now.entryFeeInr,
    players: now.players,
    maxPlayers,
    rakeBips,
    // As it stands, with the players who have paid so far.
    collectedInr: now.gross,
    yourCutInr: now.rake,
    prizePoolInr: now.prizePool,
    payouts: computePayouts({ prizePool: now.prizePool, split: payoutSplit }),
    // What it becomes if every seat sells — useful when advertising the event.
    ifFull: {
      collectedInr: full.gross,
      yourCutInr: full.rake,
      prizePoolInr: full.prizePool,
      payouts: computePayouts({ prizePool: full.prizePool, split: payoutSplit }),
    },
  };
}

// Who gets paid what, once the bracket has produced a finishing order.
export function prizeAwards({ standings, payouts }) {
  return payouts
    .filter((p) => p.amountInr > 0)
    .map((p) => ({ ...p, userId: standings[p.place - 1] || null }))
    .filter((p) => p.userId);
}
