import crypto from 'node:crypto';

// ──────────────────────────────────────────────────────────────────────────
// Provably-fair dice.
//
// Two properties we want:
//   1. The OPERATOR cannot rig rolls (build user trust for a money game).
//   2. A PLAYER cannot predict or influence rolls to their advantage.
//
// Scheme (the same commit–reveal idea casinos use):
//   • At game start the server picks a secret `serverSeed` (32 random bytes)
//     and publishes only its SHA-256 hash (`serverSeedHash`). This commits the
//     server to a sequence of rolls it cannot change afterwards.
//   • Each roll mixes serverSeed + a public `clientSeed` + an incrementing
//     `nonce` through HMAC-SHA256. Neither side alone controls the output.
//   • When the game ends the server reveals `serverSeed`; anyone can hash it,
//     check it matches the published commitment, and recompute every roll.
//
// `crypto.randomBytes` / HMAC are cryptographically secure, so rolls are
// unpredictable even though they are deterministic given the seeds.
// ──────────────────────────────────────────────────────────────────────────

export function createServerSeed() {
  return crypto.randomBytes(32).toString('hex');
}

export function hashServerSeed(serverSeed) {
  return crypto.createHash('sha256').update(serverSeed).digest('hex');
}

// Deterministically derive a die value (1..6) from the seeds + nonce.
// Uses rejection sampling over the HMAC byte stream to avoid modulo bias, so
// every face is exactly equally likely.
export function rollFromSeeds(serverSeed, clientSeed, nonce) {
  let round = 0;
  // Practically this never loops more than once, but we keep extending the
  // stream until we get an unbiased byte rather than accepting a biased one.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const hmac = crypto
      .createHmac('sha256', serverSeed)
      .update(`${clientSeed}:${nonce}:${round}`)
      .digest();

    for (const byte of hmac) {
      // 252 is the largest multiple of 6 <= 255. Reject the top 4 values
      // (252..255) so the remaining 0..251 map evenly onto 0..5.
      if (byte < 252) {
        return (byte % 6) + 1;
      }
    }
    round += 1;
  }
}

// A small stateful helper a game holds onto: keeps the secret seed, exposes the
// commitment, and increments the nonce for each roll.
export class ProvablyFairDice {
  constructor(clientSeed = '') {
    this.serverSeed = createServerSeed();
    this.serverSeedHash = hashServerSeed(this.serverSeed);
    this.clientSeed = clientSeed || crypto.randomBytes(8).toString('hex');
    this.nonce = 0;
  }

  // The public commitment shown to players at game start.
  commitment() {
    return { serverSeedHash: this.serverSeedHash, clientSeed: this.clientSeed };
  }

  // Produce the next die value and advance the nonce.
  roll() {
    const value = rollFromSeeds(this.serverSeed, this.clientSeed, this.nonce);
    this.nonce += 1;
    return value;
  }

  // Called only when the game is over: lets clients verify the whole sequence.
  reveal() {
    return {
      serverSeed: this.serverSeed,
      serverSeedHash: this.serverSeedHash,
      clientSeed: this.clientSeed,
      rolls: this.nonce,
    };
  }
}
