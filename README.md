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

- A machine with Docker installed and a publicly routable IP
- A free [Clerk](https://clerk.com) account for authentication

### 1. Clone and configure

```bash
git clone https://github.com/AbnerTeng/rebuttal.io.git
cd rebuttal.io
cp .env.example .env
nano .env
```

Fill in your Clerk keys:

```dotenv
CLERK_PUBLISHABLE_KEY=pk_live_...
CLERK_SECRET_KEY=sk_live_...
SKIP_AUTH=false
DB_PATH=/data/rebuttals.db
```

> **Getting Clerk keys:** [dashboard.clerk.com](https://dashboard.clerk.com) → create an app → **API Keys**.
> Also add your host to **Allowed Origins** (e.g. `http://140.112.29.237:8886`) and set **Home URL** accordingly.

### 2. Open firewall port (one time)

```bash
sudo ufw allow 8886 && sudo ufw enable
```

### 3. Deploy

```bash
docker compose up -d
```

Your app is live at `http://<your-ip>:8886`.

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
cp .env.example .env   # set SKIP_AUTH=true for local dev
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Architecture

```
Browser
  │
  ├─ HTTP (8886) ──► Node.js (3000)
  │                       │
  └─ WebSocket ───────────┘
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
├── .env.example
├── tsconfig.json
└── package.json
```

---

## License

MIT
