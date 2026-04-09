# rebuttal.io

A real-time collaborative rebuttal assistant for ML conference paper reviews (NeurIPS, ICML, ICLR, KDD, etc.).

Multiple co-authors can edit the same rebuttal simultaneously — changes sync live across all connected users, like Google Docs.

---

## Features

- **Real-time collaboration** — field-level sync via Socket.io; see who else is online
- **Per-reviewer editor** — track each reviewer's concerns, your responses, and status
- **Version history** — manual snapshots you can preview and restore
- **Share links** — invite collaborators via a 7-day invite URL
- **Auth** — Clerk-based sign-in (email, Google, GitHub, etc.)
- **Export** — copy formatted rebuttal text to clipboard

---

## Self-hosting (recommended)

Each person hosts their own instance. No shared server, no shared accounts.

### Prerequisites

- A VPS with Docker installed (e.g. DigitalOcean, Hetzner, Fly.io)
- A domain pointed at your server's IP
- A free [Clerk](https://clerk.com) account for authentication

### 1. Point your domain to the server

In your DNS settings, add an A record:

| Type | Name | Value |
|------|------|-------|
| A | `@` | your server's IP address |

### 2. Clone and configure

```bash
git clone https://github.com/AbnerTeng/rebuttal.io.git
cd rebuttal.io
cp .env.example .env
nano .env
```

Fill in your Clerk keys and domain:

```dotenv
CLERK_PUBLISHABLE_KEY=pk_live_...
CLERK_SECRET_KEY=sk_live_...
SKIP_AUTH=false
DB_PATH=/data/rebuttals.db
```

> **Getting Clerk keys:** [dashboard.clerk.com](https://dashboard.clerk.com) → create an app → **API Keys**.
> Also add your domain to **Allowed Origins** and set **Home URL** to `https://yourdomain.com`.

### 3. Set your domain in Caddyfile

```bash
nano Caddyfile
```

Replace `your-domain.com` with your actual domain. That's the only line you need to change.

### 4. Open firewall ports (one time)

```bash
sudo ufw allow 22 && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw enable
```

### 5. Deploy

```bash
docker compose up -d
```

Caddy automatically obtains and renews an HTTPS certificate. Your app is live at `https://yourdomain.com`.

### Updating

```bash
git pull
docker compose up -d --build
```

---

## Local development (no auth)

```bash
git clone https://github.com/AbnerTeng/rebuttal.io.git
cd rebuttal.io
npm install
cp .env.example .env   # SKIP_AUTH=false by default, set to true for local dev
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Architecture

```
Browser
  │
  ├─ HTTPS (443) ──► Caddy ──► Node.js (3000)
  │                                  │
  └─ WebSocket (wss://) ─────────────┘
                                     │
                                SQLite DB
                                (/data/rebuttals.db)
```

| Layer | Technology |
|-------|------------|
| Backend | Node.js, Express, TypeScript |
| Real-time | Socket.io (WebSocket) |
| Database | SQLite via better-sqlite3 |
| Auth | Clerk |
| Proxy + HTTPS | Caddy (auto cert) |
| Process manager | Docker |

---

## Project structure

```
.
├── src/
│   ├── server.ts      # Express + Socket.io server
│   └── types.ts       # Shared TypeScript types
├── public/
│   └── index.html     # Single-page frontend
├── Dockerfile
├── docker-compose.yml
├── Caddyfile
├── .env.example
├── tsconfig.json
└── package.json
```

---

## License

MIT
