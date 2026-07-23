/* =========================================================
   NOOKAA — Waitlist storage
   server/services/googleSheets.js

   The only file in the project that talks to Google.

   Sheet layout (created automatically on first write):
     A  Timestamp   ISO-8601 UTC
     B  Email
     C  Source

   Two things worth knowing before editing this file:

   1. Duplicate detection never keeps a plaintext list in memory.
      Column B is read at most once per cache window, each address is
      immediately turned into a keyed HMAC, and the plaintext is dropped.
      A heap dump or a crash log therefore cannot yield the mailing list.

   2. Every value written is passed through neutralizeFormula(). Combined
      with valueInputOption:'RAW' that makes it impossible to land a live
      =IMPORTXML / =HYPERLINK payload in a cell, which would otherwise let
      an attacker exfiltrate the sheet the moment a colleague opens it.
   ========================================================= */

'use strict';

const fsp = require('fs/promises');
const path = require('path');
const { google } = require('googleapis');

const { config, isGoogleConfigured } = require('../utils/config');
const { logger } = require('../utils/logger');
const { HttpError } = require('../utils/httpError');
const { neutralizeFormula } = require('../utils/email');
const { hashEmail } = require('../utils/emailHash');

// Read/write on spreadsheets the service account can see. Google offers no
// append-only scope; containment comes from the account being able to see
// exactly one sheet, because that is the only one shared with it.
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

const HEADER_ROW = ['Timestamp', 'Email', 'Source'];
const COLUMN_RANGE = 'A:C';

const DUPLICATE_CACHE_TTL_MS = 60 * 1000;

/* ---------------------------------------------------------
   Google client — created once, reused
   --------------------------------------------------------- */

let sheetsClient = null;
let authClient = null;

async function getSheets() {
  if (sheetsClient) return sheetsClient;

  authClient = new google.auth.JWT({
    email: config.google.clientEmail,
    key: config.google.privateKey,
    scopes: SCOPES,
  });

  await authClient.authorize();
  sheetsClient = google.sheets({ version: 'v4', auth: authClient });
  return sheetsClient;
}

/** Shared request options — a hung Google call must not hang a visitor. */
function requestOptions() {
  return { timeout: config.google.timeoutMs };
}

/**
 * Turns a googleapis failure into something safe to hand a visitor.
 * The original is kept as `cause` for the logs only.
 *
 * @param {any} err
 * @returns {HttpError}
 */
function translateGoogleError(err) {
  const status = err?.response?.status || err?.code;
  const generic = 'We could not save your email right now. Please try again in a moment.';

  if (status === 401 || status === 403) {
    logger.error('Google rejected the service account — check the key and that the sheet is shared with it.', {
      status,
    });
    return new HttpError(503, generic, { code: 'store_auth', cause: err });
  }
  if (status === 404) {
    logger.error('Spreadsheet or tab not found. Check GOOGLE_SHEET_ID and GOOGLE_SHEET_NAME.', { status });
    return new HttpError(503, generic, { code: 'store_missing', cause: err });
  }
  // Google returns 400 "Unable to parse range" when GOOGLE_SHEET_NAME doesn't
  // match an existing tab — same root cause as the 404 above, different status.
  if (status === 400 && /unable to parse range/i.test(err?.response?.data?.error?.message || err?.message || '')) {
    logger.error(
      `Tab "${config.google.sheetName}" not found in the spreadsheet. Check that GOOGLE_SHEET_NAME matches the tab name exactly (case-sensitive).`,
      { status }
    );
    return new HttpError(503, generic, { code: 'store_bad_range', cause: err });
  }
  if (status === 429 || status === 503) {
    return new HttpError(503, generic, { code: 'store_busy', cause: err });
  }
  if (err?.code === 'ETIMEDOUT' || err?.code === 'ECONNRESET' || err?.code === 'ENOTFOUND') {
    return new HttpError(503, generic, { code: 'store_offline', cause: err });
  }

  return new HttpError(503, generic, { code: 'store_unknown', cause: err });
}

/* ---------------------------------------------------------
   Sheet tab resolution
   --------------------------------------------------------- */

// GOOGLE_SHEET_NAME is a guess at the tab's title, and operators reliably get
// it wrong (default "Waitlist" vs. whatever Google actually named the first
// tab, e.g. "Sheet1"). Rather than hard-failing every write until someone
// notices and fixes the env var, fall back to whatever tab actually exists.
let resolvedSheetName = null;

