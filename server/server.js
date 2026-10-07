/* =========================================================
   NOOKAA — Beverages & Beyond
   server/server.js

   Express app + static host for the coming-soon page.
   Contains no Google code: storage lives in services/googleSheets.js.
   ========================================================= */

'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const morgan = require('morgan');

const { config, validate } = require('./utils/config');
const { logger, fingerprint, scrubSecrets } = require('./utils/logger');
const { HttpError } = require('./utils/httpError');
const { globalLimiter } = require('./middleware/rateLimiter');
const waitlistRouter = require('./routes/waitlist');
const store = require('./services/googleSheets');

/* ---------------------------------------------------------
   Fail fast on bad configuration
   --------------------------------------------------------- */

const configErrors = validate();
if (configErrors.length > 0) {
  logger.error('Refusing to start — configuration problems:');
  configErrors.forEach((e) => logger.error(`  • ${e}`));
  process.exit(1);
}

const app = express();

/* ---------------------------------------------------------
   Platform
   --------------------------------------------------------- */

// Only trust X-Forwarded-For for as many hops as actually exist. Trusting
// more than that lets a client forge the header and sidestep rate limiting.
app.set('trust proxy', config.trustProxyHops);
app.disable('x-powered-by');
app.set('etag', false); // no ETags on API responses

/* ---------------------------------------------------------
   HTTPS
   --------------------------------------------------------- */

if (config.forceHttps) {
  app.use((req, res, next) => {
    if (req.secure || req.get('x-forwarded-proto') === 'https') return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return res.status(403).json({ success: false, message: 'HTTPS required.' });
    }
    return res.redirect(308, `https://${req.get('host')}${req.originalUrl}`);
  });
}

/* ---------------------------------------------------------
   Security headers
   --------------------------------------------------------- */

app.use(
  helmet({
    // The page has no inline <style> or <script>, so the policy can be strict:
    // no 'unsafe-inline' anywhere, no remote script origins at all.
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'none'"], // the form is submitted by fetch, never natively
        'frame-ancestors': ["'none'"], // no clickjacking the signup box
        'script-src': ["'self'"],
        'style-src': ["'self'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com'],
        'img-src': ["'self'", 'data:'],
        'connect-src': ["'self'"],
        'manifest-src': ["'self'"],
        'object-src': ["'none'"],
        'upgrade-insecure-requests': [],
      },
    },
    // Do not send the page URL to Google Fonts or anywhere else.
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginEmbedderPolicy: false, // would block the Google Fonts stylesheet
    hsts: config.isProduction
      ? { maxAge: 63072000, includeSubDomains: true, preload: true }
      : false,
    frameguard: { action: 'deny' },
    noSniff: true,
    dnsPrefetchControl: { allow: false },
  })
);

app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), interest-cohort=()');
  next();
});

/* ---------------------------------------------------------
   CORS — deny by default
   --------------------------------------------------------- */

// With ALLOWED_ORIGINS empty (the normal case, page and API on one host) no
// CORS headers are emitted at all, so a browser on any other origin cannot
// read a response from this API.
app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true); // same-origin, curl, health checks
      if (config.allowedOrigins.includes(origin)) return callback(null, true);
      return callback(null, false); // no header → browser blocks it
    },
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type'],
    credentials: false,
    maxAge: 600,
  })
);

/* ---------------------------------------------------------
   Parsing, compression, logging
   --------------------------------------------------------- */

app.use(compression());

// Small ceiling: the only payload this API accepts is one email address.
app.use(express.json({ limit: '4kb', strict: true, type: 'application/json' }));

morgan.token('ipfp', (req) => fingerprint(req.ip));
app.use(
  morgan(
    // Deliberately not 'combined': that logs the Referer and User-Agent, and
    // the remote address in clear. Here the IP is a rotating fingerprint and
    // the request body is never touched.
    ':ipfp :method :url :status :res[content-length] - :response-time ms',
    { stream: { write: (line) => logger.info(line.trim()) } }
  )
);

app.use(globalLimiter);

/* ---------------------------------------------------------
   API
   --------------------------------------------------------- */

