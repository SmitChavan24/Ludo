# Deploying CoinLudo

In production the **Node server serves everything** — the REST API, the
WebSocket game traffic, and the built React client — all from one origin. So a
deployment is just **two containers**: the app and MySQL. No nginx, no CORS
juggling required for the default same-origin setup.

## 1. One-command run (Docker Compose)

Create a `.env` file in the repo root (Compose reads it automatically):

```ini
# Strong random secrets — generate with:
#   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
JWT_ACCESS_SECRET=...
JWT_REFRESH_SECRET=...

# Database passwords
DB_PASSWORD=a-strong-db-password
DB_ROOT_PASSWORD=a-strong-root-password

# Admin / CRM (see the main README)
ADMIN_API_KEY=...
ADMIN_USERNAME=admin
ADMIN_PASSWORD=a-strong-admin-password

# Google Sign-In (see step 3). Leave blank to launch with dev login only.
GOOGLE_CLIENT_ID=

# Your public origin (used for socket CORS). For local testing this is fine:
CLIENT_ORIGINS=http://localhost:4000
```

Then:

```bash
docker compose up -d --build
```

Open **http://localhost:4000**. The app auto-creates its MySQL tables on first
start and keeps data in the `db-data` volume across restarts.

> To allow the passwordless dev login in a staging environment, set
> `ALLOW_DEV_LOGIN=true` **and** `NODE_ENV` is not `production`. In production it
> is force-disabled — use Google Sign-In.

## 2. Without Docker (manual)

```bash
npm install
npm --workspace client run build        # outputs client/dist
cp server/.env.example server/.env       # then fill in real values:
#   NODE_ENV=production, DB_DRIVER=mysql, DB_* , JWT_* , SERVE_CLIENT=true
npm --workspace server run start         # serves API + sockets + client on :4000
```

You need a reachable MySQL and a `coinludo` database + user (see the README's
Persistence section).

## 3. Google Sign-In

1. Google Cloud Console → **APIs & Services → Credentials → OAuth 2.0 Client ID
   (Web application)**.
2. Add your origin to **Authorized JavaScript origins** (e.g.
   `https://play.yourdomain.com`).
3. Put the client id in the root `.env` as `GOOGLE_CLIENT_ID`. The **same value**
   is baked into the client at build time via `VITE_GOOGLE_CLIENT_ID` — set it
   before `docker compose build` (or the manual `client` build) if you want the
   Google button to render:

   ```bash
   VITE_GOOGLE_CLIENT_ID=<same-id> docker compose up -d --build
   ```

## 4. Going live (HTTPS + domain)

- Put a TLS-terminating reverse proxy (Caddy, nginx, or your cloud LB) in front
  of the app on port 4000. WebSockets must be allowed to upgrade.
- Set `CLIENT_ORIGINS=https://yourdomain.com`.
- Use strong, unique `JWT_*`, `ADMIN_*`, and DB secrets.
- Back up the `db-data` volume (or use a managed MySQL).

Example Caddyfile (automatic HTTPS):

```
play.yourdomain.com {
    reverse_proxy localhost:4000
}
```

## Health & smoke check

```bash
curl https://yourdomain.com/api/health        # {"ok":true,...}
```

Everything else (rules, wallet, matchmaking, admin, history/leaderboard) is
covered by `npm test` (41 tests) and documented in the [README](README.md).
