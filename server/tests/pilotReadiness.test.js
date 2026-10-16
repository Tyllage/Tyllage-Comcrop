import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, resetDb, login, clearTokens, ACCOUNTS, ids, runMatch, batchStock, pool } from './helpers.js';
import { addDays, todayISO } from '../src/utils/dates.js';
import { effectiveRequiredDate, scoreDate, rankAndAllocate } from '../src/services/harvestMatchService.js';
import { marginGuard } from '../src/services/marginService.js';
import { assertNonProductionReset, assertTestDatabase } from '../src/db/safety.js';
import { resetDatabase } from '../src/db/migrate.js';
import { truncateAll } from '../src/seed/seed.js';

describe('Pilot commercial rules', () => {
  const today = '2030-01-10';
  const batch = { harvest_date: today, shelf_life_days: 2 };

  it('limits matching to the crop shelf life as well as the policy freshness window', () => {
    assert.match(scoreDate(batch, { required_date: '2030-01-13', recurrence: 'NONE' }, today).exclude, /freshness window/);
    assert.equal(scoreDate(batch, { required_date: '2030-01-12', recurrence: 'NONE' }, today).score, 100);
  });

  it('excludes past demand even when its date used to fit the harvest', () => {
    assert.match(scoreDate({ ...batch, harvest_date: '2030-01-09' }, { required_date: '2030-01-09', recurrence: 'NONE' }, today).exclude, /already passed/);
  });

  it('rolls recurring demand forward from today for already harvested produce', () => {
    const result = scoreDate({ harvest_date: '2030-01-08', shelf_life_days: 7 }, { required_date: '2030-01-02', recurrence: 'WEEKLY' }, today);
    assert.equal(result.required, '2030-01-16');
    assert.match(result.exclude, /freshness window/);
  });

  it('preserves monthly anchors and handles recurrence older than sixty weeks', () => {
    assert.equal(effectiveRequiredDate({ required_date: '2030-01-31', recurrence: 'MONTHLY' }, '2030-02-01'), '2030-02-28');
    assert.equal(effectiveRequiredDate({ required_date: '2030-01-31', recurrence: 'MONTHLY' }, '2030-03-01'), '2030-03-31');
    assert.equal(effectiveRequiredDate({ required_date: '2020-01-01', recurrence: 'WEEKLY' }, '2030-01-10'), '2030-01-16');
    assert.equal(effectiveRequiredDate({ required_date: '2024-01-31', recurrence: 'MONTHLY' }, '2024-02-01'), '2024-02-29');
  });

  it('keeps disallowed routes and incompatible units out of all-route matching', () => {
    const b = { ...batch, produce_id: 1, produce_name: 'Kale', unit: 'kg', min_price: 10, preferred_price: 14, remaining_quantity: 10, allowed_routes: ['RESTAURANT'] };
    const d = { id: 1, produce_id: 1, produce_name: 'Kale', required_date: today, recurrence: 'NONE', quantity: 5, max_price: 14 };
    const result = rankAndAllocate(b, [{ ...d, buyer_type: 'WHOLESALER', unit: 'kg' }, { ...d, id: 2, buyer_type: 'RESTAURANT', unit: 'box' }], { today });
    assert.equal(result.matches.length, 0);
    assert.match(result.excluded[0].reason, /commercial constraints/);
    assert.match(result.excluded[1].reason, /different units/);
  });

  it('uses total fulfilment cost without multiplying a rounded per-unit estimate', () => {
    const margin = marginGuard({ unitPrice: 10, cost: 7, minMarginPct: 15, quantity: 3, fulfilment: 0.33, fulfilmentTotal: 1 });
    assert.equal(margin.total, 8);
    assert.equal(margin.perUnit, 2.67);
    const edge = marginGuard({ unitPrice: 10, cost: 8.504, minMarginPct: 15 });
    assert.equal(edge.status, 'BELOW_MINIMUM'); // display rounding must not change eligibility
  });

  it('blocks destructive production helpers and unsafe test database targets', () => {
    assert.throws(() => assertNonProductionReset('production'), /disabled in production/);
    assert.doesNotThrow(() => assertNonProductionReset('test'));
    assert.throws(() => assertTestDatabase('postgres://u:p@localhost/tyllage'), /disposable/);
    assert.throws(() => assertTestDatabase('postgres://u:p@localhost/tyllage_test', 'postgresql://other:pass@127.0.0.1:5432/tyllage_test'), /application database/);
    assert.doesNotThrow(() => assertTestDatabase('postgres://u:p@localhost/tyllage_test', 'postgres://u:p@localhost/tyllage'));
  });
});

