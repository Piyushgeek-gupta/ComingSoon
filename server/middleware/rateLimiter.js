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
 * express-rate-limit's default key generator handles IPv6 correctly
 * (it collapses a /56 so one subnet cannot spread attempts across
 * 2^72 addresses). We only wrap it to add logging.
 */
function onLimitReached(req, res, next, options) {
  logger.warn('rate limit hit', {
    path: req.path,
    ip: fingerprint(req.ip),
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
  handler: onLimitReached,
});

module.exports = { joinLimiter, globalLimiter };
