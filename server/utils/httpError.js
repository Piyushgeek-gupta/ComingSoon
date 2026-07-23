/* =========================================================
   NOOKAA — Error plumbing
   server/utils/httpError.js
   ========================================================= */

'use strict';

/**
 * An error that is safe to show a visitor.
 *
 * Anything thrown that is NOT an HttpError is treated as an internal fault
 * by the error handler: it gets logged in full and the client receives a
 * generic message. That default keeps stack traces, Google API payloads and
 * spreadsheet ids off the wire.
 */
class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} publicMessage  shown to the visitor verbatim
   * @param {object} [options]
   * @param {string} [options.code]   short machine-readable tag
   * @param {Error}  [options.cause]  original error, logged but never sent
   */
  constructor(status, publicMessage, options = {}) {
    super(publicMessage);
    this.name = 'HttpError';
    this.status = status;
    this.expose = true;
    this.code = options.code || 'error';
    if (options.cause) this.cause = options.cause;
  }
}

/**
 * Wraps an async route handler so a rejected promise reaches the Express
 * error handler instead of becoming an unhandled rejection that takes the
 * process down.
 *
 * @param {Function} handler
 * @returns {Function}
 */
function asyncHandler(handler) {
  return function wrapped(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/**
 * Resolves no sooner than `floorMs` after `startedAt`.
 *
 * Used to give every waitlist response the same duration. Without it, a
 * duplicate address returns in ~5ms (in-memory hit, no write) while a new
 * one takes a few hundred (one Sheets round-trip) — a difference an attacker
 * can measure to test whether a given person is on the list.
 *
 * @param {number} startedAt  value from Date.now()
 * @param {number} floorMs
 * @returns {Promise<void>}
 */
function padDuration(startedAt, floorMs) {
  const elapsed = Date.now() - startedAt;
  const remaining = floorMs - elapsed;
  if (remaining <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, remaining));
}

module.exports = { HttpError, asyncHandler, padDuration };
