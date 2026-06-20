# 🎲 CoinLudo — Secure Multiplayer Ludo

A real-time, multiplayer Ludo game built **security-first** so it can later carry
real money. React PWA front-end, Node.js back-end, coins now / payments-ready
architecture.

> **The one rule that makes this hack-resistant:** the **server is the only
> authority**. The browser never rolls dice, never decides a move is legal, and
> never changes a coin balance. It sends *intents* ("I want to move token 2")
> and the server validates everything. Open devtools and cheat all you like —
> the server simply rejects anything illegal.

---

## Quick start

```bash
# 1. Install everything (root + server + client workspaces)
npm install

# 2. Create the server env file
cp server/.env.example server/.env
#   The dev defaults work out of the box (dev login enabled, ephemeral secrets).
#   For Google login, set GOOGLE_CLIENT_ID. For prod, set real JWT secrets.

# 3. Run backend + frontend together
npm run dev
#   server  -> http://localhost:4000
#   client  -> http://localhost:5173
```

Open `http://localhost:5173`, enter a name (dev login), and you get **1,000 free
coins**. Open a second browser/incognito window, log in as someone else, and hit
**Quick Match** at the same stake in both to play head-to-head.

Run the test suite:

```bash
npm test          # 20 tests: engine rules, provably-fair dice, full staked game
```

---

## How it works

```
client (React PWA)                         server (Node.js, authoritative)
─────────────────                          ──────────────────────────────
LudoBoard renders server state    ──ws──>  socket handlers (JWT-authed)
sends intents: roll / move        <─ws──   GameManager  (rooms, matchmaking,
wallet/profile via REST                    │              turn timers)
                                           ├─ LudoEngine  (ALL rules, validates
                                           │               every move)
                                           ├─ ProvablyFairDice (commit–reveal)
                                           └─ Wallet      (atomic coin ledger,
                                                           escrow + settlement)
```

### Project layout

```
server/src/
  game/
    constants.js     board geometry & rules (single source of truth)
    LudoEngine.js    pure, tested state machine — the heart of the system
    dice.js          provably-fair dice (commit–reveal, unbiased)
    GameManager.js   rooms, matchmaking, escrow→play→settle, turn watchdog
  wallet/Wallet.js   append-only coin ledger, atomic via a mutex
  auth/              JWT (access+refresh rotation), Google verify, accounts
  socket/handlers.js authenticated, validated real-time events
  http/routes.js     auth + wallet REST API
  middleware/        helmet, CORS allow-list, rate limits, auth guard
client/src/
  game/coords.js     maps engine positions → 15×15 board pixels
  components/         LudoBoard, Dice, Lobby, Game, GameOver, Login
  store/             auth + game state (zustand)
  api/               socket.io client + REST wrapper
```

---

## 🔒 Security model

This was built to your requirement — *"no one should be able to hack this."*
Here is exactly what protects each layer.

| Threat | Mitigation (in this codebase) |
|---|---|
| **Cheating with a hacked client** (fake dice, illegal moves) | Server-authoritative `LudoEngine`. Every roll/move is re-validated server-side against a freshly-computed legal-move list. The client cannot express an illegal state. |
| **Rigged dice / distrust** | `ProvablyFairDice`: server commits to a hashed seed *before* play, reveals it at the end. Anyone can recompute every roll and verify nothing was changed. Rolls use unbiased rejection sampling over HMAC-SHA256. |
| **Stealing coins / double-spend** | `Wallet` is an append-only ledger; all mutations run through a mutex so two requests can't race. Game stakes are escrowed **all-or-nothing**; the pot pays out exactly once. Coins are integers — no float rounding. |
| **Playing out of turn / spoofing identity** | Every socket is authenticated by JWT at the handshake; the player id comes from the verified token, never from the message body. |
| **Token theft** | Short-lived access tokens (15 min) + rotating, revocable refresh tokens. |
| **Brute force / abuse** | Rate limits (tight on auth), Helmet security headers, strict CORS allow-list, small request-body cap. |
| **One player freezing a staked game** | Per-turn timeout watchdog auto-skips; a persistently idle table is aborted and **all stakes refunded**. |
| **Disputes** | Every game keeps a full append-only move history + the fairness reveal, recorded server-side for replay. |

**Nothing is 100% un-hackable** — but this is the same architecture real-money
skill-gaming platforms use. The remaining risks (collusion between friends, bot
*assistance* on the player's own turn) are detection/monitoring problems, not
architecture flaws, and the move-history log is the foundation for that.

---

## 💰 From coins to real money (your phased plan)

The money path is already abstracted behind `Wallet`. To go live later:

1. **Now (coins phase):** gather users with free coins + Google login. Top up
   coins manually via your CRM (the wallet's `credit()` is one call).
2. **Deposits/withdrawals:** add a payment provider that only ever calls
   `wallet.credit` (on a verified deposit webhook) and `wallet.debit` (on an
   approved withdrawal). In-game bets stay internal = zero per-game fees.
3. **Before real money:** swap the in-memory `MemoryStore`/`Wallet` for a
   transactional database (Postgres) — the interfaces are already DB-shaped —
   add KYC + withdrawal 2FA, and **get legal advice** (skill-gaming rules vary
   by Indian state; geo-block where required).

---

## Configuration

All server config is in `server/.env` (see `server/.env.example`). Key values:

- `RAKE_BIPS` — platform fee in basis points (default `500` = 5%).
- `SIGNUP_BONUS_COINS`, `DAILY_BONUS_COINS` — onboarding economy.
- `TURN_TIMEOUT_MS` — how long before an idle turn is auto-skipped.
- `GOOGLE_CLIENT_ID` — enable real Google Sign-In (client needs the same value
  as `VITE_GOOGLE_CLIENT_ID`).
- `ALLOW_DEV_LOGIN` — passwordless login for local testing; **must be off in
  production** (it is force-disabled when `NODE_ENV=production`).
```