describe('Pilot approval and evidence API', () => {
  let I, admin, match;
  const approve = (body = {}) => api().post(`/api/matches/${match.id}/approve`).set('Authorization', admin).send(body);
  const preview = (body = {}) => api().post(`/api/matches/${match.id}/preview`).set('Authorization', admin).send(body);
  const assertPending = async () => {
    assert.equal((await batchStock(I.kale)).remaining_quantity, 46);
    assert.equal((await pool.query('SELECT status FROM harvest_matches WHERE id = $1', [match.id])).rows[0].status, 'SUGGESTED');
  };
  beforeEach(async () => {
    clearTokens();
    await resetDb();
    I = await ids();
    admin = await login(ACCOUNTS.farmAdmin);
    match = (await runMatch(I.kale, admin)).byBuyer['Restaurant A'];
  });

  it('previews the actual edited quantity, then stores the buyer required date on approval', async () => {
    const res = await preview({ quantity: 5 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const review = res.body.data;
    assert.equal(review.quantity, 5);
    assert.equal(review.revenue, 65);
    assert.equal(review.fulfilment.total, 16);
    assert.equal(review.netMargin.total, 14);
    assert.equal(review.scheduledDate, addDays(todayISO(), 1));
    await assertPending();
    const saved = await approve({ quantity: 5, quoteToken: review.quoteToken });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const order = (await pool.query('SELECT * FROM orders WHERE id = $1', [saved.body.data.orderId])).rows[0];
    assert.equal(order.scheduled_date, review.scheduledDate);
    assert.equal(order.fulfilment_cost, review.fulfilment.total);
    await pool.query("UPDATE demand_requests SET required_date = $1, recurrence = 'WEEKLY' WHERE id = $2", [addDays(todayISO(), 8), match.demandRequestId]);
    const history = await api().get(`/api/harvests/${I.kale}/matches`).set('Authorization', admin);
    assert.equal(history.body.data.matches.find((m) => m.id === match.id).effectiveRequiredDate, review.scheduledDate);
  });

  it('preserves final top-up allocations below minimum order quantities', async () => {
    await pool.query("UPDATE demand_requests SET fulfilled_quantity = 14, status = 'PARTIALLY_FULFILLED' WHERE id = $1", [match.demandRequestId]);
    await pool.query("UPDATE buyer_profiles SET preferred_collection_method = 'FARM_PICKUP' WHERE id = $1", [match.buyerId]);
    const saved = await approve({ quantity: 1 });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const demand = (await pool.query('SELECT status, fulfilled_quantity FROM demand_requests WHERE id = $1', [match.demandRequestId])).rows[0];
    assert.equal(demand.status, 'FULFILLED');
    assert.equal(demand.fulfilled_quantity, 15);
  });

  it('requires a specific reason and current review before accepting a loss', async () => {
    await pool.query('UPDATE farms SET fulfilment_costs = $1 WHERE id = $2', [JSON.stringify({ DELIVERY: { perOrder: 150, perKg: 1 } }), I.comcrop]);
    const blocked = await approve();
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'MARGIN_REVIEW_REQUIRED');
    assert.equal(blocked.body.details.netMargin.status, 'LOSS');
    await assertPending();
    assert.equal((await approve({ marginOverrideReason: 'Recover value from surplus stock' })).body.code, 'MARGIN_REVIEW_REQUIRED');
    const approved = await approve({ quoteToken: blocked.body.details.quoteToken, marginOverrideReason: 'Recover value from surplus stock' });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const audit = (await pool.query("SELECT details FROM audit_logs WHERE action = 'MATCH_APPROVED' AND entity_id = $1", [match.id])).rows[0];
    assert.equal(audit.details.marginOverrideReason, 'Recover value from surplus stock');
    assert.equal(audit.details.netMargin.status, 'LOSS');
  });

  it('recalculates fixed fulfilment costs when a smaller quantity becomes loss-making', async () => {
    assert.equal((await preview()).body.data.requiresMarginOverride, false);
    const small = await preview({ quantity: 2 });
    assert.equal(small.status, 200, JSON.stringify(small.body));
    assert.equal(small.body.data.netMargin.total, -3.4);
    assert.equal(small.body.data.requiresMarginOverride, true);
    assert.equal((await approve({ quantity: 2 })).body.code, 'MARGIN_REVIEW_REQUIRED');
    await assertPending();
  });

  it('production reset and truncate entry points refuse to modify an existing database', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await assert.rejects(resetDatabase(), /disabled in production/);
      await assert.rejects(truncateAll(), /disabled in production/);
    } finally {
      process.env.NODE_ENV = previous;
    }
    await assertPending();
  });

  it('rechecks fulfilment after a preview and refuses an outdated acknowledgement', async () => {
    const review = (await preview()).body.data;
    await pool.query('UPDATE farms SET fulfilment_costs = $1 WHERE id = $2', [JSON.stringify({ DELIVERY: { perOrder: 18, perKg: 1 } }), I.comcrop]);
    const res = await approve({ quoteToken: review.quoteToken });
    assert.equal(res.body.code, 'APPROVAL_QUOTE_CHANGED');
    await assertPending();
  });

  it('rejects saved matches when the farm price floor changes', async () => {
    await pool.query('UPDATE harvest_batches SET min_price = 15, preferred_price = 16 WHERE id = $1', [I.kale]);
    assert.equal((await approve()).body.code, 'MATCH_STALE');
    await assertPending();
  });

  it('rejects saved matches when the buyer changes its maximum price', async () => {
    await pool.query('UPDATE demand_requests SET max_price = 12 WHERE id = $1', [match.demandRequestId]);
    assert.equal((await approve()).body.code, 'MATCH_STALE');
    await assertPending();
  });

  it('enforces allowed routes at matching and approval, even through direct endpoints', async () => {
    await pool.query("UPDATE harvest_batches SET allowed_routes = ARRAY['WHOLESALE'] WHERE id = $1", [I.kale]);
    assert.equal((await approve()).body.code, 'MATCH_STALE');
    const rerun = await api().post(`/api/harvests/${I.kale}/run-matching`).set('Authorization', admin).send({ route: 'RESTAURANT' });
    assert.equal(rerun.body.code, 'ROUTE_EXCLUDED');
    await assertPending();
  });

  it('rejects a buyer whose account was disabled after matching', async () => {
    await pool.query('UPDATE users SET is_active = false WHERE id = (SELECT user_id FROM buyer_profiles WHERE id = $1)', [match.buyerId]);
    assert.equal((await approve()).body.code, 'BUYER_INACTIVE');
    await assertPending();
  });

  it('rejects an expired commercial window after matching', async () => {
    await pool.query('UPDATE harvest_batches SET harvest_date = $1 WHERE id = $2', [addDays(todayISO(), -10), I.kale]);
    assert.equal((await approve()).body.code, 'MATCH_STALE');
    await assertPending();
  });

  it('rolls recurring demand to the next valid date when creating the order', async () => {
    await pool.query("UPDATE demand_requests SET required_date = $1, recurrence = 'WEEKLY' WHERE id = $2", [addDays(todayISO(), -6), match.demandRequestId]);
    const res = await approve();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await pool.query('SELECT scheduled_date FROM orders WHERE id = $1', [res.body.data.orderId])).rows[0].scheduled_date, addDays(todayISO(), 1));
  });

  it('does not leak the private approval estimate to staff, another farm or buyers', async () => {
    for (const email of [ACCOUNTS.farmStaff, ACCOUNTS.farmBAdmin, ACCOUNTS.restaurant]) {
      const res = await api().post(`/api/matches/${match.id}/preview`).set('Authorization', await login(email)).send({});
      assert.equal(res.status, 403);
      assert.equal(res.body.details, undefined);
    }
  });

  it('serializes approval and matching re-runs without deadlocking or double allocation', async () => {
    const results = await Promise.all([
      approve(),
      api().post(`/api/harvests/${I.kale}/run-matching`).set('Authorization', admin).send({}),
    ]);
    assert.equal(results[1].status, 200, JSON.stringify(results[1].body));
    assert.ok([200, 409].includes(results[0].status), JSON.stringify(results[0].body));
    assert.ok((await batchStock(I.kale)).remaining_quantity >= 31);
  });

  it('accepts a negative margin baseline and rejects invalid percentage/quantity baselines', async () => {
    const save = (metricKey, baselineValue) => api().put('/api/analytics/baselines').set('Authorization', admin).send({ farmId: I.comcrop, metricKey, baselineValue });
    const negative = await save('averageMarginPerKg', -2.5);
    assert.equal(negative.status, 200, JSON.stringify(negative.body));
    assert.equal(negative.body.data.rows.find((r) => r.key === 'averageMarginPerKg').baseline, -2.5);
    assert.equal((await save('demandCoverage', 101)).status, 400);
    assert.equal((await save('notCommercialised', -1)).status, 400);
    assert.equal((await save('demandCoverage', 0)).status, 200);
  });
});
