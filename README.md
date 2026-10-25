# Tyllage

**From Harvest to Demand.**

*Demand & Market Access Platform for Local Farms — Commercial Intelligence · Market Coordination · Demand Recovery*

> **Proprietary software. © 2026 Tyllage LLP. All rights reserved.**
> This repository is not open source. Being able to see it on GitHub does not give you permission to copy, use, run, modify, deploy or redistribute any part of it. Outside contributions are not accepted. See [LICENSE](LICENSE).

## Overview

The October 2026 proposal-pack review and implementation map are in [Proposal alignment and pilot plan](docs/PROPOSAL_ALIGNMENT.md). See [Pilot release workflow](docs/PILOT_RELEASE.md) for validation and rollout.

Tyllage is a farm commercial-intelligence and coordination platform. It brings expected harvest, buyer demand, sales routes, fulfilment conditions, margin and recovery options into one farm-facing view. It is developed as a **ComCrop-focused pilot** (proposal v3) and architected for **multi-farm expansion**.

Tyllage does not replace SAFEF initiatives, wholesalers, logistics providers, retailers or farm-management systems. It treats them as routes, fulfilment partners and data sources to compare.

> **Industry-wide opportunity, ComCrop-first validation.**
> All ComCrop data in this repository is **fictional pilot data**. It does not represent ComCrop's actual production, customers, prices, revenue, costs or commercial agreements. The portal no longer labels records as "Demo", so this notice is the disclaimer: say so whenever you show the pilot deployment to others.

### Problem

Singapore farms face structurally higher land, labour and energy costs than regional farms, while demand is fragmented across wholesale, food-service, retail, community and direct channels. Wholesale aggregation, shared logistics, premium positioning and institutional sales each solve part of the problem. Farms still lack one way to compare commercial routes, see demand coverage, judge fulfilment conditions and recover displaced inventory.

The question is not only "can we sell this harvest?" but:

> Which route gives this harvest the strongest viable outcome?

### Solution: the core workflow (proposal v3 §7)

```
Record expected harvest → Capture demand → Demand coverage → Compare routes (MarketRoute)
→ HarvestMatch within the route → Farmer approves allocation → Monitor exposure
→ Demand Recovery (Primary → Alternative → Rescue → Final disposition) → Insights
```

| Module | What it does |
|---|---|
| **Demand Radar** | Expected harvest against confirmed and potential demand, per produce and per batch, with the recommended route for whatever is still exposed. |
| **Demand Coverage** | `Confirmed Demand ÷ Expected Harvest × 100`, calculated live from real allocations. Rule-based risk: ≥80% LOW · 50–79% MEDIUM · <50% HIGH. |
| **MarketRoute** | Compares routes for each batch (restaurants & cafés, hotels & caterers, wholesale, retail & wet markets, community & D2C, Rescue) with a transparent **Commercial Route Score**, and proposes a route plan for the remaining quantity. It does not assume the highest-volume buyer is the best outcome. |
| **HarvestMatch** | Once a route is selected, ranks the buyers *within* it, using transparent weighted scoring with reasons. It can also run across all routes. Not machine learning. |
| **Margin Guard** | Compares selling price, minimum viable price, production cost and **estimated fulfilment cost** (per route and per order) before a route is recommended. Farm-private. |
| **Allocations / Orders** | Approving a match creates order + order item + allocation in one transaction, with fulfilment terms and estimated fulfilment cost. Over-allocation is impossible. |
| **Demand Recovery** | Re-runs route comparison and buyer matching against the remaining eligible channels, and shows the stage: **Primary route → Alternative route → Rescue route → Final disposition record**. |
| **Tyllage Rescue** | An alternative route for produce the farm has itself judged suitable for sale. Tyllage does not determine food safety. |
| **Tyllage Connect** | Approved outreach (OpenAI-assisted or template), which can target the buyers of one route. The backend controls inventory, prices, recipients and approvals. |
| **Tyllage Shop** | Consumers pre-order farm-approved packs from upcoming harvests (pre-orders, surprise bags and reward items) and collect them in a set pickup window or at a Community Drop. Every listing passes Margin Guard, including packaging cost, and draws on the same allocation ledger as other orders. Payment is simulated. |
| **Harvest rewards** | Consumers earn 1 point per dollar on completed Shop orders with a farm, and can redeem 100 points for $1 off or spend points on reward items. A discount can never take an order below the farm's approved margin. |
| **Buyer Growth** | Farm-private view of each buyer's order history and reorder pattern, with relationship notes and follow-up dates. Buyers can reorder a past order at today's prices from **Orders → Buy again**. |
| **Disputes** | Buyers and farms report an issue on an order; a platform admin records the decision and both parties are notified. |
| **Tyllage Insights** | Which crops achieve stronger coverage, which routes preserve margin after fulfilment, which buyers reorder, and which routes recover surplus. Includes the pilot success framework. |
| **WhatsApp** | Cloud API integration with a full mock mode. |

