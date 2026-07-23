/* =========================================================
   NOOKAA — Email fingerprinting
   server/utils/emailHash.js

   The duplicate index never holds plaintext addresses. Every address
   read out of the sheet is turned into a keyed HMAC here and the
   original is discarded, so a heap dump, a core file or an accidental
   log of the index yields nothing usable.

   Keyed, not a plain SHA-256: the space of real email addresses is
   small and heavily patterned, so an unkeyed digest is recoverable
   with a wordlist in minutes. The key (EMAIL_HASH_SECRET) is what
   makes the fingerprint one-way in practice.

   Node builtins only — this module is a security primitive and is
   testable without installing anything.
   ========================================================= */

'use strict';

const crypto = require('crypto');

const { config } = require('./config');

// In production config.validate() requires EMAIL_HASH_SECRET to be present
// and at least 32 characters. The random fallback exists so local dev works
// out of the box; it rotates per process, which only means the duplicate
// index is rebuilt from the sheet after a restart.
const HASH_KEY = config.emailHashSecret
  ? Buffer.from(config.emailHashSecret, 'utf8')
  : crypto.randomBytes(32);

/**
 * @param {string} email  already normalised (trimmed + lowercased)
 * @returns {string} base64 HMAC-SHA256 digest
 */
function hashEmail(email) {
  return crypto.createHmac('sha256', HASH_KEY).update(String(email)).digest('base64');
}

module.exports = { hashEmail };
