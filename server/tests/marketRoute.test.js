// Proposal v3: MarketRoute, fulfilment terms, route-scoped HarvestMatch, recovery stages and Insights.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, resetDb, login, clearTokens, ACCOUNTS, ids, pool } from './helpers.js';
import { addDays, todayISO } from '../src/utils/dates.js';
import { buyerRoute, orderRoute } from '../src/config/rules.js';
import { estimateFulfilment, resolveMethod, fulfilmentCostsFor } from '../src/services/fulfilmentService.js';
import { marginGuard } from '../src/services/marginService.js';
import { assessRoutes, routePriceScore, routeMarginScore, routeUrgencyScore, sellWindowDays } from '../src/services/marketRouteService.js';
import { recoveryStage } from '../src/services/recoveryService.js';
import { routePerformance, notCommercialised, averageMarginPerKg } from '../src/services/analyticsService.js';

const T = todayISO();

const batch = (over = {}) => ({
  id: 1, farm_id: 1, produce_id: 1, produce_name: 'Kale', unit: 'kg', harvest_date: T, shelf_life_days: 7, status: 'AVAILABLE',
  remaining_quantity: 40, preferred_price: 14, min_price: 10, production_cost: 7, min_margin_pct: 15,
  fulfilment_methods: ['FARM_PICKUP', 'CENTRAL_DROP', 'COMMUNITY_DROP', 'DELIVERY'], fulfilment_costs: {}, farm_region: 'NORTH',
  min_order_quantity: 0, allowed_routes: null, primary_route: null, ...over,
});
let demandId = 0;
const demand = (buyerType, over = {}) => ({
  id: ++demandId, buyer_id: demandId, organisation_name: `${buyerType} ${demandId}`, buyer_type: buyerType, produce_id: 1, produce_name: 'Kale',
  quantity: 10, fulfilled_quantity: 0, required_date: addDays(T, 1), max_price: 14, recurrence: 'NONE', region: 'NORTH',
  preferred_collection_method: 'FARM_PICKUP', ...over,
});
const byKey = (a) => Object.fromEntries(a.routes.map((r) => [r.key, r]));

