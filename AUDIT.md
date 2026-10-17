# Security & Quality Audit

| | |
|---|---|
| **Audit date** | 17 October 2026 (previous: 6 October 2026) |
| **Scope** | `server/` (Node.js + Express API), `client/` (React + Vite SPA), database migrations, deployment configuration |
| **Commit** | `main` after Tyllage Shop, harvest rewards, Buyer Growth and the WhatsApp webhook fix |
| **Method** | Dependency audit (`npm audit`), manual code review of authentication, access control, data exposure and input handling, and the automated test suite |

This is an internal audit of the pilot MVP. It is not a third-party penetration test.

## Summary

| Area | Result |
|---|---|
| Dependency vulnerabilities (server, 126 packages) | **0** known (critical 0 · high 0 · moderate 0 · low 0) |
| Dependency vulnerabilities (client, 48 packages) | **0** known |
| Automated tests | **149 tests** in 16 suites, including RBAC, farm isolation, over-allocation, Shop and webhook tests. Run them with `npm test` against a disposable database and record the result here; GitHub Actions runs them on every push to `main` |
| SQL injection | No user input is interpolated into SQL |
| Secrets in the repository | None found; `.env` files are git-ignored |
| Open findings | 1 high (demo accounts on a public deployment), 2 medium, 5 low. 1 fixed since the last audit (reflected XSS in the WhatsApp webhook). See [Findings](#findings) |

## Controls verified

### Authentication

- Passwords are hashed with **bcrypt, 12 rounds**.
- Login always runs a bcrypt comparison, so response time does not reveal whether an email exists.
- **JWT bearer tokens** expire (default 8 hours). The server refuses to start in production with a `JWT_SECRET` shorter than 32 characters.
- The user's **role and active status are re-read from the database on every request**. A role in the token alone is never trusted, and deactivated users are rejected immediately.
- **Rate limits:**
  - 300 requests per minute per IP across the API;
  - **20 attempts per 15 minutes** on `/auth/login` and `/auth/register`.

### Access control

- Every protected route runs `verifyToken`, then `requireRole`.
- Farm-scoped routes also run `requireFarmAccess`. A `farmId` supplied by the client is always checked against the user's farm memberships.
- Resource routes (`/:id`) load the record and check its `farm_id` on the server before acting.
- Admin-only actions are enforced on the server with `assertFarmAdmin`:
  - approvals, pricing and route selection;
  - recovery, campaigns and dispositions.
- Tests cover:
  - spoofed `farmId` values;
  - cross-farm reads and writes;
  - staff attempting admin actions;
  - buyers attempting farm actions.

### Data exposure

- **Farm-private fields never reach buyers or the public:**
  - minimum price, production cost, margin and fulfilment cost estimates;
  - public and buyer views use dedicated DTOs (`toPublicBatchDTO`, `toBuyerOrder`).
- Public marketplace and Shop queries select explicit columns, never `SELECT *`. The public Shop listing never returns production cost, minimum price, packaging cost or the margin approval reason.
- Buyer Growth relationship notes are farm-private: only that farm's admins can read or change them, and only for buyers who have dealt with that farm.
- FarmPool partner farms are anonymised to other farms.
- Production error responses are sanitised; stack traces are not returned.

### Input handling

- All write endpoints validate input with **zod**.
- Database `CHECK` constraints back up the business rules, for example `min_price ≤ preferred_price`, positive quantities and non-negative reward balances.
- The WhatsApp webhook verification only echoes a challenge made of letters, digits, `-` and `_` (up to 128 characters) and replies as `text/plain` with `nosniff`. Tests cover rejected challenges.
- **Parameterised SQL only.** Dynamic `WHERE` and `SET` clauses only append numbered placeholders, and column names come from fixed allow-lists.
- JSON bodies are limited to **100 kB** (413 above that). Non-JSON write requests are rejected (415).
- The React client never uses `dangerouslySetInnerHTML` or `innerHTML`. All user content is escaped.

### Transport & headers

- **helmet** sets secure headers, including a Content Security Policy.
- `x-powered-by` is disabled.
- **CORS** uses an allow-list (`CLIENT_URL`) and sends no credentials.
- TLS is terminated by Railway. `trust proxy` is set so rate limits use the real client IP.

### Integrity & audit trail

- Stock is never stored as a counter. It is derived from allocations inside transactions that lock the batch row (`SELECT … FOR UPDATE`).
- A test proves that concurrent approvals cannot over-allocate.
- Shop checkout locks the listing and the buyer's reward account (`SELECT … FOR UPDATE`), re-checks remaining packs, and applies Margin Guard again, so a reward discount cannot take an order below the farm's approved margin and points cannot be spent twice. Each order earns, redeems or restores points at most once (`UNIQUE(order_id, kind)`).
- Farm-sensitive actions are written to an **audit log** in the same transaction as the action, for example:
  - `MATCH_APPROVED`, `ROUTE_SELECTED`, `ORDER_CANCELLED`;
  - `SHOP_LISTING_APPROVED`, `SHOP_CHECKOUT`, `ORDER_REORDERED`, `BUYER_RELATIONSHIP_UPDATED`;
  - `POLICY_UPDATED`;
  - sign-ins.

### AI guard-rails

- OpenAI receives only context built by the backend, and only returns message copy and explanations.
- Generated text is scanned for prices that are not in the approved context, and these are flagged to the reviewer.
- AI cannot change stock, prices, recipients or permissions.
- Every message requires farm approval before it is sent.

## Findings

| ID | Severity | Finding | Recommendation | Status |
|---|---|---|---|---|
| A-1 | **High** | **Demo accounts on a public deployment.** With `SEED_DEMO_ON_START=true`, the production database contains demo accounts, including `platform_admin`, whose shared password is published in the README. Anyone can sign in as a platform admin. | Acceptable only while the deployment holds fictional demo data. **Before any real farm or buyer data is entered:** disable or delete the demo accounts (or change their passwords), set `SEED_DEMO_ON_START=false`, and unset `VITE_SHOW_DEMO_ACCOUNTS`. | Open: accepted for the demo phase |
| A-2 | Medium | The **JWT is stored in `localStorage`**. If an XSS flaw were ever introduced, the token could be stolen. | Move to an `httpOnly`, `Secure`, `SameSite` cookie with CSRF protection before handling payments or real personal data. The current React escaping and CSP lower the likelihood. | Open |
| A-3 | Medium | The **WhatsApp webhook `POST`** does not verify `X-Hub-Signature-256`. The handler currently ignores the payload and returns 200, so there is no impact today. | Verify the signature with the app secret before processing any inbound message or status. | Open: no current impact |
| A-4 | Low | **No multi-factor authentication or account lockout.** Brute force is slowed only by the per-IP auth rate limit. The password minimum is 8 characters. | Add MFA for `platform_admin` and `farm_admin`, and per-account lockout or backoff. | Open |
| A-5 | Low | **Rate limits are kept in memory**, per instance. They reset on restart and are not shared if the service is scaled out. | Use a shared store (for example Redis) before running more than one replica. | Open |
| A-6 | Low | **Request logs include client IP addresses** (morgan `combined` format in production). | Document log retention in the privacy notice, or drop IPs from logs if not needed. | Open |
| A-7 | Low | **Fictional data is no longer labelled in the portal.** The seeded pilot data now uses real-looking names ("ComCrop Singapore", "Restaurant A") without "Demo" labels. Visitors to a public deployment could mistake it for ComCrop's real production, prices or customers. | Keep the README disclaimer, and add a short "fictional pilot data" note to the login page or footer while the deployment runs on seed data. | Open |
| A-8 | Low | **Shop payment is simulated.** Paid Shop orders are recorded as `DEMO_PAID` without collecting money. No card or bank details are collected or stored. | Integrate a PCI-compliant payment provider (hosted checkout, so card data never reaches Tyllage) and move the JWT to an `httpOnly` cookie (A-2) before taking real payments. | Open: by design for the pilot |
| A-9 | Medium | **Reflected XSS in WhatsApp webhook verification.** `GET /api/whatsapp/webhook` echoed `hub.challenge` unchanged once the verify token matched. | Only accept plain challenge tokens and reply as `text/plain` with `nosniff`. | **Fixed** 16 October 2026 (commit `430a14b`), with tests |

### Informational

- `npm run test` **drops and re-creates the database in `TEST_DATABASE_URL`**. Never point it at a real database.
- Dependency updates are monitored weekly by Dependabot (`.github/dependabot.yml`).
- `client/package.json` and `server/package.json` are marked `private`, so they cannot be accidentally published to npm.

## Re-running this audit

From the repository root:

```bash
npm audit --prefix server
```

```bash
npm audit --prefix client
```

```bash
npm test
```

Update the date, results and finding statuses in this file after each audit. Report suspected vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