### ComCrop-first validation strategy

The pilot tests whether better demand visibility, commercial-route comparison, buyer matching and recovery workflows create measurable value (proposal v3 §11). The pilot questions are: how much upcoming harvest already has confirmed demand, which channel is the strongest commercial fit for the rest, whether that route stays viable after price and fulfilment, whether Tyllage finds an alternative when a route fails, and what data becomes useful for future crop and channel decisions.

- The UX is optimised for a ComCrop-style urban vegetable farm, using pilot demo data.
- The backend is multi-farm from day one. Every farm-owned record carries `farm_id`, every farm-sensitive route checks access server-side, and a second demo farm ("Farm B") is seeded to prove isolation.
- Nothing is hard-coded to ComCrop. A platform admin can onboard Farm B, Farm C, and so on from **Platform → Farms**.

---

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | React 19, Vite, JavaScript, React Router 7, native Fetch |
| Backend | Node.js (≥ 22.9), Express 5, REST |
| Database | PostgreSQL (raw parameterised SQL via `pg`, plain SQL migrations) |
| Auth | JWT, bcrypt (`bcryptjs`, 12 rounds), role-based access control |
| Validation | zod (server-side) |
| Security | helmet, CORS allow-list, express-rate-limit, centralised error handling, audit log |
| Integrations | OpenAI Chat Completions API (optional), WhatsApp Cloud API (optional) |
| Tests | `node:test` + supertest against a real PostgreSQL test database |
| Deployment | Railway (single service: Express serves the API and the built client) |

No Python in the MVP. A Python AI/ML microservice is planned for later phases (see roadmap).

## Architecture

```
 Browser (React SPA)
   │  fetch /api/*  (JWT bearer)
   ▼
 Express app ── helmet · CORS · rate-limit · JSON 100kb
   ├─ routes/        URL → middleware (verifyToken, requireRole, requireFarmAccess) → controller
   ├─ controllers/   thin: parse params, call a service, shape { success, data }
   ├─ services/      business logic and authorisation on loaded records
   │    marketRouteService (route comparison) · fulfilmentService (terms + cost estimates)
   │    harvestMatchService (pure scoring + persistence) · allocationService (locked transactions)
   │    recoveryService · rescueService · analyticsService · riskService · campaignService
   │    openaiService (copy only) · whatsappService (mock/live) · auditService · notificationService
   ├─ models/        shared batch queries + DTOs (public DTO hides minimum price)
   └─ config/        env, pg pool, transparent business rules (rules.js)
   ▼
 PostgreSQL ── tables + views: batch_stock (single source of truth for stock), rescue_stock
```

**Stock integrity.** Remaining stock is never stored as a counter. It is derived by the `batch_stock` view from ACTIVE allocations and Rescue listings. Every allocation runs inside a transaction that first locks the batch row (`SELECT … FOR UPDATE`) and then re-reads stock, so concurrent approvals cannot over-allocate. A test proves this. Cancelling an order releases its allocations and restores availability and demand fulfilment.

## Project structure

```
tyllage/
├── client/                     React + Vite SPA
│   └── src/
│       ├── components/         ui.jsx, domain.jsx (risk/coverage/score), Icons.jsx, farm/ (HarvestMatch, Recovery, Rescue forms)
│       ├── context/            Auth, active Farm, Toast
│       ├── hooks/              useApi
│       ├── layouts/            AppShell (role-based navigation), AuthLayout
│       ├── pages/              auth/, farm/, buyer/, consumer/, admin/
│       ├── services/api.js     fetch wrapper (VITE_API_URL aware)
│       ├── styles/global.css   design tokens and components
│       └── utils/format.js
├── server/
│   ├── src/
│   │   ├── config/             env.js, db.js, rules.js
│   │   ├── controllers/        index.js
│   │   ├── db/                 migrate.js, migrations/ (001 baseline, 002 proposal features, 003 MarketRoute, 004 Shop and Buyer Growth, 005 demo-label clean-up)
│   │   ├── middleware/         auth.js (verifyToken, requireRole, requireFarmAccess), errorHandler.js
│   │   ├── models/             harvestModel.js
│   │   ├── routes/             one router per API group
│   │   ├── seed/seed.js        ComCrop pilot data (fictional)
│   │   ├── services/           business logic (see above)
│   │   ├── utils/
│   │   ├── app.js              Express app factory
│   │   └── server.js           boot: migrations, then listen on PORT
│   └── tests/                  node:test suites
├── .env.example
├── docker-compose.yml          optional local Postgres
├── railway.json
└── package.json                root scripts for Railway / convenience
```