async function resolveSheetName() {
  if (resolvedSheetName) return resolvedSheetName;

  const sheets = await getSheets();
  const meta = await sheets.spreadsheets.get(
    { spreadsheetId: config.google.sheetId, fields: 'sheets.properties.title' },
    requestOptions()
  );

  const titles = (meta.data.sheets ?? []).map((s) => s.properties.title);

  if (titles.includes(config.google.sheetName)) {
    resolvedSheetName = config.google.sheetName;
    return resolvedSheetName;
  }

  if (titles.length === 0) {
    throw new HttpError(503, 'We could not save your email right now. Please try again in a moment.', {
      code: 'store_no_tabs',
    });
  }

  logger.warn(
    `GOOGLE_SHEET_NAME "${config.google.sheetName}" doesn't match any tab — using "${titles[0]}" instead. ` +
      `Present tabs: ${titles.join(', ')}. Set GOOGLE_SHEET_NAME to silence this.`
  );
  resolvedSheetName = titles[0];
  return resolvedSheetName;
}

/* ---------------------------------------------------------
   Header row
   --------------------------------------------------------- */

let headerChecked = false;

async function ensureHeaderRow() {
  if (headerChecked) return;

  const sheetName = await resolveSheetName();
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get(
    {
      spreadsheetId: config.google.sheetId,
      range: `${sheetName}!A1:C1`,
    },
    requestOptions()
  );

  const existing = res.data.values?.[0] ?? [];
  if (existing.length === 0) {
    await sheets.spreadsheets.values.update(
      {
        spreadsheetId: config.google.sheetId,
        range: `${sheetName}!A1:C1`,
        valueInputOption: 'RAW',
        requestBody: { values: [HEADER_ROW] },
      },
      requestOptions()
    );
    logger.info('Wrote header row to the waitlist sheet.');
  }

  headerChecked = true;
}

/* ---------------------------------------------------------
   Duplicate index — hashes only
   --------------------------------------------------------- */

let hashIndex = { set: null, fetchedAt: 0, inFlight: null };

async function fetchHashIndex() {
  const sheetName = await resolveSheetName();
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get(
    {
      spreadsheetId: config.google.sheetId,
      range: `${sheetName}!B2:B`,
    },
    requestOptions()
  );

  const set = new Set();
  const rows = res.data.values ?? [];

  for (const row of rows) {
    const value = String(row?.[0] ?? '').trim().toLowerCase();
    if (value) set.add(hashEmail(value));
  }

  // Drop every reference to the plaintext column before returning.
  rows.length = 0;
  if (res.data.values) res.data.values = undefined;

  return set;
}

/**
 * @returns {Promise<Set<string>>} HMACs of every address already on the list
 */
async function loadHashIndex() {
  const fresh = hashIndex.set && Date.now() - hashIndex.fetchedAt < DUPLICATE_CACHE_TTL_MS;
  if (fresh) return hashIndex.set;

  // Collapse concurrent refreshes into one API call.
  if (hashIndex.inFlight) return hashIndex.inFlight;

  hashIndex.inFlight = fetchHashIndex()
    .then((set) => {
      hashIndex = { set, fetchedAt: Date.now(), inFlight: null };
      return set;
    })
    .catch((err) => {
      hashIndex.inFlight = null;
      throw err;
    });

  return hashIndex.inFlight;
}

/* ---------------------------------------------------------
   Local fallback spool
   --------------------------------------------------------- */

const FILE_MODE = 0o600; // owner read/write only
const DIR_MODE = 0o700;

async function readFallbackHashes() {
  try {
    const raw = await fsp.readFile(config.fallback.path, 'utf8');
    const set = new Set();
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (entry?.emailHash) set.add(entry.emailHash);
      } catch {
        // A truncated final line is expected after a hard kill; skip it.
      }
    }
    return set;
  } catch (err) {
    if (err.code === 'ENOENT') return new Set();
    throw err;
  }
}

let permissionWarned = false;

/**
 * Confirms the spool really is owner-only. Some filesystems (FUSE mounts,
 * many container volume drivers, anything on Windows) silently ignore chmod,
 * which would leave a plaintext list of addresses readable by every process
 * on the box. Better to say so once, loudly, than to assume it worked.
 */