describe('MarketRoute — unit rules', () => {
  it('maps buyer types to commercial routes; Rescue sales count as the Rescue route', () => {
    assert.equal(buyerRoute('CAFE'), 'RESTAURANT');
    assert.equal(buyerRoute('CATERER'), 'INSTITUTIONAL');
    assert.equal(buyerRoute('WET_MARKET'), 'RETAIL');
    assert.equal(buyerRoute('WHOLESALER'), 'WHOLESALE');
    assert.equal(buyerRoute('CONSUMER'), 'COMMUNITY_D2C');
    assert.equal(orderRoute('RESCUE', 'RESTAURANT'), 'RESCUE');
  });

  it('estimates fulfilment cost from the farm figures, falling back to defaults', () => {
    const own = { DELIVERY: { perOrder: 20, perKg: 0.5 } };
    assert.deepEqual(estimateFulfilment('DELIVERY', 10, own), { method: 'DELIVERY', responsibility: 'FARM', total: 25, perKg: 2.5 });
    assert.equal(estimateFulfilment('FARM_PICKUP', 10, own).total, 0);
    assert.equal(fulfilmentCostsFor(own).CENTRAL_DROP.perOrder, 8);
    assert.equal(resolveMethod('DELIVERY', ['FARM_PICKUP']), 'FARM_PICKUP');
  });

  it('Margin Guard nets out fulfilment cost', () => {
    const g = marginGuard({ unitPrice: 10, cost: 7, minMarginPct: 15, fulfilment: 1.5 });
    assert.equal(g.perUnit, 1.5);
    assert.equal(g.status, 'OK');
    assert.equal(marginGuard({ unitPrice: 10, cost: 7, minMarginPct: 15, fulfilment: 2 }).status, 'BELOW_MINIMUM');
    assert.equal(marginGuard({ unitPrice: 10, cost: 7, minMarginPct: 15, fulfilment: 4 }).status, 'LOSS');
  });

  it('scores price, margin and urgency transparently', () => {
    assert.equal(routePriceScore(14, 10, 14), 100);
    assert.equal(routePriceScore(12, 10, 14), 75);
    assert.equal(routePriceScore(5, 10, 14), 20);
    assert.equal(routeMarginScore({ known: false }, 60), 60);
    assert.equal(routeMarginScore({ known: true, status: 'LOSS', pct: -5, minMarginPct: 15 }, 60), 0);
    assert.equal(routeMarginScore({ known: true, status: 'OK', pct: 15, minMarginPct: 15 }, 60), 50);
    assert.equal(routeUrgencyScore(1, 6), 100);
    assert.equal(routeUrgencyScore(5, 6), 70);
    assert.equal(routeUrgencyScore(8, 6), 30);
    assert.equal(sellWindowDays({ harvest_date: addDays(T, -3), shelf_life_days: 7 }), 4);
  });

  it('prefers the route with demand and margin, and plans the remaining quantity route by route', () => {
    const a = assessRoutes(batch(), [
      demand('RESTAURANT', { quantity: 25, max_price: 14 }),
      demand('WHOLESALER', { quantity: 40, max_price: 10.5, preferred_collection_method: 'CENTRAL_DROP' }),
    ], { exclusions: new Map(), reliability: new Map() });
    const r = byKey(a);
    assert.equal(a.routes.length, 6);
    assert.equal(r.RESTAURANT.coverableQuantity, 25);
    assert.equal(r.WHOLESALE.coverableQuantity, 40);
    assert.equal(r.RETAIL.status, 'NO_DEMAND');
    assert.equal(r.RETAIL.action, 'OUTREACH');
    // Every factor contributes; the score is their weighted sum.
    const sum = Object.values(r.RESTAURANT.breakdown).reduce((s, f) => s + f.contribution, 0);
    assert.equal(Math.round(sum), r.RESTAURANT.score);
    // The plan never routes more than is unallocated.
    assert.equal(a.plan.reduce((s, p) => s + p.quantity, 0), 40);
    assert.equal(a.plan[0].route, a.recommendedRoute);
  });

  it('flags a route that sells below cost after fulfilment as not viable', () => {
    const a = assessRoutes(batch({ fulfilment_costs: { DELIVERY: { perOrder: 80, perKg: 1 } } }), [
      demand('RETAILER', { quantity: 10, max_price: 10, preferred_collection_method: 'DELIVERY' }),
    ], { exclusions: new Map(), reliability: new Map() });
    const retail = byKey(a).RETAIL;
    assert.equal(retail.margin.status, 'LOSS');
    assert.equal(retail.status, 'NOT_VIABLE');
    assert.notEqual(a.recommendedRoute, 'RETAIL');
  });

  it('respects commercial constraints and the shelf-life window', () => {
    const constrained = assessRoutes(batch({ allowed_routes: ['RESTAURANT', 'RESCUE'] }), [demand('WHOLESALER', { quantity: 40, max_price: 12 })], {});
    assert.equal(byKey(constrained).WHOLESALE.status, 'EXCLUDED');
    assert.equal(constrained.recommendedRoute, 'RESCUE');

    const late = assessRoutes(batch({ harvest_date: addDays(T, -10) }), [], {});
    assert.ok(late.routes.every((r) => r.status === 'PAST_WINDOW'));
    assert.equal(late.recommendedRoute, null);
    assert.deepEqual(late.plan.map((p) => p.route), ['FINAL_DISPOSITION']);
  });

  it('recovery stages follow Primary → Alternative → Rescue → Final disposition', () => {
    const strong = { potentialStrongTotal: 10, potentialByRoute: { RESTAURANT: 0, INSTITUTIONAL: 10 }, remainingAfterStrong: 5 };
    assert.equal(recoveryStage(strong, { primaryRoute: 'INSTITUTIONAL' }), 'PRIMARY');
    assert.equal(recoveryStage(strong, { primaryRoute: 'RESTAURANT' }), 'ALTERNATIVE');
    assert.equal(recoveryStage({ potentialStrongTotal: 0, remainingAfterStrong: 5 }, {}), 'RESCUE');
    assert.equal(recoveryStage({ potentialStrongTotal: 0, remainingAfterStrong: 5 }, { routingStage: 'DONATION' }), 'FINAL_DISPOSITION');
    assert.equal(recoveryStage({ potentialStrongTotal: 0, remainingAfterStrong: 0 }, {}), null);
  });

  it('Insights: route performance, margin after fulfilment and unsold quantity', () => {
    const at = new Date('2030-01-02T00:00:00Z');
    const rows = routePerformance([
      { orderId: 1, source: 'HARVESTMATCH', status: 'COMPLETED', buyerType: 'RESTAURANT', batchId: 1, quantity: 10, unitPrice: 14, cost: 7, fulfilment: 10, createdAt: '2030-01-01T00:00:00Z' },
      { orderId: 2, source: 'RECOVERY', status: 'CONFIRMED', buyerType: 'HOTEL', batchId: 1, quantity: 5, unitPrice: 12, cost: 7, fulfilment: 0, createdAt: '2030-01-03T00:00:00Z' },
      { orderId: 3, source: 'HARVESTMATCH', status: 'CANCELLED', buyerType: 'HOTEL', batchId: 1, quantity: 5, unitPrice: 12, cost: 7, fulfilment: 0, createdAt: '2030-01-01T00:00:00Z' },
      { orderId: 4, source: 'RESCUE', status: 'CONFIRMED', buyerType: 'CONSUMER', batchId: 1, quantity: 2, unitPrice: 8, cost: 7, fulfilment: 0, createdAt: '2030-01-03T00:00:00Z' },
    ], new Map([[1, at]]));
    const r = Object.fromEntries(rows.map((x) => [x.route, x]));
    assert.equal(r.RESTAURANT.netMarginPerKg, 6); // (14 − 7) × 10 − 10 fulfilment = 60 / 10kg
    assert.equal(r.INSTITUTIONAL.cancellationRate, 50);
    assert.equal(r.INSTITUTIONAL.recoveredQuantity, 5);
    assert.equal(r.RESCUE.quantity, 2);
    assert.equal(r.WHOLESALE.averagePricePerKg, null);

    assert.equal(notCommercialised([{ harvest: 50, sold: 46 }, { harvest: 20, sold: 25 }]).value, 4);
    assert.equal(notCommercialised([]).sufficient, false);
    assert.equal(averageMarginPerKg([{ quantity: 10, unitPrice: 14, cost: 7, fulfilment: 10 }]).value, 6);
  });
});

