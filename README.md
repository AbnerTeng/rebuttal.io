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

## Prerequisites

- **Node.js** v18 or later
- **npm** v9 or later
- A **Clerk** account for authentication (free at [clerk.com](https://clerk.com)) — or skip auth entirely for local/private use

---

## Quick start (local, no auth)

```bash
git clone https://github.com/AbnerTeng/rebuttal.io.git
cd rebuttal.io
npm install
cp .env.example .env
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

`.env.example` ships with `SKIP_AUTH=true`, so no Clerk setup is needed for local development.

---

## Environment variables

Copy `.env.example` to `.env` and fill in the values:

```dotenv
# Set to true for local dev — bypasses all authentication
SKIP_AUTH=true

# Required when SKIP_AUTH=false
# Get these from https://dashboard.clerk.com → your app → API Keys
CLERK_SECRET_KEY=sk_test_replace_me
CLERK_PUBLISHABLE_KEY=pk_test_replace_me

# Port the server listens on (default: 3000)
PORT=3000

# Path to the SQLite database file (default: ./rebuttals.db)
# DB_PATH=/data/rebuttals.db
```

---

## Hosting on your own server

### 1. Clone and build

```bash
git clone https://github.com/AbnerTeng/rebuttal.io.git
cd rebuttal.io
npm install
cp .env.example .env
nano .env          # fill in your values (see below)
npm run build      # compiles TypeScript → dist/
```

### 2. Set up environment variables

Edit `.env`:

```dotenv
SKIP_AUTH=false
CLERK_SECRET_KEY=sk_live_...
CLERK_PUBLISHABLE_KEY=pk_live_...
PORT=3000
DB_PATH=/data/rebuttals.db    # recommended: store DB outside the repo
```

> **Getting Clerk keys:** Go to [dashboard.clerk.com](https://dashboard.clerk.com) → create an app → **API Keys**. Copy the Secret Key and Publishable Key.
>
> In your Clerk dashboard, also add your domain to **Allowed Origins** and set the **Home URL** to `https://yourdomain.com`.

### 3. Install and configure Nginx

```bash
sudo apt install nginx certbot python3-certbot-nginx -y
sudo nano /etc/nginx/sites-available/rebuttal
```

Paste the following (replace `yourdomain.com`):

```nginx
server {
    listen 80;
    server_name yourdomain.com www.yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;

        # Required for WebSocket (Socket.io)
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/rebuttal /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 4. Get a free HTTPS certificate

```bash
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

Certbot auto-renews the certificate. Your site is now available at `https://yourdomain.com`.

### 5. Keep the app running with PM2

Without a process manager, the app stops when you close the terminal.

```bash
npm install -g pm2
pm2 start dist/server.js --name rebuttal
pm2 save                  # persist across restarts
pm2 startup               # follow the printed command to enable auto-start on reboot
```

Useful PM2 commands:

```bash
pm2 logs rebuttal         # view live logs
pm2 restart rebuttal      # restart after a config change
pm2 stop rebuttal         # stop the app
```

### 6. Point your domain to the server

In your domain registrar's DNS settings, add:

| Type | Name | Value |
|------|------|-------|
| A | `@` | your server's IP address |
| A | `www` | your server's IP address |

DNS changes can take up to 30 minutes to propagate. Verify with:

```bash
dig yourdomain.com +short
```

### 7. Open firewall ports

```bash
sudo ufw allow 22     # SSH — do this first
sudo ufw allow 80
sudo ufw allow 443
sudo ufw enable
```

---

## Updating to a new version

```bash
cd rebuttal.io
git pull
npm install
npm run build
pm2 restart rebuttal
```

---

## Architecture overview

```
Browser
  │
  ├─ HTTPS (port 443) ──► Nginx ──► Node.js (port 3000)
  │                                      │
  └─ WebSocket (wss://) ─────────────────┘
                                         │
                                    SQLite DB
                                    (rebuttals.db)
```

| Layer | Technology |
|-------|------------|
| Backend | Node.js, Express, TypeScript |
| Real-time | Socket.io (WebSocket) |
| Database | SQLite via better-sqlite3 |
| Auth | Clerk |
| Proxy | Nginx + Let's Encrypt |
| Process manager | PM2 |

---

## Project structure

```
.
├── src/
│   ├── server.ts      # Express + Socket.io server
│   └── types.ts       # Shared TypeScript types
├── public/
│   └── index.html     # Single-page frontend
├── .env.example       # Environment variable template
├── tsconfig.json
└── package.json
```

---

## License

MIT
