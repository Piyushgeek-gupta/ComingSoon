/* =========================================================
   NOOKAA — Email helpers
   server/utils/email.js

   Zero dependencies on purpose: this module is pure, so it can be
   unit tested on its own and reused by both the middleware and the
   storage service without dragging Express or googleapis along.
   ========================================================= */

'use strict';

const MAX_EMAIL_LENGTH = 254; // RFC 5321 total path length
const MAX_LOCAL_LENGTH = 64; // RFC 5321 local part
const MAX_LABEL_LENGTH = 63; // RFC 1035 dns label

// C0/C1 control characters, plus the Unicode line/paragraph separators.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;

// Zero-width and bidirectional-override characters. These render as nothing
// but let an attacker smuggle a different address past a human reviewer.
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

/**
 * Strips anything that could break out of a log line, an HTTP header or a
 * spreadsheet cell. Applied to every untrusted string before it is stored.
 *
 * @param {unknown} value
 * @param {number} maxLength
 * @returns {string}
 */
function sanitizeText(value, maxLength = 200) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKC')
    .replace(CONTROL_CHARS, '')
    .replace(INVISIBLE_CHARS, '')
    .trim()
    .slice(0, maxLength);
}

/**
 * Google Sheets treats a leading =, +, -, @ or tab as the start of a formula.
 * A value like  =IMPORTXML(...)  in a cell will happily exfiltrate the rest of
 * the sheet to an attacker's server the moment someone opens it. We write with
 * valueInputOption:'RAW', which already prevents evaluation, but prefixing a
 * single quote makes the cell inert even if the sheet is later re-imported,
 * copy-pasted or opened in Excel.
 *
 * @param {string} value
 * @returns {string}
 */
function neutralizeFormula(value) {
  const text = typeof value === 'string' ? value : '';
  if (text === '') return '';
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

/**
 * Lowercases and trims. Deliberately does NOT do "gmail dot stripping" style
 * canonicalisation: two addresses that Google considers the same are still two
 * addresses the person typed, and silently merging them loses signups.
 *
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeEmail(raw) {
  return sanitizeText(raw, MAX_EMAIL_LENGTH + 1).toLowerCase();
}

/**
 * Structural check, applied before the heavier `validator` pass in the
 * middleware. Everything here is a hard RFC constraint, not a taste judgement.
 *
 * @param {string} email  already normalised
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function checkStructure(email) {
  if (!email) return { ok: false, reason: 'empty' };
  if (email.length > MAX_EMAIL_LENGTH) return { ok: false, reason: 'too_long' };

  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return { ok: false, reason: 'shape' };

  const local = email.slice(0, at);
  const domain = email.slice(at + 1);

  if (local.length > MAX_LOCAL_LENGTH) return { ok: false, reason: 'local_too_long' };
  if (local.includes('@') || /\s/.test(local)) return { ok: false, reason: 'shape' };
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
    return { ok: false, reason: 'local_dots' };
  }

  if (!domain.includes('.')) return { ok: false, reason: 'domain' };
  if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) {
    return { ok: false, reason: 'domain_dots' };
  }
  if (domain.startsWith('[') || /\s/.test(domain)) return { ok: false, reason: 'domain' };

  const labels = domain.split('.');
  for (const label of labels) {
    if (!label || label.length > MAX_LABEL_LENGTH) return { ok: false, reason: 'domain_label' };
    if (label.startsWith('-') || label.endsWith('-')) return { ok: false, reason: 'domain_label' };
    if (!/^[a-z0-9-]+$/.test(label)) return { ok: false, reason: 'domain_charset' };
  }

  const tld = labels[labels.length - 1];
  if (tld.length < 2 || !/^[a-z]+$/.test(tld)) return { ok: false, reason: 'tld' };

  return { ok: true };
}

module.exports = {
  MAX_EMAIL_LENGTH,
  sanitizeText,
  neutralizeFormula,
  normalizeEmail,
  checkStructure,
};
