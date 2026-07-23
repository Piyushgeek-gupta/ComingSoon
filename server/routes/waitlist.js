/* =========================================================
   NOOKAA — Waitlist routes
   server/routes/waitlist.js

   POST /api/waitlist        join the waitlist
   GET  /api/waitlist/count  total signups (disabled by default)

   Pipeline:
     rate limit → validate → sanitize → duplicate check → store → JSON

   ---------------------------------------------------------
   A note on the duplicate response
   ---------------------------------------------------------
   Returning "Already Joined" tells any caller whether a given address is
   on the list. That turns this endpoint into a free lookup service: feed
   it a list of addresses and it reports which of your customers signed up.
   By default the API therefore answers new and duplicate submissions
   identically — same status, same body, same duration.

   Set REVEAL_DUPLICATES=true to get the distinct
   { success:false, message:"Already Joined" } response instead, at the
   cost of that enumeration oracle.
   ========================================================= */

'use strict';

const express = require('express');

const store = require('../services/googleSheets');
const validateEmail = require('../middleware/validateEmail');
const { joinLimiter } = require('../middleware/rateLimiter');
const { config } = require('../utils/config');
const { asyncHandler, padDuration, HttpError } = require('../utils/httpError');
const { logger, maskEmail } = require('../utils/logger');

const router = express.Router();

// One message for every accepted submission, whether it was new or already
// present. Wording matches what the page showed before.
const JOINED_MESSAGE = "Thanks! You're on the Nookaa waitlist — a free drink awaits on launch day.";

/* ---------------------------------------------------------
   POST /api/waitlist
   --------------------------------------------------------- */

router.post(
  '/',
  joinLimiter,
  validateEmail,
  asyncHandler(async (req, res) => {
    const startedAt = Date.now();
    const { email, source, trapped } = req.waitlist;

    // Honeypot tripped: behave exactly like a success, store nothing.
    // The bot gets no feedback that it was filtered.
    if (trapped) {
      logger.warn('honeypot triggered', { source });
      await padDuration(startedAt, config.responseFloorMs);
      return res.status(200).json({ success: true, ok: true, message: JOINED_MESSAGE });
    }

    const result = await store.addSubscriber({ email, source });

    logger.info('waitlist submission', {
      outcome: result.duplicate ? 'duplicate' : 'created',
      store: result.store,
      // Domain only — the address itself never reaches a log line.
      email: maskEmail(email),
    });

    // Equalise the response time before replying, so a duplicate (no write)
    // is not measurably faster than a new signup (one Sheets round-trip).
    await padDuration(startedAt, config.responseFloorMs);

    if (result.duplicate && config.revealDuplicates) {
      return res.status(200).json({ success: false, ok: false, message: 'Already Joined' });
    }

    return res.status(200).json({ success: true, ok: true, message: JOINED_MESSAGE });
  })
);

/* ---------------------------------------------------------
   GET /api/waitlist/count
   --------------------------------------------------------- */

let countCache = { value: null, fetchedAt: 0 };

router.get(
  '/count',
  asyncHandler(async (req, res) => {
    // The size of a mailing list is competitive information and a rough
    // measure of how much data a breach would yield. Off unless requested.
    if (!config.publicCount.enabled) {
      throw new HttpError(404, 'Endpoint not found.', { code: 'count_disabled' });
    }

    const fresh = countCache.value !== null && Date.now() - countCache.fetchedAt < config.publicCount.cacheTtlMs;

    if (!fresh) {
      countCache = { value: await store.countSubscribers(), fetchedAt: Date.now() };
    }

    // Rounded down to the nearest hundred: enough for "2,000+ early birds",
    // not enough to watch the list grow one signup at a time.
    const total = countCache.value + config.publicCount.base;
    const bucketed = total >= 100 ? Math.floor(total / 100) * 100 : 0;

    res.set('Cache-Control', 'public, max-age=300');
    return res.json({ success: true, ok: true, count: bucketed });
  })
);

/* ---------------------------------------------------------
   Anything else under /api/waitlist
   --------------------------------------------------------- */

// router.use() rather than a wildcard path string: the wildcard syntax
// changed between Express 4 and 5, this form is valid in both.
router.use((req, res) => {
  res.status(404).json({ success: false, ok: false, message: 'Endpoint not found.' });
});

module.exports = router;
