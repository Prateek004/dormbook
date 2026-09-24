# DormBook v2 — Railway Deployment Guide

## Deploy to Railway in 5 minutes

### Step 1 — Push to GitHub
```bash
git init && git add . && git commit -m "DormBook v2"
git remote add origin https://github.com/YOUR_USER/dormbook.git
git push -u origin main
```

### Step 2 — Create Railway service
1. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
2. Select your repo — Railway auto-detects nixpacks and deploys

### Step 3 — Add a Volume (CRITICAL for persistent data)
Without a volume, the SQLite database resets on every redeploy.

1. Railway Dashboard → your service → **Volumes** tab
2. Click **Add Volume** → Mount Path: `/data`
3. Redeploy the service

### Step 4 — Set environment variables
Railway Dashboard → your service → **Variables** tab. Add:

| Variable | Value | How to generate |
|---|---|---|
| `NODE_ENV` | `production` | — |
| `JWT_SECRET` | _(random)_ | `openssl rand -base64 48` |
| `AES_256_KEY` | _(random 64-char hex)_ | `openssl rand -hex 32` |
| `SEED_OWNER_EMAIL` | `owner@yourpg.in` | Your email |
| `SEED_OWNER_PASSWORD` | _(strong password)_ | — |
| `SEED_OWNER_MOBILE` | `9876543210` | Your mobile |
| `SEED_PROPERTY_NAME` | `My PG Name` | — |
| `CRON_SECRET` | _(random)_ | `openssl rand -hex 16` |

> Railway injects `PORT` automatically — **do not set it manually**.

### Step 5 — First login
After deploy (takes ~2 min for first build):
- Open your Railway URL (e.g. `https://dormbook-production.up.railway.app`)
- Login with the email/password you set in `SEED_OWNER_*` variables
- **Change the password immediately** (Profile → Change Password)

---

## What happens on first deploy

On startup, the app:
1. Creates the SQLite database at `/data/dormbook.db`
2. Runs all schema migrations (idempotent — safe to restart)
3. Detects empty database → auto-seeds one owner account + sample property + 4 beds
4. Starts the cron scheduler

No manual `npm run seed` needed on Railway.

---

## Local development

```bash
npm install
cp .env.example .env
# Edit .env — set JWT_SECRET and AES_256_KEY at minimum
npm run dev        # starts with --watch (auto-reload)
# App available at http://localhost:3000
```

---

## Role permissions

| Feature | Reception | Manager | Owner |
|---|:-:|:-:|:-:|
| Check In / Out | ✅ | ✅ | ✅ |
| Record Payments | ✅ | ✅ | ✅ |
| Approve Refunds | ❌ | ✅ | ✅ |
| View Reports | ❌ | ✅ | ✅ |
| Export Reports (Excel/PDF/CSV) | ❌ | ❌ | ✅ |
| View Audit Log | ❌ | ❌ | ✅ |
| Manage Staff | ❌ | ❌ | ✅ |
| Manage Add-on Catalog | ❌ | ❌ | ✅ |

---

## Troubleshooting

**Stuck on loading screen**
- Check Railway logs: service → **Deployments** → click latest → **View Logs**
- Look for `[SEED]` lines — first deploy seeds the DB (takes ~5s)
- Look for `[SERVER] DormBook v2.0 on port` — confirms successful startup
- If you see `JWT_SECRET is not configured` → add the env var and redeploy

**Login returns "Invalid email or password"**
- Verify `SEED_OWNER_EMAIL` and `SEED_OWNER_PASSWORD` match what you're typing
- If DB had no volume and was redeployed, data was wiped → re-seed by redeploying

**Data lost after redeploy**
- You don't have a Railway Volume attached — add one mounted at `/data`

**Build fails (better-sqlite3 native module)**
- nixpacks.toml includes the rebuild step automatically
- Ensure `python3`, `gcc`, `gnumake` are in the nixPkgs list (they are)

**WhatsApp messages not sending**
- Set `WHATSAPP_API_TOKEN` and `WHATSAPP_PROVIDER` in Railway Variables
- Without these, the app works normally — WhatsApp is non-blocking
