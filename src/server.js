'use strict';

const path    = require('path');
const express = require('express');
const helmet  = require('helmet');
const cors    = require('cors');
const morgan  = require('morgan');
const rateLimit = require('express-rate-limit');

const { setDb } = require('./db/connection');
const { initDb: openDb } = require('./db/init');
const { autoSeedIfEmpty } = require('./db/seed');
const routes        = require('./routes');
const { startScheduler } = require('./services/scheduler');

const app  = express();
const PORT = process.env.PORT || 8080;
const ENV  = process.env.NODE_ENV || 'development';

// Railway (and most PaaS) put the app behind a single reverse proxy. Trusting
// one hop lets express-rate-limit and req.ip see the real client IP instead of
// the proxy's — without it every user would share one IP and be rate-limited
// together.
app.set('trust proxy', 1);
// Query strings are parsed simply (no nested objects/arrays): nothing in the app needs more,
// and it closes the known "qs" denial-of-service holes.
app.set('query parser', 'simple');

// A crash-proof server must survive stray async errors instead of exiting.
// Log loudly and keep serving; a single bad request should never take the
// whole process down.
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err && err.stack ? err.stack : err);
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'self'"],
      scriptSrc:     ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc:      ["'self'", "'unsafe-inline'"],
      imgSrc:        ["'self'", 'data:', 'blob:'],
      connectSrc:    ["'self'"],
    },
  },
}));

// The app and its API are on the same site, so other websites get no CORS access.
// (To allow a separate front-end later, set CORS_ORIGINS=https://a.com,https://b.com)
const corsOrigins = String(process.env.CORS_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean);
app.use(cors({ origin: corsOrigins.length ? corsOrigins : false }));
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), payment=()');
  next();
});
app.use(express.json({ limit: '3mb' })); // ID photos arrive as base64 (max 1.5 MB file)
app.use(morgan(ENV === 'production' ? 'combined' : 'dev'));

// Brute-force protection on credential endpoints: 40 attempts / 15 min / IP (all staff on one
// Wi-Fi share an IP). Each account is also locked for 15 minutes after 5 wrong tries.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again in a few minutes.' },
});
app.use('/api/v1/auth/login',           authLimiter);
app.use('/api/v1/auth/register',        authLimiter);
app.use('/api/v1/auth/forgot-password', authLimiter);
app.use('/api/v1/auth/reset-password',  authLimiter);
app.use('/api/v1/auth/staff',           authLimiter);   // login code + MPIN set up
app.use('/api/v1/auth/change-password', authLimiter);
app.use('/api/v1/auth/change-mpin',     authLimiter);

// Whole API: a very high ceiling that normal use never reaches (a whole hostel on one Wi-Fi
// shares one IP), but stops a runaway script from flooding the server.
app.use('/api/', rateLimit({
  windowMs: 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a minute.' },
}));

// Guest bill links (no sign-in): limited so links can't be guessed by brute force.
const share = require('./controllers/shareController');
app.get('/b/:token', rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: 'Too many requests. Please wait a minute.' }), share.viewBill);

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api/v1', routes);
// Unknown API paths answer JSON 404 (not the app's HTML page).
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((err, req, res, _next) => {
  // A malformed JSON body is a client error, not a server fault — answer 400,
  // not 500, and don't log it as an internal error.
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError) && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON in request body' });
  }
  // Oversized body → 413 rather than a generic 500.
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large' });
  }
  // Business-rule errors from the money ledger (day closed, refund > deposit,
  // duplicate payment, ...) are the user's to fix — answer 4xx with the reason.
  if (err && err.isLedgerError) {
    if (res.headersSent) return;
    return res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
  if (err && err.code === 'SQLITE_BUSY') {
    if (res.headersSent) return;
    return res.status(503).json({ error: 'Server busy — please retry' });
  }
  console.error('[ERROR]', err.message, err.stack);
  if (res.headersSent) return;   // response already streaming (e.g. PDF export)
  res.status(500).json({ error: 'Internal server error' });
});

// Refuse to start in production without the secrets the app cannot work without.
// A clear boot error in Railway logs beats a running app where every login fails.
function checkRequiredEnv() {
  if (ENV !== 'production') return;
  const problems = [];
  const jwt = process.env.JWT_SECRET;
  if (!jwt || jwt.startsWith('CHANGE_ME') || jwt.length < 32) problems.push('JWT_SECRET missing or shorter than 32 characters');
  const aes = process.env.AES_256_KEY;
  if (!aes || !/^[0-9a-fA-F]{64}$/.test(aes)) problems.push('AES_256_KEY must be exactly 64 hex characters (openssl rand -hex 32)');
  // On Railway the container disk is wiped on every deploy/restart. Without a
  // volume mounted at DB_DIR, all accounts and data vanish and every open
  // browser gets "User not found or deactivated". Refuse to run like that.
  const onRailway = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID);
  if (onRailway && process.env.ALLOW_EPHEMERAL_DB !== 'true') {
    const dbDir = path.resolve(process.env.DB_DIR || '/data');
    const mount = process.env.RAILWAY_VOLUME_MOUNT_PATH ? path.resolve(process.env.RAILWAY_VOLUME_MOUNT_PATH) : '';
    if (!mount) {
      problems.push(`No volume attached. In Railway: service → Settings → Volumes → add a volume with mount path ${dbDir}`);
    } else if (dbDir !== mount && !dbDir.startsWith(mount + path.sep)) {
      problems.push(`DB_DIR (${dbDir}) is not inside the volume mount (${mount}). Set DB_DIR=${mount}`);
    }
  }
  if (problems.length) {
    console.error('[BOOT ERROR] Fix these Railway settings, then redeploy:\n  - ' + problems.join('\n  - '));
    process.exit(1);
  }
  const mobile = (process.env.SUPERADMIN_MOBILE || '').replace(/\D/g, '');
  if (process.env.SUPERADMIN_MOBILE && mobile.length !== 10) {
    console.warn(`[BOOT WARNING] SUPERADMIN_MOBILE should be a 10-digit mobile number (got ${mobile.length} digits)`);
  }
}

(async () => {
  try {
    checkRequiredEnv();
    const db = openDb();
    setDb(db);
    autoSeedIfEmpty(db);
    startScheduler();
    app.listen(PORT, () => {
      console.log(`[SERVER] DormBook v4.0 on port ${PORT} (${ENV})`);
    });
  } catch (err) {
    console.error('[BOOT ERROR]', err.message, err.stack);
    process.exit(1);
  }
})();
