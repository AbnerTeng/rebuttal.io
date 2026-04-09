# rebuttal.io

A real-time collaborative rebuttal assistant for ML conference paper reviews (NeurIPS, ICML, ICLR, KDD, etc.).

Multiple co-authors can edit the same rebuttal simultaneously — changes sync live across all connected users, like Google Docs.

---

## Features

- **Real-time collaboration** — field-level sync via Socket.io; see who else is online
- **Per-reviewer editor** — track each reviewer's concerns, your responses, and status
- **Version history** — manual snapshots you can preview and restore
- **Share links** — invite collaborators via a 7-day invite URL
- **Auth** — username/password sign-in with bcrypt + JWT session cookies
- **Export** — copy formatted rebuttal text to clipboard

---

## Self-hosting (recommended)

Each person hosts their own instance. No shared server, no shared accounts.

### Prerequisites

- A machine with Docker installed and a publicly routable IP

### 1. Clone and configure

```bash
git clone https://github.com/AbnerTeng/rebuttal.io.git
cd rebuttal.io
cp .env.example .env
vim .env
```

Set a random secret for signing session tokens:

```dotenv
# Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
JWT_SECRET=your_random_secret_here
SKIP_AUTH=false
PORT=3000
DB_PATH=/data/rebuttals.db
```

### 2. Open firewall port (one time)

```bash
sudo ufw allow 8886 && sudo ufw enable
```

### 3. Revise docker compose file

```yml
services:
  app:
    build: .
    restart: unless-stopped
    env_file: .env
    volumes:
      - ./data:/data
    ports:
      - "<your-port>:3000"
```

### 4. Deploy

```bash
docker compose up -d --build
```

Your app is live at `http://<your-ip>:<your-port>`.

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
cp .env.example .env   # set SKIP_AUTH=true and JWT_SECRET to any value
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Architecture

```
Browser
  │
  ├─ HTTP (<your-port>) ──► Node.js (3000)
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
| Auth | Custom (bcrypt + JWT session cookies) |
| Process manager | Docker |


---

## License

MIT
