'use strict';

/* =========================================================
   NOOKAA — Netlify Functions entry point
   netlify/functions/api.js

   Netlify only runs code inside functions/, one HTTP request at a time.
   This file just hands each request to the same Express app that runs
   locally — no route or logic duplication.
   ========================================================= */

const serverless = require('serverless-http');
const app = require('../../server/server');

// Netlify's edge is always exactly one hop in front of a function — unlike
// server/server.js's TRUST_PROXY_HOPS (which defaults to 0 because that file
// also runs on hosts with no proxy at all), this adapter can state that fact
// outright. Without it, Express has no real socket to read req.ip from here,
// so it comes back undefined and express-rate-limit throws
// ERR_ERL_UNDEFINED_IP_ADDRESS on every request.
app.set('trust proxy', 1);

const handler = serverless(app);

exports.handler = async (event, context) => {
  // netlify.toml rewrites "/api/*" to "/.netlify/functions/api/api/:splat".
  // Strip the function's own mount path back off so Express sees the
  // original "/api/..." route it already knows how to handle.
  event.path = event.path.replace(/^\/\.netlify\/functions\/api/, '');
  return handler(event, context);
};