---

## Local setup

### Prerequisites

- Node.js **22.9+** (`.nvmrc` provided)
- PostgreSQL 14+ (local install, or `docker compose up -d`)

### 1. Install

```bash
npm run install:all
```

### 2. Database

Create two databases: one for the app and one disposable database for tests.

```bash
createdb tyllage
```

```bash
createdb tyllage_test
```

With Docker instead: `docker compose up -d` starts Postgres on port 5432 with user/password `tyllage` and creates both databases.

### 3. Environment variables

```bash
cp .env.example server/.env
```

Then edit `server/.env`:

| Variable | Required | Notes |
|---|---|---|
| `NODE_ENV` | – | `development` / `production` / `test` |
| `PORT` | – | Default 4000; Railway injects it |
| `DATABASE_URL` | **yes (prod)** | Postgres connection string |
| `DATABASE_SSL` | – | `true` if your Postgres requires SSL |
| `TEST_DATABASE_URL` | for tests | **Wiped on every test run**. Separate database; name must end in `_test` or start with `test_` |
| `JWT_SECRET` | **yes (prod)** | ≥ 32 random chars in production (the server refuses to start otherwise) |
| `JWT_EXPIRES_IN` | – | Default `8h` |
| `OPENAI_API_KEY` | – | Absent: deterministic template copy (mock mode) |
| `OPENAI_MODEL` | – | Default `gpt-4.1-mini` |
| `WHATSAPP_ACCESS_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID` | – | Absent: mock mode (payloads logged with masked numbers, never sent) |
| `WHATSAPP_VERIFY_TOKEN` | – | For the Meta webhook verification handshake |
| `CLIENT_URL` | – | CORS allow-list (comma-separated). Not needed when Express serves the client |
| `APP_TIMEZONE` | – | Default `Asia/Singapore`; business dates are Singapore calendar days |

Client build-time variables go in `client/.env` (see `client/.env.example`). They are baked into the build, so redeploy after changing them:

| Variable | Notes |
|---|---|
| `VITE_API_URL` | Only when the API is on another host; the default is same-origin `/api` |
| `VITE_SHOW_DEMO_ACCOUNTS` | `true` shows the demo-account picker on the login page |
| `VITE_WHATSAPP_NUMBER` | Digits in international format; shows the WhatsApp chat button on the public website. Leave empty to hide it |

Never commit `.env` files. They are git-ignored.

### 4. Migrate and seed the pilot demo

```bash
npm run migrate
```

```bash
npm run seed
```

`npm run seed` only seeds an empty database. In development, to wipe and reseed, run `npm run seed --prefix server -- --force`, or reset everything with `npm run db:reset --prefix server`. Initial demo seeding in production requires `ALLOW_DEMO_SEED=true`. **Reset, truncate and forced reseeding are always refused in production**, even with that flag.

Seed dates are **relative to today**, so the demo always shows an at-risk Kale batch being harvested today.

### 5. Run

