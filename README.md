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
npm test          # engine rules, provably-fair dice, full staked game, matchmaking, admin auth
```

### Persistence (MySQL)

By default the server uses an **in-memory** backend (great for a quick run, but
everything resets on restart). To persist users, coins, and game history, point
it at **MySQL**:

```sql
CREATE DATABASE coinludo CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'coinludo'@'%' IDENTIFIED BY 'your-strong-password';
GRANT ALL PRIVILEGES ON coinludo.* TO 'coinludo'@'%';
FLUSH PRIVILEGES;
```

Then in `server/.env`:

```ini
DB_DRIVER=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=coinludo
DB_PASSWORD=your-strong-password
DB_NAME=coinludo
```

Tables are created automatically on first start. The storage layer is behind a
driver (`db/MemoryStore` ↔ `db/MysqlStore`, `wallet/MemoryWallet` ↔
`wallet/MysqlWallet`), selected by `DB_DRIVER` — so the test suite stays on the
fast in-memory backend while production runs on MySQL. **Coin operations use
real DB transactions + row locks** (`SELECT … FOR UPDATE`), so escrow and
settlement are atomic even across multiple server instances.

### Game history & leaderboard

Every finished game writes one row per player to `game_players`, powering:

- `GET /api/me/games` — the signed-in player's recent games (opponents, stake,
  win/loss, net coins), newest first.
- `GET /api/leaderboard?period=all|week` — top players ranked by **net coins
  won**, with win/games counts.

In the app, the lobby's **🏆 Leaderboard** and **📜 My Games** buttons open these
views. (Both work on the in-memory backend too, so they show up in dev.)

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
3. **Before real money:** run on **MySQL** (done — set `DB_DRIVER=mysql`), add
   KYC + withdrawal 2FA, and **get legal advice** (skill-gaming rules vary by
   Indian state; geo-block where required).

---

## Practice mode (free play, no account)

The first screen offers **▶ Practice Match** — no sign-in, no name to type, no
coins. It's the answer to the cold-start problem: a brand-new visitor can always
play something immediately.

How a practice game finds an opponent:

1. Look for another practice player already waiting → pair them (real humans are
   always preferred).
2. If nobody arrives within `PRACTICE_BOT_WAIT_MS` (default **20s**), a **bot**
   sits down and the game starts.

Practice games are completely walled off from the economy: stake 0, **no escrow,
no payout, no rake, no ledger entries, no stats, no leaderboard, no game history**
(there's a test asserting exactly this). Players are shown anonymously as
*You* / *Computer* — no names anywhere.

Guests get a short-lived token carrying a `guest` scope. That scope is what
blocks them from anything involving coins — staked games are refused server-side
with `GUEST_FORBIDDEN`, and the wallet/referral/history endpoints reject them via
`requireAccount`. Signing in with Google is what unlocks coins, stats and invites,
and the end-of-game screen nudges toward it.

The bot ([`game/bot.js`](server/src/game/bot.js)) plays through the **same
authoritative engine** as a human — it only picks among the legal moves the
engine already generated, so it cannot cheat. It's a heuristic (prefers captures,
finishing, getting tokens out, safe squares, escaping threats) with a
deliberately human-ish pause, tuned to be good but beatable.

## Growth: matchmaking liquidity, referrals, sharing

**The most important launch setting is `STAKES` / `PLAYER_COUNTS`.** Every extra
combination creates another matchmaking queue — 4 stakes × 3 table sizes is *12
separate pools*. With a handful of players online, a split pool means nobody ever
gets matched, and they leave thinking the game is dead. Ship with **one stake and
one table size** (the defaults: `STAKES=50`, `PLAYER_COUNTS=2`) and widen only as
concurrent players grow. The lobby hides the pickers entirely when there's one
option, and the server **rejects** any off-menu stake, so it can't be bypassed.

`GET /api/config` serves these to the client, so you can widen or throttle the
lobby by changing `.env` and restarting — no client rebuild.

**Referrals** (`REFERRAL_BONUS_COINS`, default 500 to *each* side): every account
gets a short code (ambiguous characters like `0/O/1/I/L` excluded so it survives
being retyped from a chat). Invite links look like `https://yourdomain/?ref=ABC123`;
the code is remembered until the visitor actually signs up, and pays out **only on
a genuinely new account**, so it can't be farmed by logging in again.

**Sharing** is WhatsApp-first (the share sheet on mobile, a `wa.me` link on
desktop, clipboard as last resort). The game-over screen has a "Share your win"
button that carries the winner's referral link — a brag doubles as an invite.
For link previews to render, set **`VITE_PUBLIC_URL`** to your real domain before
building; the OG tags and `public/og-image.png` do the rest.

## Admin / CRM coin top-ups

Players join random matches (2/3/4 players) via **Quick Match** — no code needed.
Codes only exist for the optional **private friend rooms**.

There are two ways to top up coins. Each player's **Player ID** is shown in their
lobby (tap to copy) — that's the `userId` you credit.

### Admin web page (for a human)

Open **http://localhost:4000/admin** and sign in with `ADMIN_USERNAME` /
`ADMIN_PASSWORD`. Login issues a short-lived **admin JWT** (kept in the tab only)
that authorizes every action — look up a player by ID, see their balance + ledger,
and credit/debit coins. A normal player's token can never reach these endpoints
(the admin JWT carries a separate `admin` scope). Set `ADMIN_PASSWORD` to enable it.

### Admin API (for your CRM, server-to-server)

Call the API directly, gated by the `x-admin-key` header = your `ADMIN_API_KEY`.

```bash
# Confirm the account + see balance/ledger before crediting
curl http://localhost:4000/api/admin/users/<userId> \
  -H "x-admin-key: $ADMIN_API_KEY"

# Credit coins (e.g. after a ₹99 UPI payment → 8,000 coins)
curl -X POST http://localhost:4000/api/admin/credit \
  -H "x-admin-key: $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"userId":"<userId>","amount":8000,"reason":"upi-ref-12345"}'

# Debit (corrections / manual refunds)
curl -X POST http://localhost:4000/api/admin/debit \
  -H "x-admin-key: $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"userId":"<userId>","amount":500,"reason":"correction"}'
```

Every top-up flows through the same audited coin ledger. Keep `ADMIN_API_KEY`
secret and, in production, also restrict these endpoints by IP / private network.

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
