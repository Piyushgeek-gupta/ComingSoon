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

const handler = serverless(app);

exports.handler = async (event, context) => {
  // netlify.toml rewrites "/api/*" to "/.netlify/functions/api/api/:splat".
  // Strip the function's own mount path back off so Express sees the
  // original "/api/..." route it already knows how to handle.
  event.path = event.path.replace(/^\/\.netlify\/functions\/api/, '');
  return handler(event, context);
};