describe('MarketRoute — API flow', () => {
  let I;
  let admin;
  before(async () => {
    clearTokens();
    await resetDb();
    I = await ids();
    admin = await login(ACCOUNTS.farmAdmin);
  });
  after(clearTokens);

  it('compares every route for the at-risk Kale batch, with reasons and exclusions', async () => {
    const res = await api().get(`/api/harvests/${I.kale}/routes`).set('Authorization', admin);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const a = res.body.data;
    const r = byKey(a);
    assert.equal(a.remainingQuantity, 46);
    assert.equal(a.routes.length, 6);
    assert.equal(r.RESTAURANT.coverableQuantity, 15);
    assert.equal(r.INSTITUTIONAL.coverableQuantity, 18);
    assert.equal(r.COMMUNITY_D2C.coverableQuantity, 11);
    // Caterer E's price is below the farm minimum; Wholesaler H cancelled on this batch.
    assert.ok(r.INSTITUTIONAL.excluded.some((e) => e.buyerName === 'Caterer E' && /below farm minimum/.test(e.reason)));
    assert.equal(r.WHOLESALE.status, 'NO_DEMAND');
    assert.ok(r.WHOLESALE.excluded.some((e) => /cancelled/.test(e.reason)));
    assert.ok(['RESTAURANT', 'INSTITUTIONAL', 'COMMUNITY_D2C'].includes(a.recommendedRoute));
    assert.equal(a.plan.reduce((s, p) => s + p.quantity, 0), 46);
    for (const route of a.routes) assert.ok(route.reasons.length >= 5, route.key);
    // Fulfilment terms are explicit, never assumed farm delivery.
    assert.equal(r.WHOLESALE.fulfilment.method, 'CENTRAL_DROP');
    assert.equal(r.INSTITUTIONAL.fulfilment.responsibility, 'BUYER');
  });

  it('farm staff can see routes but only farm admins select them', async () => {
    const staff = await login(ACCOUNTS.farmStaff);
    assert.equal((await api().get(`/api/harvests/${I.kale}/routes`).set('Authorization', staff)).status, 200);
    assert.equal((await api().post(`/api/harvests/${I.kale}/routes/select`).set('Authorization', staff).send({ route: 'RESTAURANT' })).status, 403);
    const farmB = await login(ACCOUNTS.farmBAdmin);
    assert.equal((await api().get(`/api/harvests/${I.kale}/routes`).set('Authorization', farmB)).status, 403);
  });

  it('selecting a route runs HarvestMatch within it, and records the decision', async () => {
    const res = await api().post(`/api/harvests/${I.kale}/routes/select`).set('Authorization', admin).send({ route: 'RESTAURANT' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { stage, matching } = res.body.data;
    assert.equal(stage, 'PRIMARY');
    const suggested = matching.matches.filter((m) => m.status === 'SUGGESTED');
    assert.deepEqual(suggested.map((m) => m.buyerName), ['Restaurant A']);
    assert.equal(suggested[0].marketRoute, 'RESTAURANT');
    assert.ok(suggested[0].fulfilment.method);
    assert.ok(suggested[0].netMargin.known);
    assert.equal(matching.run.marketRoute, 'RESTAURANT');
    assert.equal((await pool.query('SELECT primary_route FROM harvest_batches WHERE id = $1', [I.kale])).rows[0].primary_route, 'RESTAURANT');

    // Approve: the order records an estimated fulfilment cost (farm-private).
    const ok = await api().post(`/api/matches/${suggested[0].id}/approve`).set('Authorization', admin).send({});
    assert.equal(ok.status, 200);
    const order = (await pool.query('SELECT fulfilment_cost, collection_method FROM orders WHERE id = $1', [ok.body.data.orderId])).rows[0];
    assert.ok(Number(order.fulfilment_cost) >= 0);
    const restaurant = await login(ACCOUNTS.restaurant);
    const mine = (await api().get(`/api/orders/${ok.body.data.orderId}`).set('Authorization', restaurant)).body.data;
    assert.equal(mine.fulfilmentCost, undefined);
    assert.ok(!(await api().get('/api/orders').set('Authorization', restaurant)).body.data.some((o) => 'fulfilmentCost' in o));

    // A different route after the primary route has sold is an alternative route.
    const alt = await api().post(`/api/harvests/${I.kale}/routes/select`).set('Authorization', admin).send({ route: 'INSTITUTIONAL' });
    assert.equal(alt.body.data.stage, 'ALTERNATIVE');
    assert.deepEqual(alt.body.data.matching.matches.filter((m) => m.status === 'SUGGESTED').map((m) => m.buyerName), ['Hotel B']);
    const audit = await pool.query(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE action = 'ROUTE_SELECTED' AND entity_id = $1`, [I.kale]);
    assert.equal(audit.rows[0].n, 2);
    const routes = (await api().get(`/api/harvests/${I.kale}/routes`).set('Authorization', admin)).body.data;
    assert.equal(routes.selections.length, 2);
    assert.equal(routes.primaryRoute, 'RESTAURANT');
  });

  it('rejects matching within Rescue and routes excluded by commercial constraints', async () => {
    const rescue = await api().post(`/api/harvests/${I.kale}/run-matching`).set('Authorization', admin).send({ route: 'RESCUE' });
    assert.equal(rescue.status, 409);

    const staff = await login(ACCOUNTS.farmStaff);
    assert.equal((await api().patch(`/api/harvests/${I.naiBai}`).set('Authorization', staff).send({ allowedRoutes: ['RETAIL'] })).status, 403);
    assert.equal((await api().patch(`/api/harvests/${I.naiBai}`).set('Authorization', staff).send({ notes: 'staff edit' })).status, 200);
    const patched = await api().patch(`/api/harvests/${I.naiBai}`).set('Authorization', admin).send({ allowedRoutes: ['RETAIL', 'RESCUE'] });
    assert.deepEqual(patched.body.data.allowedRoutes, ['RETAIL', 'RESCUE']);
    const blocked = await api().post(`/api/harvests/${I.naiBai}/routes/select`).set('Authorization', admin).send({ route: 'WHOLESALE' });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'ROUTE_EXCLUDED');
    const cleared = await api().patch(`/api/harvests/${I.naiBai}`).set('Authorization', admin).send({ allowedRoutes: [] });
    assert.equal(cleared.body.data.allowedRoutes, null);
    assert.equal((await api().post(`/api/harvests/${I.naiBai}/routes/select`).set('Authorization', admin).send({ route: 'NOT_A_ROUTE' })).status, 400);
  });

  it('Demand Radar shows the recommended route per batch and a per-produce summary', async () => {
    const d = (await api().get(`/api/farms/${I.comcrop}/dashboard`).set('Authorization', admin)).body.data;
    const kale = d.upcomingHarvest.find((b) => b.id === I.kale);
    assert.ok(kale.marketRoute.recommendedRoute);
    assert.ok(kale.marketRoute.label);
    const names = d.radar.map((p) => p.produceName).sort();
    assert.deepEqual(names, ['Kale', 'Lettuce', 'Mint', 'Nai Bai', 'Sweet Basil']);
    for (const p of d.radar) assert.ok(['LOW', 'MEDIUM', 'HIGH'].includes(p.riskLevel));
  });

  it('recovery reports its stage and compares the remaining eligible routes', async () => {
    const rec = (await api().post(`/api/recovery/harvests/${I.kale}/start`).set('Authorization', admin).send({})).body.data.recovery;
    assert.ok(['PRIMARY', 'ALTERNATIVE', 'RESCUE'].includes(rec.stage));
    assert.equal(rec.primaryRoute, 'RESTAURANT');
    assert.ok(Array.isArray(rec.routes) && rec.routes.length === 6);
    assert.ok(Array.isArray(rec.plan));
  });

  it('Tyllage Connect outreach can target the buyers of one route', async () => {
    const res = await api().post('/api/campaigns/generate').set('Authorization', admin)
      .send({ farmId: I.comcrop, campaignType: 'B2B_AVAILABILITY', harvestBatchId: I.kale, targetRoute: 'INSTITUTIONAL' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.match(res.body.data.title, /Hotels & caterers/);
    assert.equal(res.body.data.context.targetRoute, 'INSTITUTIONAL');
    // Hotel B is opted in; Caterer E is not.
    assert.equal(res.body.data.recipientsPreview, 1);
    const bad = await api().post('/api/campaigns/generate').set('Authorization', admin)
      .send({ farmId: I.comcrop, campaignType: 'B2B_AVAILABILITY', harvestBatchId: I.kale, targetRoute: 'RESCUE' });
    assert.equal(bad.status, 400);
  });

  it('farm admins record their own fulfilment costs', async () => {
    const res = await api().patch(`/api/farms/${I.comcrop}`).set('Authorization', admin)
      .send({ fulfilmentCosts: { DELIVERY: { perOrder: 30, perKg: 0.5 } } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.effectiveFulfilmentCosts.DELIVERY.perOrder, 30);
    assert.equal(res.body.data.effectiveFulfilmentCosts.FARM_PICKUP.perOrder, 0);
    const bad = await api().patch(`/api/farms/${I.comcrop}`).set('Authorization', admin).send({ fulfilmentCosts: { DELIVERY: { perOrder: -1, perKg: 0 } } });
    assert.equal(bad.status, 400);
    // Never exposed publicly.
    const pub = (await api().get(`/api/marketplace/farms/${I.comcrop}`)).body.data;
    assert.equal(pub.fulfilmentCosts, undefined);
  });

  it('Insights: route performance, coverage by crop, buyer reorders and the v3 pilot KPIs', async () => {
    const a = (await api().get(`/api/analytics?farmId=${I.comcrop}`).set('Authorization', admin)).body.data;
    assert.equal(a.routePerformance.length, 6);
    const restaurant = a.routePerformance.find((r) => r.route === 'RESTAURANT');
    assert.ok(restaurant.revenue > 0);
    assert.notEqual(restaurant.netMarginPerKg, null);
    assert.ok(a.coverageByProduce.some((p) => p.name === 'Kale' && p.coverage > 0));
    assert.ok(a.buyerReorders.some((b) => b.repeat));
    assert.equal(a.metrics.notCommercialised.sufficient, true); // the closed historical batches

    const cmp = (await api().get(`/api/analytics/comparison?farmId=${I.comcrop}`).set('Authorization', admin)).body.data;
    assert.deepEqual(cmp.rows.filter((r) => r.headline).map((r) => r.label), [
      'Demand Coverage', 'Harvest Sell-Through', 'Demand Recovery Time', 'Average Margin / kg', 'Channel Concentration', 'Match Conversion', 'Waste / At-Risk Quantity',
    ]);
    assert.ok(cmp.rows.every((r) => r.definition));
  });
});
