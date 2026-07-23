/* =========================================================
   NOOKAA — Email validation middleware
   server/middleware/validateEmail.js

   Runs before anything touches Google. Two independent gates:
     1. utils/email.js  — hard RFC structure, dependency free
     2. validator       — battle-tested library, belt and braces

   On success it puts a clean, normalised address on req.waitlist and
   deletes the raw body, so no downstream code can accidentally reach
   for an unsanitised value.
   ========================================================= */

'use strict';

const validator = require('validator');

const { HttpError } = require('../utils/httpError');
const { normalizeEmail, checkStructure, sanitizeText, MAX_EMAIL_LENGTH } = require('../utils/email');

// Deliberately vague and identical for every failure mode. Telling a caller
// *why* an address was rejected ("domain has no MX", "too long") hands them a
// free validation oracle; the visitor only needs to know it did not work.
const INVALID_MESSAGE = 'Invalid Email';
const EMPTY_MESSAGE = 'Please enter your email address.';

// Source is a free-text field the browser sends. Only known values are kept;
// anything else is coerced to the default rather than trusted into the sheet.
const ALLOWED_SOURCES = new Set(['landing-page', 'website']);
const DEFAULT_SOURCE = 'website';

/**
 * Express middleware.
 * Populates: req.waitlist = { email, source, trapped }
 */
function validateEmail(req, res, next) {
  const body = req.body;

  // express.json() gives us {} for an empty body and rejects malformed JSON
  // earlier, but a client can still POST a JSON array or a bare string.
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return next(new HttpError(400, INVALID_MESSAGE, { code: 'invalid_body' }));
  }

  // Honeypot. The field is hidden from humans by CSS; a bot that fills every
  // input trips it. Flagged here, answered with a normal success later so the
  // bot gets no signal that it was caught.
  const trapped = typeof body.website === 'string' && body.website.trim() !== '';

  const raw = body.email;

  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return next(new HttpError(400, EMPTY_MESSAGE, { code: 'empty_email' }));
  }

  if (typeof raw !== 'string') {
    return next(new HttpError(400, INVALID_MESSAGE, { code: 'invalid_type' }));
  }

  // Reject oversized input before doing any regex work on it.
  if (raw.length > MAX_EMAIL_LENGTH + 32) {
    return next(new HttpError(400, INVALID_MESSAGE, { code: 'too_long' }));
  }

  const email = normalizeEmail(raw);

  const structure = checkStructure(email);
  if (!structure.ok) {
    return next(new HttpError(400, structure.reason === 'empty' ? EMPTY_MESSAGE : INVALID_MESSAGE, {
      code: `structure_${structure.reason}`,
    }));
  }

  const looksValid = validator.isEmail(email, {
    allow_display_name: false,
    require_display_name: false,
    allow_utf8_local_part: false,
    require_tld: true,
    allow_ip_domain: false,
    domain_specific_validation: true,
    blacklisted_chars: '()<>[]\\,;:"',
  });

  if (!looksValid) {
    return next(new HttpError(400, INVALID_MESSAGE, { code: 'validator_reject' }));
  }

  const rawSource = sanitizeText(body.source, 40).toLowerCase();
  const source = ALLOWED_SOURCES.has(rawSource) ? rawSource : DEFAULT_SOURCE;

  req.waitlist = { email, source, trapped };

  // Drop the original payload so nothing downstream can read the raw values.
  req.body = undefined;

  return next();
}

module.exports = validateEmail;
module.exports.INVALID_MESSAGE = INVALID_MESSAGE;
module.exports.EMPTY_MESSAGE = EMPTY_MESSAGE;
