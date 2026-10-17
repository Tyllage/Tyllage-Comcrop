# Pilot release workflow

This procedure implements the release direction in the supplied Deployment Plan using the repository's existing Railway architecture. It describes a proposed rollout; it is not evidence that a deployment or backup has occurred.

## Local validation

Install the committed dependencies:

```sh
npm ci --prefix server
npm ci --prefix client
```

Create a disposable PostgreSQL database whose name ends with `_test` or starts with `test_`, and set `TEST_DATABASE_URL` in `server/.env` or the shell. Use a different database for `DATABASE_URL`.

```sh
npm test
npm run build
```

Tests reset the disposable database. Setup rejects missing or ordinary database names, identical application/test targets (including common loopback aliases), and a production environment. These checks prevent common configuration mistakes; a database name alone cannot establish that it contains disposable data. Do not provide production credentials to the test runner.

The GitHub Actions workflow `.github/workflows/ci.yml` runs the same tests and build on pull requests and pushes to `main`, with a disposable PostgreSQL service. It does not deploy. Configure repository branch protection to require this job if that is the agreed team release process.

## Staging validation

Use a separate staging app and database. Configure the environment variables documented in the README. Keep messaging and AI credentials absent to exercise the mock paths.

1. Verify that a restoreable backup exists for any database containing non-demo data.
2. Deploy the reviewed commit using `npm run build:railway` and `npm start`; startup applies the existing versioned migrations.
3. Request `/api/health` and confirm database connectivity.
4. Sign in as a farm admin, create a harvest and buyer demand, compare routes, run matching, review an allocation and approve it.
5. Confirm the order's required date, stock balance, private fulfilment estimate and audit record. Reduce the quantity enough to exercise the margin warning; confirm the reason is required.
6. Cancel an eligible order, run recovery and inspect the alternative recommendations. Create a Rescue listing only with the farm suitability confirmation.
7. Verify farm isolation with the second demo farm. Buyer responses must omit farm costs, price floors and private estimates.
8. Check Insights against known records and the agreed metric definitions. A populated dashboard does not prove impact against a comparable pilot baseline.
9. As a farm admin, publish a Tyllage Shop listing and confirm Margin Guard asks for a reason when the price is below target. As a consumer, check out, then complete the order as the farm and confirm reward points are added. Cancel a second order and confirm redeemed points are restored.
10. Report an issue on an order as a buyer, and resolve it as a platform admin. Confirm both parties are notified.

## Production rollout and rollback

Choose the release commit after staging validation. Verify the target environment, JWT secret, demo-account status, backup/restore procedure and integration settings before deploying it. The existing `ALLOW_DEMO_SEED` flag permits initial demo seeding only; it does not bypass production reset/truncate protection. Do not use `db:reset`, `migrate --reset` or `seed --force` in production.

After rollout, repeat health and authorised read checks, then perform the agreed pilot smoke transaction. Review application errors and allocation conflicts. Record the deployed commit and any outstanding limitations.

For an application regression, redeploy the previous verified commit and repeat the smoke checks. Database restoration is a separate operation requiring assessment of transactions made since the backup. Migrations `004_shop_growth` (Shop, rewards and Buyer Growth tables) and `005_remove_demo_labels` (renames seeded records) are applied on startup. Both only add tables and columns or update seeded text, so the previous application commit still runs against the migrated schema; take a backup before deploying if the database holds non-demo data.

Keep live outreach disabled until the farm has approved its audience, consent process and messages. The existing WhatsApp webhook signature finding and other open findings remain documented in `AUDIT.md`.
