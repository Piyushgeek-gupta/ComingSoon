/* =========================================================
   NOOKAA — Rate limiting
   server/middleware/rateLimiter.js

   Two layers:
     joinLimiter   — tight, per IP, on the write endpoint
     globalLimiter — loose, per IP, on everything else

   Both refuse to trust X-Forwarded-For unless the operator has
   declared how many proxies are really in front of the app
   (TRUST_PROXY_HOPS). Otherwise anyone can rotate a header value
   and get unlimited attempts.
   ========================================================= */

'use strict';

const rateLimit = require('express-rate-limit');

const { config } = require('../utils/config');
const { logger, fingerprint } = require('../utils/logger');

const TOO_MANY = {
  success: false,
  message: 'Too many attempts. Please try again in a little while.',
};

/**
 * express-rate-limit's default key generator just returns req.ip, which
 * relies on Express's trust-proxy machinery reading a real socket address.
 * Netlify Functions have no real socket — the request arrives as an event
 * object — so req.ip can come back undefined even with trust proxy set
 * correctly, and the default key generator throws ERR_ERL_UNDEFINED_IP_ADDRESS.
 *
 * x-nf-client-connection-ip is Netlify's own header for the real visitor
 * IP, set by their edge and not attacker-controllable. Falling back to the
 * first x-forwarded-for entry covers any other reverse proxy in front of
 * this app; req.ip is still tried first so nothing changes on hosts where
 * it already works correctly.
 */
function resolveKey(req) {
  const forwardedFor = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return req.ip || req.headers['x-nf-client-connection-ip'] || forwardedFor || 'unknown';
}

function onLimitReached(req, res, next, options) {
  logger.warn('rate limit hit', {
    path: req.path,
    ip: fingerprint(resolveKey(req)),
    limit: options.limit,
  });
  res.status(options.statusCode).json(TOO_MANY);
}

/** Strict limiter for POST /api/waitlist. Default: 5 attempts / 15 min / IP. */
const joinLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  limit: config.rateLimit.max,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: resolveKey,
  // Failed validation still counts. Otherwise an attacker gets free attempts
  // by sending garbage, which is exactly what an enumeration script does.
  skipFailedRequests: false,
  skipSuccessfulRequests: false,
  handler: onLimitReached,
});

/** Coarse limiter in front of the whole app, to blunt simple floods. */
const globalLimiter = rateLimit({
  windowMs: config.rateLimit.globalWindowMs,
  limit: config.rateLimit.globalMax,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: resolveKey,
  handler: onLimitReached,
});

module.exports = { joinLimiter, globalLimiter };