app.get('/api/health', (req, res) => {
  // Nothing about storage, environment or uptime — an unauthenticated
  // health probe should confirm liveness and reveal nothing else.
  res.json({ success: true, ok: true });
});

app.use('/api/waitlist', waitlistRouter);

// Any other /api/* path, before the static handler can see it.
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, ok: false, message: 'Endpoint not found.' });
});

/* ---------------------------------------------------------
   Static landing page
   --------------------------------------------------------- */

app.use(
  express.static(config.publicDir, {
    index: 'index.html',
    extensions: ['html'], // /privacy-policy → privacy-policy.html (Netlify does this itself)
    dotfiles: 'deny', // never serve .env, .git, .DS_Store …
    redirect: false,
    maxAge: config.isProduction ? '7d' : 0,
    setHeaders(res, filePath) {
      // HTML must not be cached, or a stale page keeps pointing at old JS.
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

/* ---------------------------------------------------------
   404
   --------------------------------------------------------- */

app.use((req, res) => {
  res.status(404).sendFile(path.join(config.publicDir, 'index.html'));
});

/* ---------------------------------------------------------
   Error handler
   --------------------------------------------------------- */

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const isHttp = err instanceof HttpError;
  const status = isHttp ? err.status : err.status || err.statusCode || 500;

  // Body parser rejections (bad JSON, oversized payload) arrive here.
  const isParseError = err.type === 'entity.parse.failed' || err.type === 'entity.too.large';

  if (!isHttp && !isParseError) {
    logger.error(`unhandled: ${scrubSecrets(err.message)}`);
    if (!config.isProduction && err.stack) console.error(err.stack);
  } else if (err.cause) {
    logger.error(`${err.code}: ${scrubSecrets(err.cause.message)}`);
  }

  if (res.headersSent) return;

  // Only messages we authored are echoed back. Everything else collapses to
  // one generic line, so no stack trace, file path, sheet id or Google API
  // payload can reach a visitor.
  const message = isHttp
    ? err.message
    : isParseError
      ? 'Invalid request.'
      : 'Something went wrong on our side. Please try again in a moment.';

  res.status(isParseError ? 400 : status).json({ success: false, ok: false, message });
});

/* ---------------------------------------------------------
   Boot
   --------------------------------------------------------- */

// Only listen on a port when this file is run directly (`node server/server.js`
// or `npm start`). When Netlify (or any other serverless platform) instead
// imports `app` to handle one request at a time, none of this — the socket,
// the shutdown handlers, the process-level listeners — applies, and calling
// app.listen() would just bind an unused port.
if (require.main === module) {
  const server = app.listen(config.port, () => {
    logger.info(`Nookaa server listening on port ${config.port} (${config.nodeEnv})`);

    store
      .verifyConnection()
      .then((status) => {
        if (status.ok) {
          logger.info(`Storage: Google Sheet "${status.title}"`);
        } else if (config.fallback.enabled) {
          logger.warn(`Storage: local file — ${status.reason}. Signups go to ${config.fallback.path}`);
        } else {
          logger.error(`Storage: UNAVAILABLE — ${status.reason}. Signups will be rejected.`);
        }
      })
      .catch((err) => {
        logger.error(`Storage check failed: ${scrubSecrets(err.message)}`);
      });
  });

  // Slowloris protection: cap how long a client may take to send its headers.
  server.headersTimeout = 20000;
  server.requestTimeout = 30000;
  server.keepAliveTimeout = 15000;

  /* ---------------------------------------------------------
     Shutdown
     --------------------------------------------------------- */

  let shuttingDown = false;

  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info(`${signal} received — shutting down.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // A crashed process is safer than a process running in an unknown state,
  // but it must not die silently.
  process.on('unhandledRejection', (reason) => {
    logger.error(`unhandled rejection: ${scrubSecrets(reason instanceof Error ? reason.message : reason)}`);
  });

  process.on('uncaughtException', (err) => {
    logger.error(`uncaught exception: ${scrubSecrets(err.message)}`);
    shutdown('uncaughtException');
  });
}

module.exports = app;
