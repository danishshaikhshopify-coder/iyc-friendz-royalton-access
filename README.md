# royalton-access

Secure, server-verified delivery of the private Royalton booking link to
eligible IYC & FRIENDZ Weekend Pass customers. Built for Task 17 after
confirming that Shopify Checkout Blocks (used on the Thank You / Order
Status pages) cannot verify payment, cancellation, or refund status — see
the Task 17 report for the full writeup of why, and what this service
does instead.

## What this is

A minimal Next.js (App Router, TypeScript) service with three jobs:

1. **Webhook intake** (`src/app/api/webhooks/*`) — listens for
   `orders/paid`, `orders/cancelled`, and `refunds/create`, verifies each
   delivery's HMAC signature against the raw body, re-checks eligibility
   live against the Shopify Admin API (never trusting the webhook
   payload's own fields as final), and on a newly-eligible paid order:
   mints a token, stores only its hash, and emails the customer a link to
   this service's own access page (never the real Royalton URL).
2. **Secure access page** (`src/app/apps/royalton-access`) — served
   through a Shopify App Proxy. Verifies the proxy signature, rate-limits,
   looks up the token, and re-checks eligibility live against the Admin
   API on *every single request* — this is the actual access-control
   decision point, not the webhook.
3. **A small SQLite/libSQL (Turso) database** — tracks, per order: a
   hashed access token, its revocation state, and whether the email was
   sent. See `src/db/migrations/0001_init.sql` for the schema and the
   reasoning behind what is/isn't stored.

## Why a new service, not an extension of something existing

See the Task 17 report's Infrastructure Audit section. In short: the
client's Klyro app and its hosting/DB/GitHub were not reachable from this
session (no repo, Vercel, or Turso credentials available here), and the
store's existing custom app ("IXM") is a legacy custom app that cannot
support an App Proxy at all. A new, minimal, separate service was the
only option that didn't involve guessing at infrastructure this session
has no visibility into.

## Running locally

```bash
npm install
cp .env.example .env.local   # then fill in the 4 fields below
npm run db:migrate           # creates/updates dev.db
npm run dev
```

`.env.example` leaves `SHOPIFY_WEBHOOK_SIGNING_SECRET`,
`SHOPIFY_APP_PROXY_SIGNING_SECRET`, `ACCESS_TOKEN_SIGNING_SECRET`,
`SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, and `TOKEN_ENCRYPTION_KEY` blank on
purpose (they're real secrets, never committed) — `src/lib/config.ts`
treats all six as required, so the app won't start with them empty. For
local development only (never for a real deployment), set them to any
non-empty placeholder string (`TOKEN_ENCRYPTION_KEY` must still decode as
32 base64 bytes — use a real `openssl rand -base64 32` value even
locally), e.g.:

```bash
SHOPIFY_WEBHOOK_SIGNING_SECRET=local-dev-placeholder
SHOPIFY_APP_PROXY_SIGNING_SECRET=local-dev-placeholder
ACCESS_TOKEN_SIGNING_SECRET=local-dev-placeholder
SHOPIFY_API_KEY=local-dev-placeholder
SHOPIFY_API_SECRET=local-dev-placeholder
TOKEN_ENCRYPTION_KEY=$(openssl rand -base64 32)
```

(`tests/setup.ts` does exactly this for the test suite — same pattern.)
The Admin API access token is **no longer a pasted static value** — this
app now obtains it via Shopify OAuth (Authorization Code Grant, offline
access; see `src/lib/shopify-oauth.ts`) and stores it encrypted in the
`shop_installations` table, since this app runs on a merchant-owned store
outside this org's Partner Dev Dashboard (per Shopify's standalone-app
guidance). Locally, the eligibility-checking routes simply fail closed
(`AdminApiError`/502) until `/api/auth?shop=...` has been completed against
a real, publicly-reachable (tunneled) deployment — there's no local mock
for the OAuth dance itself; unit/route tests mock the Admin API client
instead (see Testing below). `npm run db:migrate` reads `.env.local`
automatically (via Node's `--env-file-if-exists`, Node 20.12+/21.7+ —
already covered by this project's `engines` requirement).

## Testing

```bash
npm run typecheck
npm run lint
npm run test
npm run build
```

The test suite (`tests/`) runs entirely against a disposable local SQLite
file and fake env values (see `tests/setup.ts`) — no live Shopify, Turso,
or email credentials are needed or used. It covers: the full eligibility
matrix from the Task 17 spec, webhook HMAC verification (including why
raw-body bytes matter), App Proxy signature verification (including
tamper detection), token generation/hashing/verification and secret
rotation, webhook idempotency (duplicate delivery handling), access-grant
data access (create/find/revoke/mark-sent), rate limiting, and — the most
security-relevant set — that the real Royalton URL never appears in the
email or in any non-eligible rendering of the access page.

What the test suite does **not** cover, because it requires a live
environment this session doesn't have (see the Task 17 report's Testing
and Outstanding Requirements sections for the full list, and which rows
are marked NOT TESTED): an actual Shopify webhook delivery end-to-end, a
real App Proxy request from a live storefront, a real email send through
Klaviyo/Omnisend, and anything involving a real paid/cancelled/refunded
order (no test orders were created against the live store without
explicit permission).

## Environment variables

See `.env.example` — every variable is documented there, including which
ones are required vs. optional and what they default to.

## Key design decisions (see the Task 17 report for full justification)

- **The webhook is a trigger, not the access decision.** Every access
  check — at email-send time and at every single page load — re-queries
  the Shopify Admin API live. A webhook payload's own `financial_status`
  field is never trusted as final.
- **Tokens**: 32 random bytes, never sequential/derived from the order
  id. Only an HMAC hash of the token is stored; rotating
  `ACCESS_TOKEN_SIGNING_SECRET` invalidates every outstanding token at
  once (the documented revocation mechanism).
- **Partial refunds default to deny** (`PARTIAL_REFUND_POLICY=deny`) —
  business policy was not confirmed by the client, so access is withheld
  pending manual review until that's explicitly set to `allow`.
- **The Royalton URL** lives only in `ROYALTON_BOOKING_URL` (server
  config). It's never hardcoded, never defaulted to a placeholder, never
  stored in the database, and never sent to the browser except inside the
  HTML of an access page response that has just passed a live eligibility
  check.
- **A forwarded email link is still a bearer credential** — anyone who
  has the link can use it, the same as anyone who knows a password. This
  is documented, not hidden; see the Task 17 report's Outstanding
  Requirements for the optional second-factor design (e.g. requiring the
  Shopify customer login session, via `logged_in_customer_id`, to match
  the order) that was not implemented here because it would require
  confirming the store's customer-account configuration first.

## What's intentionally out of scope / left for the report

Updating or retiring the existing Checkout Blocks block (from Task 17
Phase 1) is **not** done by this project — the Task 17 report recommends
how to do that once this system is verified live, but no production
Shopify admin change is made without separate approval.