Backend (http://localhost:4000, auto-reload):

```bash
npm run dev:server
```

Frontend (http://localhost:5173, proxies `/api` to :4000):

```bash
npm run dev:client
```

Production-style single process (build the client, then let Express serve it on :4000):

```bash
npm run build && npm start
```

### Demo accounts

All demo accounts share the password **`TyllageDemo2026!`** (defined in `server/src/seed/seed.js`). This is demo-only. Never reuse it.

| Role | Email | Use it to… |
|---|---|---|
| farm_admin | `farmadmin@comcrop.demo` | Run the full demo story |
| farm_staff | `staff@comcrop.demo` | Update harvests and fulfilment (no approvals or pricing) |
| platform_admin | `admin@tyllage.demo` | Manage farms and users, switch between farms |
| farm_admin (Farm B) | `farmb@tyllage.demo` | Verify multi-farm isolation |
| business_buyer | `restaurant@tyllage.demo`, `hotel@tyllage.demo` | Register demand, see matches and orders |
| consumer | `consumer@tyllage.demo` | Shop farm packs, earn and redeem rewards, reserve Rescue produce, join Community Drops |

In development builds the login page also shows a one-click demo-account picker.

---

## The MVP demo story

1. Sign in as **farmadmin@comcrop.demo**. The **Demand Radar** shows coverage by produce (proposal §8.1) and **Kale: 70kg expected, 24kg confirmed, 34.3% coverage, HIGH risk, 46kg unallocated**, with MarketRoute's recommended route.
2. Click **Compare routes**. MarketRoute scores every route for the 46kg: Hotels & caterers (Hotel B, 18kg, buyer pickup), Restaurants & cafés (Restaurant A, 15kg, farm delivery at about $1.20/kg), Community & D2C (11kg), Wholesale and Retail (no eligible demand yet, so **Draft outreach**), and Rescue. Each route shows its price, fulfilment terms and cost, margin after fulfilment, and a **Why** breakdown. The route plan fills 18 → 15 → 11 → 2kg (Rescue).
3. **Select & match** the recommended route. It is recorded as the **primary route**, and HarvestMatch ranks only that route's buyers. Caterer E is listed as not recommended because its price is below the farm minimum.
4. Choose **Review & approve**. Review revenue, fulfilment cost and net contribution for the entered quantity. Below-target margins require a reason and acknowledgement, saved in the audit log. The order records its fulfilment terms, estimated fulfilment cost and effective buyer required date.
5. Click **Recover demand**. The ladder moves to **Alternative route**: Restaurants & cafés and Community & D2C can absorb the rest, with Rescue for the final kilograms.
6. Create the Rescue listing (the farm must tick the suitability-for-sale confirmation) and **Generate Rescue campaign** in Tyllage Connect. Sending is a separate, explicit step; in mock mode messages appear in **Connect → WhatsApp message log**.
7. Sign in as **consumer@tyllage.demo** and open **Tyllage Shop**. Pick a farm, choose a pickup offer and check out (payment is simulated). Points are added when the farm marks the order completed.
8. As **restaurant@tyllage.demo**, open **Orders**: report an issue on a completed order, or **Buy again** to reorder at today's prices. Then sign in as **admin@tyllage.demo** and resolve the issue in **Platform → Disputes**.
9. **Insights** shows route performance (net margin after fulfilment, cancellation rate, recovered kg), coverage by crop, buyer reorders and the seven pilot KPIs against baselines the farm records.

## Business rules (transparent, configurable in `server/src/config/rules.js` and live in Admin → Policies)

**MarketRoute: Commercial Route Score** (sum 100; `server/src/services/marketRouteService.js`):

| Factor | Weight | Rule |
|---|---|---|
| Demand fit | 25 | Share of the unallocated quantity that eligible open demand in the route can absorb (same exclusions as HarvestMatch). Rescue uses a fixed, conservative 20 |
| Price | 15 | Achievable price ≥ preferred = 100; minimum..preferred scales 50–100; below the farm minimum scales 0–40 |
| Margin | 20 | Margin after production cost **and estimated fulfilment cost**; loss = 0; twice the farm minimum margin (at least 20%) = 100; unknown cost = neutral |
| Volume | 10 | Average order size ÷ 20kg (fewer, larger orders = fewer fulfilment runs) |
| Logistics | 10 | Buyer pickup 100 · central drop 75 · collection point 65 · farm delivery 50 |
| Reliability | 10 | Quantity-weighted buyer reliability (neutral without history) |
| Urgency | 10 | Route lead time vs remaining shelf-life window: within half = 100, within = 70, beyond = 30 |

Routes with live demand use the actual requests (price, buyer's fulfilment terms, required dates). Routes without demand use a documented route profile (typical price share, order size, lead time, default fulfilment) and offer **outreach** instead. A route that sells below cost after fulfilment is **Not viable**. A route excluded by the batch's commercial constraints (allowed routes) is **Excluded**. Past the shelf-life window, only a final disposition is suggested.

**Fulfilment terms and cost**: buyer pickup (buyer logistics), central drop (shared with a distribution partner), collection point and farm delivery (farm logistics). Each farm records per-order and per-kg cost estimates in **Settings**; until then demo defaults apply. Every order stores its estimated fulfilment cost, which is never shown to buyers.

**Recovery stages**: PRIMARY while the farm's primary route still has strong demand, ALTERNATIVE when only other routes do, then RESCUE, and finally FINAL_DISPOSITION once produce is past its commercial window.

**HarvestMatch weights** (sum 100):

| Factor | Weight | Rule |
|---|---|---|
| Produce match | 30 | Exact = 100; close name (e.g. "Baby Kale" vs "Kale") = 75; otherwise excluded |
| Date | 20 | 0–2 days after harvest = 100; 3–4 = 75; later = 45 (with a warning). Past demand, dates before harvest, or beyond the earlier of crop shelf life and the policy freshness window (default 7 days) are excluded. Recurrence advances from today or harvest, whichever is later; monthly dates preserve their original day-of-month anchor |
| Price | 20 | Buyer max ≥ preferred = 100; between min and preferred scales 50–100; no price = 70 with a warning; below the farm minimum = **excluded** |
| Quantity | 10 | Fits remaining supply = 100; partial supply scales down |
| Reliability | 10 | Completed ÷ (completed + buyer cancellations). **Neutral 60** with fewer than 2 past orders. No invented history |
| Location | 10 | Same region 100, neighbouring 75, distant 50, unknown 60; ×0.4 if the farm doesn't offer the buyer's collection method |

Recommended quantities are assigned greedily in score order, so their total never exceeds unallocated stock. Re-running supersedes unactioned suggestions.

**Exclusions** (HarvestMatch and Recovery): cancelled, fulfilled and expired demand; demand the farm already rejected for this batch; buyers who cancelled an order on this batch; incompatible price, date or produce. Recovery treats matches scoring ≥ 70 as "strong" demand.

**Analytics formulas** (`server/src/services/analyticsService.js`):

| Metric | Formula |
|---|---|
| Sell-through | Sold quantity (confirmed/ready/completed) ÷ actual harvest (batches harvested to date) × 100 |
| Average margin / kg | Σ ((unit price − production cost) × qty − fulfilment cost) ÷ Σ qty, over sales with a recorded cost |
| Waste / at-risk quantity | Harvest − quantity sold, for batches that are closed or past their shelf-life window |
| Route performance | Per route: revenue, avg price/kg, fulfilment/kg, net margin/kg, cancellation rate, kg sold after recovery started |
| Demand coverage | Confirmed demand ÷ expected harvest (actual once recorded) × 100 |
| Rescue rate | Recovered at-risk produce ÷ total at-risk produce × 100. At-risk = unallocated quantity when Demand Recovery first ran on a batch; recovered = quantity allocated or reserved after that point |
| Channel concentration | Revenue from largest buyer ÷ total revenue × 100 |
| Repeat buyer rate | Buyers with 2+ non-cancelled orders ÷ buyers with 1+ × 100 |
| Match conversion | Approved matches ÷ generated matches (excluding superseded re-runs) × 100 |

## API summary

All responses use `{ "success": true, "data": … }` or `{ "success": false, "message": "…", "code": "ERROR_CODE" }`.

| Group | Endpoints |
|---|---|
| `/api/auth` | `POST /register` (buyer roles only) · `POST /login` · `GET /me` |
| `/api/farms` | `GET /` · `POST /` (platform admin) · `GET/PATCH /:farmId` · `GET /:farmId/dashboard` · `GET /:farmId/team` · `POST /:farmId/users` (platform admin) · `GET/POST /:farmId/buyers` · `GET /:farmId/audit-logs` · `GET /:farmId/whatsapp-log` |
| `/api/produce` | `GET ?farmId` · `POST` · `GET/PATCH /:id` |
| `/api/harvests` | `GET ?farmId` · `POST` · `GET/PATCH /:id` (incl. `allowedRoutes`) · `POST /:id/mark-available` · `POST /:id/close` · **`GET /:id/routes`** (MarketRoute) · **`POST /:id/routes/select`** `{ route }` · **`POST /:id/run-matching`** `{ route? }` · **`GET /:id/matches`** |
| `/api/demand` | `GET` (farm: `?farmId`; buyer: own) · `POST` · `GET/PATCH /:id` · `POST /:id/cancel` |
| `/api/matches` | `GET` · `POST /:id/preview` `{ quantity? }` · `POST /:id/approve` `{ quantity?, quoteToken?, marginOverrideReason?, note? }` · `POST /:id/reject` `{ reason? }` |
| `/api/orders` | `GET` · `GET /:id` · `PATCH /:id/status` `{ status, reason? }` · `GET/POST /:id/reorder` (buyers: quote, then reorder at current prices) |
| `/api/recovery` | `GET ?farmId` (candidates and triggers) · `POST /harvests/:id/start` · `GET /harvests/:id` |
| `/api/rescue` | `GET /public` · `GET ?farmId` · `POST` · `PATCH /:id` · `POST /:id/cancel` · `POST /:id/reserve` |
| `/api/campaigns` | `GET ?farmId` · `POST /generate` (optional `targetRoute`) · `GET/PATCH /:id` · `POST /:id/approve` · `POST /:id/send` · `POST /:id/cancel` |
| `/api/analytics` | `GET ?farmId` |
| `/api/community-drops` | `GET /upcoming` · `GET ?farmId` · `POST` · `PATCH /:id/status` · `POST /:id/join` |
| `/api/marketplace` | `GET /supply` · `GET /farms` (public; never exposes minimum prices) |
| `/api/users` | `GET` · `PATCH /:id/active` (platform admin) |
| `/api/farmpool` | `GET ?farmId` · `POST /:demandId/contribute` (Phase 3 preview: 409 `FEATURE_NOT_ENABLED` until enabled) |
| `/api/demandpool` | `GET ?farmId` · `GET /suggestions?farmId` · `POST` (Phase 3 preview) |
| `/api/orders` (new) | `POST` direct/bulk order (buyers) · `POST /:id/disputes` |
| `/api/disputes` | `GET` (own/farm/all) · `PATCH /:id` (platform admin resolves) |
| `/api/harvests/:id/dispositions` | `GET` · `POST` (donation / alternative use / waste) |
| `/api/analytics` (new) | `GET /comparison?farmId` · `PUT /baselines` |
| `/api/ai` | `GET /status` · `POST /matches/:id/explain` · `POST /insights` · plus `POST /api/campaigns/:id/variations`, `GET /api/rescue/price-suggestion` |
| `/api/admin` | `GET/PATCH /policies` · `GET /audit-logs` (platform admin) |
| `/api/marketplace/farms/:id` | Public farm profile |
| `/api/shop` | `GET /farms/:farmId` (public; active listings only) · `GET /manage?farmId` · `GET /insights?farmId` · `POST /listings` · `POST /listings/:id/close` (farm admin) · `POST /listings/:id/checkout` `{ packs, redeemPoints? }` · `GET /rewards/:farmId` (consumer) |
| `/api/farms/:farmId/buyer-growth` | `GET` · `PATCH /:buyerId` `{ notes, nextFollowUp }` (farm admin; farm-private) |
| misc | `GET /api/health` · `GET /api/features` · `GET/PATCH /api/buyers/me` · `GET /api/notifications` · `POST /api/notifications/:id/read` · `GET/POST /api/whatsapp/webhook` |

### Roles

| Role | Can |
|---|---|
| `platform_admin` | Everything, on every farm; manage farms and users |
| `farm_admin` | Manage farm and produce, harvests, demand, run HarvestMatch, approve/reject, cancel orders, recovery, Rescue, Shop listings, Buyer Growth notes, campaigns, analytics |
| `farm_staff` | Create and update harvests (not prices), fulfil orders (confirm, ready, complete), view farm data. No approvals, cancellations, pricing or campaigns |
| `business_buyer` | Register demand, view supply, matches and own orders, cancel own pending/confirmed orders, reorder, report an issue |
| `consumer` | Browse supply and Rescue, buy from Tyllage Shop, earn and redeem farm rewards, register interests, reserve Rescue, join Community Drops, own orders |

## Proposal v3 coverage

The prototype follows **Tyllage_Proposal_v3** (ComCrop-first validation). Its MVP "must have" list is all built:

| Proposal v3 item | Where in the prototype |
|---|---|
| §8.1 Demand Radar | **Demand Radar** (farm home): coverage by produce (expected / confirmed / unallocated / risk) plus the batch table with potential demand and the recommended route |
| §8.2 MarketRoute and Commercial Route Score | **MarketRoute** page (all exposed batches, route plans, scoring rules, routes compared) and the route comparison on each batch |
| §8.3 HarvestMatch within a route | Selecting a route runs HarvestMatch on that route's buyers. Matches carry their route |
| §8.4 Margin Guard incl. logistics | Farm fulfilment cost estimates (Settings); margin after fulfilment on every route and match; Margin Guard card per batch |
| §8.5 Demand Recovery stages | Recovery panel ladder: Primary → Alternative → Rescue → Final disposition; route plan over the remaining eligible routes |
| §8.6 Tyllage Rescue | Rescue listings with the farm's suitability confirmation |
| §8.7 Tyllage Connect | **Connect**: approved outreach, optionally targeted at one route's buyers ("Draft outreach" on a route without demand) |
| §8.8 Tyllage Insights | **Insights**: route performance, coverage by crop, buyer reorders, revenue trends |
| §7.1 Commercial constraints | Allowed routes per batch, minimum price, production cost, grade |
| §12 Pilot success framework | Insights → the seven headline KPIs with the proposal's definitions, baseline "To establish" / pilot "To measure"; baselines are entered by the farm, never invented |
| §14 Buyer groups | Restaurants/cafés, hotels/caterers, wholesalers, retailers/**wet markets**, consumers/community |
| §17 Fulfilment terms per route/order | Collection methods incl. **central drop**; estimated fulfilment cost stored per order |
| §13 AI only for copy and explanations | OpenAI drafts outreach and explanations; simulated and labelled without a key. Pricing support is rule-based |

**Post-MVP (proposal v3 §10 / Phase 3): FarmPool and DemandPool** are kept in the codebase as a **Phase 3 preview**. They are off by default: the API returns `409 FEATURE_NOT_ENABLED`, the navigation hides them, and Recovery does not suggest DemandPool. A platform admin can switch the preview on in **Admin → Policies** for demonstrations.

Not built (later phases): shared-logistics optimisation, predictive demand forecasting, AI price optimisation, IoT / computer vision / yield prediction, digital twin / drones, cross-border/export workflows, advanced market-index intelligence.

## HTTP status codes

The client has a designed page for **every standard and common non-standard HTTP status code** (1xx–5xx, 67 codes):

- `/status` — a searchable reference of all codes, grouped by category, marking the 12 the Tyllage API returns and their machine-readable error `code` values.
- `/status/:code` — a preview of the page for any code (e.g. `/status/503`).
- Unknown URLs show the **404** page, role-restricted pages show an inline **403**, and failed page loads show the page for the API status they received (network failures show **503**).
- The API returns **413** `PAYLOAD_TOO_LARGE` for JSON bodies over 100kb and **415** `UNSUPPORTED_MEDIA_TYPE` for non-JSON write requests.

The catalog lives in `client/src/utils/httpStatus.js` and the page in `client/src/components/StatusPage.jsx`.

## Security

- bcrypt password hashing (12 rounds) and JWT bearer auth. The role is re-read from the database on every request, and deactivated users are rejected immediately.
- `verifyToken`, `requireRole` and `requireFarmAccess` on every protected route. A client-supplied `farmId` is always checked against the user's farm memberships. Resource routes (`/:id`) load the record and check its `farm_id` server-side.
- Parameterised SQL only. zod validation on every write. Database constraints back up the business rules (e.g. `min_price ≤ preferred_price`, `rescue_price ≤ original_price`, positive quantities).
- helmet, CORS allow-list, global plus stricter auth rate limits, a 100kb JSON body limit, and sanitised production errors.
- An audit log covers farm-sensitive actions (`HARVEST_CREATED`, `MATCH_APPROVED`, `ORDER_CANCELLED`, `RECOVERY_STARTED`, `RESCUE_CREATED`, `CAMPAIGN_APPROVED`, `SHOP_LISTING_APPROVED`, `SHOP_CHECKOUT`, `BUYER_RELATIONSHIP_UPDATED`, …), written inside the same transaction as the action.
- The public Shop endpoint selects explicit columns and never returns production cost, minimum price, packaging cost or margin. Reward balances are locked (`SELECT … FOR UPDATE`) during checkout so points cannot be spent twice.
- WhatsApp webhook verification only echoes plain challenge tokens (letters, digits, `-` and `_`, up to 128 characters), so it cannot reflect HTML.
- AI guard-rails: OpenAI only receives backend-built context and only returns copy. Generated text is scanned for prices that are not in the approved context, and these are flagged to the reviewer.
- Known MVP trade-offs: the JWT is stored in `localStorage` (move to httpOnly cookies before handling payments), Shop payment is simulated (no card details are collected or stored), and the WhatsApp webhook POST does not yet verify `X-Hub-Signature-256` (add this before processing inbound messages). See [AUDIT.md](AUDIT.md) for all open findings.

## Tests

```bash
npm test
```

This requires `TEST_DATABASE_URL`, a **disposable** database that is dropped and re-seeded per test file. Its name must end in `_test` or start with `test_`; it must not identify `DATABASE_URL`. Production environments are rejected before tests load. GitHub Actions runs the suite against PostgreSQL and builds the client. Tests cover:

- authentication and incorrect credentials
- RBAC and farm access isolation, including spoofed `farmId`
- harvest validation and the minimum-price rule
- demand creation
- HarvestMatch scoring, weights, incompatible-price rejection and the greedy supply cap
- over-allocation protection, including **concurrent approvals**
- current commercial constraints on saved-match approval, private previews, audited margin overrides and changed-quote rejection
- crop-specific shelf life, month-end recurrence, buyer required dates and incompatible units
- negative margin baselines, bounded percentages, and production reset/truncate protection
- cancelled-allocation restoration
- recovery exclusions
- Rescue validation and suitability confirmation
- analytics formulas and "not enough data" handling
- the campaign approve-before-send workflow in mock mode
- the health endpoint
- HTTP 400/413/415 handling
- MarketRoute: route scores and plans, fulfilment cost, margin after fulfilment, commercial constraints, route-scoped HarvestMatch, primary/alternative route decisions, recovery stages, route-targeted outreach, Insights by route, and the v3 pilot KPIs
- the Phase 3 preview gate for FarmPool / DemandPool
- Tyllage Shop: listing approval and Margin Guard, checkout limits, and earning, redeeming and restoring rewards
- WhatsApp webhook verification rejecting challenges that are not plain tokens
- proposal features: shelf-life urgency stages, Margin Guard, minimum order quantities, DemandPool, FarmPool (with partner anonymity), bulk orders, dispositions, the new KPIs, baselines, disputes, platform policies and the AI simulation

## Railway deployment

The repo deploys as **one Railway service** plus a **Railway PostgreSQL** database:

1. Create a Railway project and add **PostgreSQL**.
2. Add a service from this repo (root directory). `railway.json` sets:
   - build: `npm run build:railway` (installs server production deps and the client, then builds the client)
   - start: `npm start` (the server applies pending migrations on boot, then serves the API and `client/dist`)
   - health check: `GET /api/health`
3. Set variables on the service:
   - `NODE_ENV=production`
   - `DATABASE_URL=${{Postgres.DATABASE_URL}}`
   - `JWT_SECRET` (≥ 32 random characters)
   - optionally `OPENAI_API_KEY`, `WHATSAPP_*`
   - `CLIENT_URL` only if the client is hosted elsewhere
4. Optional demo data: set `SEED_DEMO_ON_START=true`. The server seeds the fictional pilot data on boot only when the database has no farms, so restarts never reseed. Set `VITE_SHOW_DEMO_ACCOUNTS=true` to show the demo-account picker on the login page; it is read at build time, so redeploy after setting it.

The frontend never assumes localhost. It calls same-origin `/api`, or `VITE_API_URL` when built for a separate host. Set `RUN_MIGRATIONS_ON_START=false` if you prefer to run `npm run migrate` as a separate release step.

---

## Current MVP scope (proposal v3 Phase 1, ComCrop MVP)

**Built:** auth + RBAC, Demand Radar, harvests and commercial constraints, buyer demand, demand coverage, MarketRoute, HarvestMatch, Margin Guard with fulfilment cost, allocations and orders, Demand Recovery stages, Tyllage Rescue, Tyllage Shop with harvest rewards (simulated payment), Buyer Growth and reorders, disputes, Tyllage Connect (OpenAI/mock, WhatsApp mock/live), Insights and the pilot success framework, buyer and consumer portals, platform admin, public website.

**Phase 3 preview (off by default):** FarmPool, DemandPool.

## Future roadmap (proposal v3 §18)

**Phase 2: Commercial analytics.** Channel performance, buyer behaviour, product performance, repeat demand and margin trends.

**Phase 3: Network expansion.** Onboard additional farms; introduce FarmPool and DemandPool where validated.

**Phase 4: Predictive intelligence.** Demand forecasting, surplus prediction, buyer probability and demand-aware crop planning (optional Python service; Node remains the core backend).

**Phase 5: Farm intelligence.** IoT, computer vision, yield prediction, digital twins or drones as supply-data inputs.

**Long term: exportable AgriTech IP.** Adapt Tyllage software for other high-cost urban-farming ecosystems.

```
Predicted Farm Supply  +  Predicted Buyer Demand
                 ↓
     MarketRoute → HarvestMatch
                 ↓
   Optimal Commercial Allocation
```

---

## Project documents

| Document | Purpose |
|---|---|
| [LICENSE](LICENSE) | Tyllage Proprietary License (all rights reserved) |
| [SECURITY.md](SECURITY.md) | How to report a vulnerability privately |
| [AUDIT.md](AUDIT.md) | Security controls, latest audit results and known limitations |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Outside contributions are not accepted; workflow for Tyllage team members |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | Expected behaviour in project spaces |

## License and ownership

© 2026 Tyllage LLP. All rights reserved.

Tyllage, including its code, designs, business rules and documentation, is proprietary to Tyllage LLP and is shared under the [Tyllage Proprietary License](LICENSE). No licence is granted to use, copy, modify, deploy or redistribute it without Tyllage's prior written permission. GitHub's Terms of Service let you view and fork public repositories on GitHub; that does not give any further right to use this code.

Third-party open-source packages used by Tyllage remain under their own licences.

For licensing or partnership enquiries, contact the team through the [Tyllage GitHub organisation](https://github.com/Tyllage).
