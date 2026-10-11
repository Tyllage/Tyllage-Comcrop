# Tyllage proposal alignment and pilot plan

Reviewed 9 October 2026 against the supplied `Tyllage 2.0-20261008T101837Z-1-001.zip` and this repository. The documents are product reference material. Their deployment statements, market claims and budget assumptions have not been independently verified by this code review.

The repository already implements most of the proposed MVP. This update strengthens the step where a recommendation becomes an order, improves recurring-demand dates and baseline validation, and adds automated release checks. It does not establish pilot impact or confirm that ComCrop has agreed to participate.

## Product direction

Keep the first pilot focused on a farm's commercial decisions: harvest, coverage, route comparison, buyer matching, farmer approval, recovery and measurement. Retain the React/Vite, Express and PostgreSQL architecture. The proposal and deployment plan provide no validated need for another infrastructure service at this stage.

The research pack frames logistics cost, fragmented demand and channel differences as the problem to investigate. These are useful design hypotheses. The software must still show where inputs are estimates and distinguish recommendations from orders. No industry statistic or assumed percentage improvement has been added to the application as a result of this review.

## Traceability from documents to implementation

| Reference in the supplied pack | Existing capability | Improvement in this update |
| --- | --- | --- |
| Project Proposal §§7–8; Product Specification §§5.5–5.7 | MarketRoute, HarvestMatch and farm approval | Approval reloads current batch, demand, buyer and commercial settings under transaction locks. Changed prices, routes, incompatible dates or units, and inactive buyers cannot silently become orders. |
| Industry Research §§7, 12; Deployment Plan §10.1 | Fulfilment estimates and Margin Guard | A review dialog recalculates revenue, fulfilment and net contribution for the entered quantity. Below-target margins require an explicit reason and acknowledgement of the current estimate; the backend stores the reason and estimate in the audit log. |
| Product Specification §§5.3, 5.6, 5.8 | Recurring demand and recovery matching | Matching uses the earlier of crop shelf life and the freshness policy. Past one-off demand is excluded. Recurrences advance from today or harvest, whichever is later. Monthly recurrence retains its original day-of-month anchor. Orders use the effective demand date. |
| Product Specification §7.1 | Locked allocations and farm isolation | Approval and matching use the same batch-first lock order. Preview and approval remain farm-admin operations. The estimate is private to the authorised farm. |
| Project Proposal §12; Product Specification §11 | Pilot baselines and database-derived analytics | Negative margin baselines are accepted; negative quantity/time baselines and percentages above 100 are rejected. Percentage comparisons display percentage-point changes. The UI calls the reliability figure a rule-based score rather than a purchase probability. |
| Deployment Plan §§4, 6, 8 | Versioned SQL migrations and local tests | GitHub Actions installs from lockfiles, runs the PostgreSQL test suite and builds the client. Production reset/truncate helpers refuse to run, including forced reseeding. Test setup rejects ordinary database names and obvious aliases of the application database. |
| Funding Breakdown; Deployment Plan §§3, 15 | One app service plus PostgreSQL; mock integrations | No additional paid service, runtime dependency or infrastructure component is introduced. The workbook remains a planning input, not an approved purchase or verified current price list. |
| Logo assets in the archive | Existing wordmark, emblem and favicon assets | Existing branding is retained. The implementation work concerns the commercial workflow. |

## Changed approval behaviour

1. Run HarvestMatch or select a route in MarketRoute.
2. Edit a suggested quantity if needed, then choose **Review & approve**.
3. The server returns the current quantity, selling price, required date, gross revenue, fulfilment estimate and net contribution. Missing production cost is shown as unknown. Default fulfilment estimates are identified when the farm has not recorded its own costs.
4. A known margin below the farm target, including a loss, requires a reason of at least ten characters and acknowledgement. This preserves the farmer's ability to accept a deliberate recovery sale.
5. Approval repeats the checks in a transaction. If the reviewed terms changed, the UI displays the updated estimate and resets the acknowledgement. An invalidated match must be regenerated.
6. Order, allocation, demand fulfilment, match decision and audit entry commit together. The order uses the buyer's effective required date. The in-app buyer notification uses that same date.

