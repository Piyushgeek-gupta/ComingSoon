/* =========================================================
   NOOKAA — Logging
   server/utils/logger.js

   Logs are the most commonly leaked copy of a mailing list: they get
   shipped to third-party aggregators, sit in container stdout, and end
   up in screenshots. Nothing here ever prints a full email address or a
   raw IP — both are reduced to a short salted fingerprint that is enough
   to correlate two lines but useless for contacting anyone.
   ========================================================= */

'use strict';

const crypto = require('crypto');

// Rotates on restart. Fingerprints are for reading one log session, not
// for building a persistent identifier across deploys.
const LOG_SALT = crypto.randomBytes(16);

/**
 * @param {unknown} value
 * @returns {string} 8-char fingerprint, or '-' for empty input
 */
function fingerprint(value) {
  if (!value) return '-';
  return crypto
    .createHash('sha256')
    .update(LOG_SALT)
    .update(String(value))
    .digest('hex')
    .slice(0, 8);
}

/**
 * Shows the domain (useful for spotting a bot hammering one provider)
 * but never the local part.
 *
 * @param {unknown} email
 * @returns {string}
 */
function maskEmail(email) {
  if (typeof email !== 'string' || !email.includes('@')) return '-';
  const domain = email.slice(email.lastIndexOf('@') + 1);
  return `${fingerprint(email)}@${domain}`;
}

/**
 * Errors thrown by googleapis often embed the request URL, which contains
 * the spreadsheet id. Scrub it so the sheet id cannot leak via a log line
 * or an error-tracking service.
 *
 * @param {unknown} message
 * @returns {string}
 */
function scrubSecrets(message) {
  return String(message === undefined || message === null ? '' : message)
    .replace(/spreadsheets\/d\/[A-Za-z0-9_-]+/g, 'spreadsheets/d/[redacted]')
    .replace(/-----BEGIN[\s\S]*?END [A-Z ]*PRIVATE KEY-----/g, '[redacted key]')
    .replace(
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.iam\.gserviceaccount\.com/g,
      '[redacted service account]'
    );
}

function stamp() {
  return new Date().toISOString();
}

const logger = {
  info(message, meta) {
    console.log(`${stamp()} [info]  ${scrubSecrets(message)}${meta ? ` ${JSON.stringify(meta)}` : ''}`);
  },
  warn(message, meta) {
    console.warn(`${stamp()} [warn]  ${scrubSecrets(message)}${meta ? ` ${JSON.stringify(meta)}` : ''}`);
  },
  error(message, meta) {
    console.error(`${stamp()} [error] ${scrubSecrets(message)}${meta ? ` ${JSON.stringify(meta)}` : ''}`);
  },
};

module.exports = { logger, fingerprint, maskEmail, scrubSecrets };