async function assertPrivateSpool() {
  if (permissionWarned) return;
  try {
    const stat = await fsp.stat(config.fallback.path);
    const mode = stat.mode & 0o777;
    if (mode & 0o077) {
      permissionWarned = true;
      logger.error(
        `Fallback spool ${config.fallback.path} is mode ${mode.toString(8)}, not 600 — ` +
          'this filesystem ignores permissions. Move FALLBACK_STORE_PATH to a local disk ' +
          'or set FALLBACK_STORE_ENABLED=false and rely on Google Sheets.'
      );
    }
  } catch {
    // Not being able to stat is not a reason to drop a signup.
  }
}

async function appendFallback(entry) {
  const dir = path.dirname(config.fallback.path);
  await fsp.mkdir(dir, { recursive: true, mode: DIR_MODE });
  await fsp.appendFile(config.fallback.path, `${JSON.stringify(entry)}\n`, {
    encoding: 'utf8',
    mode: FILE_MODE,
  });
  // mkdir/appendFile only apply the mode at creation time; enforce it either way.
  await fsp.chmod(config.fallback.path, FILE_MODE).catch(() => {});
  await assertPrivateSpool();
}

/* ---------------------------------------------------------
   Public API
   --------------------------------------------------------- */

/**
 * Adds an address to the waitlist.
 *
 * The caller is NOT told which branch ran in any user-visible way — see
 * routes/waitlist.js, where new and duplicate produce byte-identical
 * responses. The distinction here exists only to avoid a pointless write.
 *
 * @param {{ email: string, source: string }} entry  email already normalised
 * @returns {Promise<{ created: boolean, duplicate: boolean, store: 'sheets'|'file' }>}
 */
async function addSubscriber(entry) {
  const timestamp = new Date().toISOString();
  const emailHash = hashEmail(entry.email);

  const row = [
    neutralizeFormula(timestamp),
    neutralizeFormula(entry.email),
    neutralizeFormula(entry.source),
  ];

  /* ---- No Google credentials: local spool ---- */
  if (!isGoogleConfigured()) {
    if (!config.fallback.enabled) {
      throw new HttpError(503, 'The waitlist is temporarily unavailable. Please try again shortly.', {
        code: 'store_unconfigured',
      });
    }

    const existing = await readFallbackHashes();
    if (existing.has(emailHash)) return { created: false, duplicate: true, store: 'file' };

    await appendFallback({ timestamp, email: entry.email, source: entry.source, emailHash });
    return { created: true, duplicate: false, store: 'file' };
  }

  /* ---- Google Sheets ---- */
  try {
    await ensureHeaderRow();

    const index = await loadHashIndex();
    if (index.has(emailHash)) {
      return { created: false, duplicate: true, store: 'sheets' };
    }

    const sheetName = await resolveSheetName();
    const sheets = await getSheets();
    await sheets.spreadsheets.values.append(
      {
        spreadsheetId: config.google.sheetId,
        range: `${sheetName}!${COLUMN_RANGE}`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [row] },
      },
      requestOptions()
    );

    // Keep the index in step so a rapid double-submit is caught before the
    // cache window expires.
    index.add(emailHash);

    return { created: true, duplicate: false, store: 'sheets' };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw translateGoogleError(err);
  }
}

/**
 * Total signups. Only reachable when PUBLIC_COUNT_ENABLED is on.
 *
 * @returns {Promise<number>}
 */
async function countSubscribers() {
  if (!isGoogleConfigured()) {
    if (!config.fallback.enabled) return 0;
    return (await readFallbackHashes()).size;
  }

  try {
    return (await loadHashIndex()).size;
  } catch (err) {
    throw translateGoogleError(err);
  }
}

/**
 * Boot-time check so misconfiguration shows up in the deploy log rather
 * than on a visitor's first submit.
 *
 * @returns {Promise<{ ok: boolean, store: string, reason?: string, title?: string }>}
 */
async function verifyConnection() {
  if (!isGoogleConfigured()) {
    return { ok: false, store: 'file', reason: 'Google credentials not set' };
  }

  const sheets = await getSheets();
  const meta = await sheets.spreadsheets.get(
    { spreadsheetId: config.google.sheetId, fields: 'properties.title,sheets.properties.title' },
    requestOptions()
  );

  const titles = (meta.data.sheets ?? []).map((s) => s.properties.title);
  if (!titles.includes(config.google.sheetName)) {
    throw new Error(
      `Tab "${config.google.sheetName}" not found in the spreadsheet. Tabs present: ${titles.join(', ')}`
    );
  }

  return { ok: true, store: 'sheets', title: meta.data.properties.title };
}

module.exports = {
  addSubscriber,
  countSubscribers,
  verifyConnection,
};