Bulk approval still processes independent orders. A match requiring a margin override remains pending and directs the farmer to its individual review. A failure does not roll back other successfully approved orders in the selection.

The shelf-life rule is a commercial eligibility rule. Suitability for sale remains the farm's responsibility. Recurrence still advances the date of a demand request; automatic creation of a fresh quantity entitlement every recurring period remains future work.

## Acceptance walkthrough

Use fictional seed data on a disposable development database.

| Check | Expected result |
| --- | --- |
| Kale → HarvestMatch → Restaurant A → review 5 kg | Gross revenue $65, estimated fulfilment $16, net contribution $14 using the supplied demo settings. |
| Change the same suggestion to 2 kg | Net contribution is −$3.40. Approval requires the farm's reason and acknowledgement. |
| Change fulfilment costs after opening a review | Approval returns an updated estimate and requires another review. |
| Change the batch price floor, allowed routes, buyer maximum price or eligible dates after matching | The saved suggestion cannot bypass current commercial constraints. |
| Approve a valid recurring request | The order date is the next eligible required date, including correct month-end handling. |
| Call the preview as farm staff, a buyer or another farm's admin | HTTP 403; no private estimate is returned. |
| Run matching while approving a suggestion | Operations serialize through the batch lock; a superseded suggestion is rejected. |
| Enter a negative average-margin baseline | Value is retained and can be compared with the current margin. |
| Enter a demand-coverage baseline of 101% | Validation rejects the value. |
| Run reset/truncate with `NODE_ENV=production` | Refused before destructive SQL executes. |

## Remaining pilot work in priority order

These are proposed follow-ups, not features claimed as completed by this update.

1. **Agree the pilot with the farm.** Confirm participating crops, buyer channels, quantity units, price floors, operational owners and data permissions. The pack explicitly treats ComCrop workflows as assumptions to validate. Begin with the proposed small crop and buyer cohort.
2. **Define a comparable measurement period.** The existing Insights dashboard mixes current coverage with historical transaction measures. Add explicit pilot dates, cohort filtering and dated exports before using its baseline comparisons as evidence of pilot impact. Record how the baseline was collected and measure staff effort separately.
3. **Capture commercial inputs consistently.** Record production and fulfilment estimates, packaging treatment, pickup agreements and minimum quantities. Clarify whether unmatched recurring demand represents a single outstanding request or a new requirement every period before introducing recurrence automation.
4. **Validate demand entry before building integrations.** Existing farm-managed buyer demand entry is available. Trial a small manual dataset first, then add a validated CSV import with row-level errors and duplicate detection if interviews show a need. Do not assume access to procurement, SAFEF or messaging data.
5. **Prepare the live operating environment.** Remove public demo access before real data, exercise backup/restore and staging rollout, and address the existing authentication and webhook findings in `AUDIT.md`. Verify consent and messaging requirements before enabling live outreach.
6. **Improve performance using measurements.** The production build currently emits a bundle-size warning. Route-based lazy loading is a suitable follow-up; collect actual dashboard and matching latency on pilot-sized data before adding caches or services.
7. **Expand only after evidence.** Keep FarmPool and DemandPool behind the existing preview policy. The proposal and specification disagree on the order of network expansion versus predictive intelligence; resolve this after the pilot. Forecasting, price optimisation, IoT and automated cross-farm fulfilment remain outside this release.

## Validation record

The existing 118-test suite passed before the changes. The final local run on 10 October 2026 passed all 140 tests across 22 suites, with no failures or skipped tests. Regression coverage was added in `server/tests/pilotReadiness.test.js` for eligibility, commercial reviews, recurrence, concurrency, data isolation, baseline bounds and database protection. Local tests used disposable PostgreSQL 18; CI runs the same suite against PostgreSQL 16.

The production frontend build passed. Vite still reports the existing JavaScript bundle-size warning; route-based lazy loading remains a follow-up.

The approval dialog was exercised in an isolated browser against a separate local demo database at 1440, 768 and 375 px. A below-target margin required both a reason and acknowledgement, and a normal approval created an order successfully. No live outreach was sent. Local validation does not establish Railway deployment, hosted CI execution or a live farm pilot.
