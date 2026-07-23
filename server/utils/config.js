/* =========================================================
   NOOKAA — Configuration
   server/utils/config.js

   Single source of truth for every environment variable.
   Nothing else in the codebase reads process.env directly, so
   a missing or malformed setting fails loudly here at boot
   instead of quietly at 3am on a visitor's first submit.
   ========================================================= */

'use strict';

const path = require('path');

const ROOT_DIR = path.join(__dirname, '..', '..');

/* ---------------------------------------------------------
   Small parsers
   --------------------------------------------------------- */

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function int(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function list(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The service-account private key can arrive two ways:
 *   GOOGLE_PRIVATE_KEY            — PEM with literal \n escapes (Render, Railway)
 *   GOOGLE_CREDENTIALS_BASE64     — the whole downloaded JSON key, base64 encoded
 *                                   (safer: one opaque blob, no newline mangling)
 * Never a file path checked into the repo.
 */
function readGoogleCredentials() {
  const b64 = process.env.GOOGLE_CREDENTIALS_BASE64;

  if (b64) {
    let parsed;
    try {
      parsed = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    } catch {
      throw new Error('GOOGLE_CREDENTIALS_BASE64 is not valid base64-encoded JSON.');
    }
    return {
      clientEmail: parsed.client_email || '',
      privateKey: parsed.private_key || '',
    };
  }

  return {
    clientEmail: (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '').trim(),
    // .env files store PEM newlines as the two characters \ and n.
    privateKey: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim(),
  };
}

/* ---------------------------------------------------------
   Build the config object
   --------------------------------------------------------- */

const nodeEnv = (process.env.NODE_ENV || 'development').trim();
const isProduction = nodeEnv === 'production';

const google = readGoogleCredentials();

const config = Object.freeze({
  nodeEnv,
  isProduction,
  rootDir: ROOT_DIR,
  publicDir: path.join(ROOT_DIR, 'public'),

  port: int(process.env.PORT, 3000, { min: 1, max: 65535 }),

  // How many reverse proxies sit in front of this app.
  // 0 = none. Setting this higher than reality lets a client spoof
  // X-Forwarded-For and walk straight past the rate limiter, so the
  // default is the safe one and the operator must opt in.
  trustProxyHops: int(process.env.TRUST_PROXY_HOPS, 0, { min: 0, max: 10 }),

  // Redirect http -> https when running behind a TLS-terminating proxy.
  forceHttps: bool(process.env.FORCE_HTTPS, isProduction),

  // Empty list = same-origin only. Cross-origin browsers get no CORS
  // headers at all, which is what we want for a first-party landing page.
  allowedOrigins: list(process.env.ALLOWED_ORIGINS),

  google: {
    sheetId: (process.env.GOOGLE_SHEET_ID || '').trim(),
    sheetName: (process.env.GOOGLE_SHEET_NAME || 'Waitlist').trim(),
    clientEmail: google.clientEmail,
    privateKey: google.privateKey,
    // Seconds an API call may take before we give up and return a clean error.
    timeoutMs: int(process.env.GOOGLE_TIMEOUT_MS, 10000, { min: 1000, max: 60000 }),
  },

  // Pepper for the in-memory duplicate index. See services/googleSheets.js —
  // the app hashes every address so the plaintext list is never held in
  // process memory or written to a log.
  emailHashSecret: (process.env.EMAIL_HASH_SECRET || '').trim(),

  rateLimit: {
    windowMs: int(process.env.RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000, { min: 1000 }),
    max: int(process.env.RATE_LIMIT_MAX, 5, { min: 1, max: 1000 }),
    globalWindowMs: int(process.env.GLOBAL_RATE_LIMIT_WINDOW_MS, 60 * 1000, { min: 1000 }),
    globalMax: int(process.env.GLOBAL_RATE_LIMIT_MAX, 300, { min: 10, max: 100000 }),
  },

  // Every POST /api/waitlist response is padded to this duration so that a
  // duplicate address (fast, no write) is indistinguishable from a new one
  // (slow, one Sheets round-trip). Closes the timing side channel.
  responseFloorMs: int(process.env.RESPONSE_FLOOR_MS, 700, { min: 0, max: 5000 }),

  // Returning "Already Joined" tells any caller whether a given address is on
  // the list, turning this endpoint into a free lookup service. Off by default.
  revealDuplicates: bool(process.env.REVEAL_DUPLICATES, false),

  // The public signup counter leaks the size of the list. Off unless asked for.
  publicCount: {
    enabled: bool(process.env.PUBLIC_COUNT_ENABLED, false),
    base: int(process.env.WAITLIST_DISPLAY_BASE, 0),
    cacheTtlMs: int(process.env.PUBLIC_COUNT_TTL_MS, 5 * 60 * 1000, { min: 10000 }),
  },

  fallback: {
    // A local plaintext spool is a second copy of personal data. Allowed in
    // development so the form works without Google credentials; in production
    // it must be switched on deliberately.
    enabled: bool(process.env.FALLBACK_STORE_ENABLED, !isProduction),
    path: process.env.FALLBACK_STORE_PATH
      ? path.resolve(ROOT_DIR, process.env.FALLBACK_STORE_PATH)
      : path.join(ROOT_DIR, 'data', 'waitlist.jsonl'),
  },
});

/* ---------------------------------------------------------
   Boot-time validation
   --------------------------------------------------------- */

/**
 * @returns {string[]} fatal problems (empty array means good to go)
 */
function validate() {
  const errors = [];
  const { google: g } = config;

  const hasGoogle = Boolean(g.sheetId && g.clientEmail && g.privateKey);

  if (config.isProduction) {
    if (!hasGoogle) {
      errors.push(
        'Google Sheets is not configured. In production set GOOGLE_SHEET_ID plus ' +
          'either GOOGLE_CREDENTIALS_BASE64 or GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY.'
      );
    }
    if (!config.emailHashSecret || config.emailHashSecret.length < 32) {
      errors.push(
        'EMAIL_HASH_SECRET must be set to at least 32 random characters in production. ' +
          'Generate one with:  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
      );
    }
  }

  if (g.privateKey && !g.privateKey.includes('BEGIN PRIVATE KEY')) {
    errors.push(
      'GOOGLE_PRIVATE_KEY does not look like a PEM key. Keep the whole value in ' +
        'double quotes, including the -----BEGIN/END PRIVATE KEY----- lines.'
    );
  }

  if (g.sheetId && !/^[A-Za-z0-9_-]{20,}$/.test(g.sheetId)) {
    errors.push('GOOGLE_SHEET_ID looks wrong. Use only the id from the sheet URL, not the whole URL.');
  }

  return errors;
}

function isGoogleConfigured() {
  const { sheetId, clientEmail, privateKey } = config.google;
  return Boolean(sheetId && clientEmail && privateKey);
}

module.exports = { config, validate, isGoogleConfigured };
