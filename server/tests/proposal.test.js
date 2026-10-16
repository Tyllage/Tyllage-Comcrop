// Features from the Tyllage proposal documents (Final + earlier Proposal).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, resetDb, login, clearTokens, ACCOUNTS, ids, runMatch, batchStock, pool } from './helpers.js';
import { addDays, todayISO } from '../src/utils/dates.js';
import { routingFor } from '../src/services/routingService.js';
import { marginGuard, minViablePrice } from '../src/services/marginService.js';
import { demandRecoveryTime, averageMarginPerKg, buildComparison } from '../src/services/analyticsService.js';

const T = todayISO();

describe('Proposal features — unit rules', () => {
  it('Dynamic Routing moves through stages as produce ages', () => {
    const b = (daysAgo) => ({ harvest_date: addDays(T, -daysAgo), shelf_life_days: 10 });
    assert.equal(routingFor({ harvest_date: addDays(T, 2), shelf_life_days: 10 }).stage, 'PRE_HARVEST');
    assert.equal(routingFor(b(1)).stage, 'PREMIUM');
    assert.equal(routingFor(b(5)).stage, 'COMMUNITY');
    assert.equal(routingFor(b(7)).stage, 'RESCUE');
    assert.equal(routingFor(b(9)).stage, 'CLEARANCE');
    assert.equal(routingFor(b(12)).stage, 'DONATION');
    assert.equal(routingFor(b(1)).nextStage.key, 'COMMUNITY');
  });

  it('Margin Guard flags thin margins and losses', () => {
    assert.equal(minViablePrice(7, 15), 8.24);
    assert.equal(marginGuard({ unitPrice: 14, cost: 7, minMarginPct: 15 }).status, 'OK');
    assert.equal(marginGuard({ unitPrice: 8, cost: 7, minMarginPct: 15 }).status, 'BELOW_MINIMUM');
    assert.equal(marginGuard({ unitPrice: 6, cost: 7, minMarginPct: 15 }).status, 'LOSS');
    assert.equal(marginGuard({ unitPrice: 6, cost: null, minMarginPct: 15 }).known, false);
  });

  it('Demand Recovery Time measures hours until replacement allocations cover a cancellation', () => {
    const t0 = new Date('2030-01-01T10:00:00Z');
    const h = (n) => new Date(t0.getTime() + n * 3600000);
    const r = demandRecoveryTime(
      [{ batchId: 1, at: t0, quantity: 10 }, { batchId: 2, at: t0, quantity: 5 }],
      [{ batchId: 1, at: h(2), quantity: 4 }, { batchId: 1, at: h(6), quantity: 6 }, { batchId: 1, at: h(-1), quantity: 50 }]
    );
    assert.equal(r.value, 6);
    assert.equal(r.recovered, 1);
    assert.equal(r.disruptions, 2);
  });

  it('Average margin per kg only uses sales with a recorded cost', () => {
    const r = averageMarginPerKg([{ quantity: 10, unitPrice: 14, cost: 7 }, { quantity: 10, unitPrice: 12, cost: 7 }, { quantity: 5, unitPrice: 20, cost: null }]);
    assert.equal(r.value, 6);
    assert.equal(r.coverage, 67);
  });

  it('Baseline comparison shows change and direction; match conversion has no baseline', () => {
    const rows = buildComparison(
      [{ metric_key: 'demandCoverage', baseline_value: 40 }, { metric_key: 'notCommercialised', baseline_value: 50 }],
      { demandCoverage: 76.4, notCommercialised: 30, matchConversion: 75 }
    );
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    assert.equal(by.demandCoverage.change, 36.4);
    assert.equal(by.demandCoverage.direction, 'IMPROVED');
    assert.equal(by.notCommercialised.direction, 'IMPROVED'); // lower is better
    assert.equal(by.matchConversion.baselineStatus, 'N/A before Tyllage');
    assert.equal(by.sellThrough.baselineStatus, 'To establish');
  });
});

describe('Proposal features — integration', () => {
  let I;
  let admin;
  before(async () => {
    clearTokens();
    await resetDb();
    I = await ids();
    admin = await login(ACCOUNTS.farmAdmin);
    I.lettuce = (await pool.query(`SELECT hb.id FROM harvest_batches hb JOIN produce p ON p.id = hb.produce_id WHERE p.name = 'Lettuce' AND hb.farm_id = $1 AND hb.status <> 'CLOSED'`, [I.comcrop])).rows[0].id;
  });
  after(clearTokens);

  it('Demand Radar shows potential (unconfirmed) demand per batch', async () => {
    const d = (await api().get(`/api/farms/${I.comcrop}/dashboard`).set('Authorization', admin)).body.data;
    const kale = d.upcomingHarvest.find((b) => b.id === I.kale);
    assert.ok(kale.potentialDemand.quantity > 0);
    assert.ok(kale.potentialDemand.requests >= 4);
    assert.ok(d.kpis.potentialDemand >= kale.potentialDemand.quantity);
    assert.equal(kale.routing.stage, 'PREMIUM');
  });

  it('Chef Pack grade and farm-private production cost', async () => {
    const res = await api().patch(`/api/harvests/${I.naiBai}`).set('Authorization', admin).send({ grade: 'CHEF_PACK' });
    assert.equal(res.body.data.grade, 'CHEF_PACK');
    assert.equal(res.body.data.marginGuard.minViablePrice, 4.71); // cost 4 / (1 - 15%)
    const supply = (await api().get('/api/marketplace/supply')).body.data;
    for (const b of [...supply.availableNow, ...supply.growingSoon]) assert.equal(b.productionCost, undefined);
    const profile = (await api().get(`/api/marketplace/farms/${I.comcrop}`)).body.data;
    assert.equal(profile.minMarginPct, undefined);
    assert.ok(profile.supply.length > 0);
    assert.ok(profile.produce.length >= 5);
  });

  it('HarvestMatch applies farm minimum order quantity and surfaces margin per match', async () => {
    const r = await runMatch(I.naiBai, admin);
    const small = r.run.excluded.filter((e) => /below the farm minimum order/.test(e.reason));
    assert.equal(small.length, 3);
    const caterer = r.matches.find((m) => m.buyerName === 'Caterer E');
    assert.equal(caterer.margin.known, true);
    assert.equal(caterer.margin.perUnit, 3);
  });

  it('enforces the buyer’s minimum delivery quantity on approval', async () => {
    const { byBuyer } = await runMatch(I.kale, admin);
    const hotel = byBuyer['Hotel B'];
    const res = await api().post(`/api/matches/${hotel.id}/approve`).set('Authorization', admin).send({ quantity: 5 });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'BELOW_BUYER_MINIMUM');
  });

  it('FarmPool and DemandPool are Post-MVP: unavailable until the Phase 3 preview is enabled', async () => {
    const off = await api().get(`/api/demandpool/suggestions?farmId=${I.comcrop}`).set('Authorization', admin);
    assert.equal(off.status, 409);
    assert.equal(off.body.code, 'FEATURE_NOT_ENABLED');
    assert.equal((await api().get(`/api/farmpool?farmId=${I.comcrop}`).set('Authorization', admin)).status, 409);
    // Recovery does not suggest DemandPool while the preview is off.
    const rec = (await api().post(`/api/recovery/harvests/${I.naiBai}/start`).set('Authorization', admin).send({})).body.data.recovery;
    assert.ok(!rec.suggestions.some((x) => x.type === 'DEMAND_POOL'));

    const platform = await login(ACCOUNTS.platformAdmin);
    await api().patch('/api/admin/policies').set('Authorization', platform).send({ networkFeaturesEnabled: true }).expect(200);
    assert.equal((await api().get(`/api/demandpool/suggestions?farmId=${I.comcrop}`).set('Authorization', admin)).status, 200);
  });

  it('DemandPool combines small requests into one viable order', async () => {
    const suggestions = (await api().get(`/api/demandpool/suggestions?farmId=${I.comcrop}`).set('Authorization', admin)).body.data;
    const nb = suggestions.find((s) => s.harvestBatchId === I.naiBai);
    assert.equal(nb.members.length, 3);
    assert.equal(nb.totalQuantity, 6);
    assert.equal(nb.isViable, true);

    const tooSmall = await api().post('/api/demandpool').set('Authorization', admin)
      .send({ farmId: I.comcrop, harvestBatchId: I.naiBai, demandRequestIds: nb.members.slice(0, 2).map((m) => m.demandRequestId).filter((_, i) => i < 2) });
    // first two members total 3.5kg < 5kg viable minimum
    assert.equal(tooSmall.status, 409);
    assert.equal(tooSmall.body.code, 'POOL_NOT_VIABLE');

    const before = await batchStock(I.naiBai);
    const res = await api().post('/api/demandpool').set('Authorization', admin)
      .send({ farmId: I.comcrop, harvestBatchId: I.naiBai, demandRequestIds: nb.members.map((m) => m.demandRequestId) });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.members.length, 3);
    assert.equal(Number(res.body.data.totalQuantity), 6);
    assert.equal((await batchStock(I.naiBai)).remaining_quantity, before.remaining_quantity - 6);
    const sources = await pool.query(`SELECT DISTINCT source FROM orders WHERE id = ANY($1::int[])`, [res.body.data.members.map((m) => m.orderId)]);
    assert.deepEqual(sources.rows.map((r) => r.source), ['DEMANDPOOL']);
  });

  it('FarmPool lets several farms fulfil one request, with partner farms anonymised', async () => {
    const pools = (await api().get(`/api/farmpool?farmId=${I.comcrop}`).set('Authorization', admin)).body.data;
    const lettuce = pools.find((p) => p.produceName === 'Lettuce');
    assert.equal(lettuce.targetQuantity, 60);
    assert.equal(lettuce.committedQuantity, 30);
    assert.deepEqual(lettuce.otherContributions, [{ label: 'Partner farm 1', quantity: 30 }]);
    assert.ok(!JSON.stringify(lettuce).includes('Farm B'));
    assert.ok(lettuce.eligibleBatches.some((b) => b.id === I.lettuce));

    const over = await api().post(`/api/farmpool/${lettuce.demandRequestId}/contribute`).set('Authorization', admin)
      .send({ farmId: I.comcrop, harvestBatchId: I.lettuce, quantity: 31 });
    assert.equal(over.status, 409);

    const ok = await api().post(`/api/farmpool/${lettuce.demandRequestId}/contribute`).set('Authorization', admin)
      .send({ farmId: I.comcrop, harvestBatchId: I.lettuce, quantity: 20 });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.data.pool.committedQuantity, 50);
    assert.equal(ok.body.data.pool.contributingFarms, 2);

    // Buyer sees two supplying farms on their request.
    const hotelLike = await pool.query('SELECT fulfilled_quantity FROM demand_requests WHERE id = $1', [lettuce.demandRequestId]);
    assert.equal(Number(hotelLike.rows[0].fulfilled_quantity), 50);
    // Another farm's admin cannot contribute on ComCrop's behalf.
    const farmB = await login(ACCOUNTS.farmBAdmin);
    const spoof = await api().post(`/api/farmpool/${lettuce.demandRequestId}/contribute`).set('Authorization', farmB)
      .send({ farmId: I.comcrop, harvestBatchId: I.lettuce, quantity: 1 });
    assert.equal(spoof.status, 403);
  });

  it('buyers place direct bulk orders; farm minimums, stock and single-farm rules apply', async () => {
    const restaurant = await login(ACCOUNTS.restaurant);
    const bulk = await api().post('/api/orders').set('Authorization', restaurant)
      .send({ items: [{ harvestBatchId: I.kale, quantity: 5 }, { harvestBatchId: I.basil, quantity: 1 }], collectionMethod: 'DELIVERY' });
    assert.equal(bulk.status, 201, JSON.stringify(bulk.body));
    assert.equal(bulk.body.data.status, 'PENDING');
    assert.equal(bulk.body.data.items.length, 2);
    assert.equal(bulk.body.data.source, 'DIRECT');

    const consumer = await login(ACCOUNTS.consumer);
    const belowMoq = await api().post('/api/orders').set('Authorization', consumer).send({ items: [{ harvestBatchId: I.lettuce, quantity: 1 }] });
    assert.equal(belowMoq.status, 409);
    assert.equal(belowMoq.body.code, 'BELOW_FARM_MINIMUM');
    const multiFarm = await api().post('/api/orders').set('Authorization', consumer)
      .send({ items: [{ harvestBatchId: I.kale, quantity: 2 }, { harvestBatchId: I.pakChoi, quantity: 2 }] });
    assert.equal(multiFarm.status, 400);
    const tooMuch = await api().post('/api/orders').set('Authorization', consumer).send({ items: [{ harvestBatchId: I.kale, quantity: 500 }] });
    assert.equal(tooMuch.status, 409);
    // Farm users cannot place buyer orders.
    assert.equal((await api().post('/api/orders').set('Authorization', admin).send({ items: [{ harvestBatchId: I.kale, quantity: 2 }] })).status, 403);
  });

  it('records donations/alternative use, which count towards Waste Avoided', async () => {
    const before = await batchStock(I.kale);
    const over = await api().post(`/api/harvests/${I.kale}/dispositions`).set('Authorization', admin)
      .send({ dispositionType: 'DONATION', quantity: before.remaining_quantity + 1 });
    assert.equal(over.status, 409);
    const res = await api().post(`/api/harvests/${I.kale}/dispositions`).set('Authorization', admin)
      .send({ dispositionType: 'DONATION', quantity: 2, recipient: 'Test food bank' });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.disposedQuantity, 2);
    assert.equal((await batchStock(I.kale)).remaining_quantity, before.remaining_quantity - 2);
    const staff = await login(ACCOUNTS.farmStaff);
    assert.equal((await api().post(`/api/harvests/${I.kale}/dispositions`).set('Authorization', staff).send({ dispositionType: 'WASTE', quantity: 1 })).status, 403);

    const a = (await api().get(`/api/analytics?farmId=${I.comcrop}`).set('Authorization', admin)).body.data;
    assert.ok(a.metrics.wasteAvoided.redirected >= 4); // 2kg seeded + 2kg now
    assert.ok(a.metrics.averageMarginPerKg.sufficient);
    assert.ok(a.revenueByRoute.RESTAURANT > 0);
  });

  it('Demand Recovery Time is measured once released stock is re-allocated', async () => {
    const { byBuyer } = await runMatch(I.kale, admin);
    await api().post(`/api/matches/${byBuyer['Restaurant A'].id}/approve`).set('Authorization', admin).send({}).expect(200);
    const a = (await api().get(`/api/analytics?farmId=${I.comcrop}`).set('Authorization', admin)).body.data;
    assert.equal(a.metrics.demandRecoveryTime.sufficient, true);
    assert.ok(a.metrics.demandRecoveryTime.value > 0);
  });

  it('recovery breaks potential demand down by MarketRoute route', async () => {
    const rec = (await api().post(`/api/recovery/harvests/${I.kale}/start`).set('Authorization', admin).send({})).body.data.recovery;
    assert.deepEqual(Object.keys(rec.potentialByRoute).sort(), ['COMMUNITY_D2C', 'INSTITUTIONAL', 'RESTAURANT', 'RETAIL', 'WHOLESALE']);
    assert.ok('potentialFromExistingCustomers' in rec);
    assert.ok('potentialFromSubscribers' in rec);
  });

  it('suggests donation instead of Rescue once produce is past its sales window', async () => {
    const created = await api().post('/api/harvests').set('Authorization', admin).send({
      farmId: I.comcrop, produceId: await I.produce('Nai Bai'), expectedQuantity: 10, actualQuantity: 10, harvestDate: addDays(T, -9), preferredPrice: 8, minPrice: 6,
    });
    assert.equal(created.body.data.routing.stage, 'DONATION');
    const rec = (await api().post(`/api/recovery/harvests/${created.body.data.id}/start`).set('Authorization', admin).send({})).body.data.recovery;
    assert.ok(rec.suggestions.some((s) => s.type === 'RECORD_DISPOSITION'));
    assert.ok(!rec.suggestions.some((s) => s.type === 'MOVE_TO_RESCUE'));
  });

  it('pilot baselines are recorded and compared with live results', async () => {
    const before = (await api().get(`/api/analytics/comparison?farmId=${I.comcrop}`).set('Authorization', admin)).body.data;
    assert.ok(before.rows.every((r) => r.baseline === null));
    const res = await api().put('/api/analytics/baselines').set('Authorization', admin)
      .send({ farmId: I.comcrop, metricKey: 'demandCoverage', baselineValue: 40, periodLabel: 'Aug 2026 (pre-pilot)' });
    assert.equal(res.status, 200);
    const row = res.body.data.rows.find((r) => r.key === 'demandCoverage');
    assert.equal(row.baseline, 40);
    assert.notEqual(row.change, null);
    assert.equal(res.body.data.rows.find((r) => r.key === 'matchConversion').baselineStatus, 'N/A before Tyllage');
  });

  it('disputes: raised by buyers, resolved only by platform admins', async () => {
    const restaurant = await login(ACCOUNTS.restaurant);
    const order = (await api().get('/api/orders').set('Authorization', restaurant)).body.data.find((o) => o.status === 'CONFIRMED');
    const raised = await api().post(`/api/orders/${order.id}/disputes`).set('Authorization', restaurant).send({ reason: 'QUALITY', description: 'Leaves were wilted on arrival' });
    assert.equal(raised.status, 201);
    assert.equal((await api().post(`/api/orders/${order.id}/disputes`).set('Authorization', restaurant).send({ reason: 'LATE', description: 'Late again' })).status, 409);
    const hotel = await login(ACCOUNTS.hotel);
    assert.equal((await api().post(`/api/orders/${order.id}/disputes`).set('Authorization', hotel).send({ reason: 'LATE', description: 'Not my order' })).status, 403);
    assert.equal((await api().patch(`/api/disputes/${raised.body.data.id}`).set('Authorization', admin).send({ status: 'RESOLVED', resolution: 'x' })).status, 403);

    const platform = await login(ACCOUNTS.platformAdmin);
    const all = (await api().get('/api/disputes?status=OPEN').set('Authorization', platform)).body.data;
    assert.ok(all.length >= 2); // seeded + new
    const resolved = await api().patch(`/api/disputes/${raised.body.data.id}`).set('Authorization', platform).send({ status: 'RESOLVED', resolution: 'Partial refund agreed with the farm' });
    assert.equal(resolved.body.data.status, 'RESOLVED');
    const mine = (await api().get('/api/disputes').set('Authorization', restaurant)).body.data;
    assert.ok(mine.every((d) => d.buyerName === 'Restaurant A'));
  });

  it('platform policies change business rules live and are validated', async () => {
    const platform = await login(ACCOUNTS.platformAdmin);
    assert.equal((await api().get('/api/admin/policies').set('Authorization', admin)).status, 403);
    const bad = await api().patch('/api/admin/policies').set('Authorization', platform).send({ matchWeights: { produce: 50, date: 20, price: 20, quantity: 10, reliability: 10, location: 10 } });
    assert.equal(bad.status, 400);

    await api().patch('/api/admin/policies').set('Authorization', platform).send({ riskThresholds: { LOW: 90, MEDIUM: 20 } }).expect(200);
    const created = await api().post('/api/harvests').set('Authorization', admin).send({
      farmId: I.comcrop, produceId: await I.produce('Mint'), expectedQuantity: 10, harvestDate: addDays(T, 10), preferredPrice: 26, minPrice: 20,
    });
    assert.equal(created.body.data.riskLevel, 'HIGH'); // 0% coverage
    const pol = (await api().get('/api/admin/policies').set('Authorization', platform)).body.data;
    assert.equal(pol.find((p) => p.key === 'riskThresholds').isDefault, false);
    await api().patch('/api/admin/policies').set('Authorization', platform).send({ riskThresholds: null }).expect(200);
    const reset = (await api().get('/api/admin/policies').set('Authorization', platform)).body.data;
    assert.equal(reset.find((p) => p.key === 'riskThresholds').isDefault, true);

    const audit = (await api().get('/api/admin/audit-logs').set('Authorization', platform)).body.data;
    assert.ok(audit.some((a) => a.action === 'POLICY_UPDATED'));
    assert.ok(audit.some((a) => a.action === 'LOGIN_SUCCEEDED'));
  });

  it('AI assistant is simulated without an OpenAI key and shows the exact prompt', async () => {
    const status = (await api().get('/api/ai/status').set('Authorization', admin)).body.data;
    assert.equal(status.mode, 'SIMULATED');

    const { matches } = await runMatch(I.mint, admin).catch(() => ({ matches: [] }));
    const anyMatch = matches[0] || (await pool.query(`SELECT id FROM harvest_matches WHERE farm_id = $1 LIMIT 1`, [I.comcrop])).rows[0];
    const explain = (await api().post(`/api/ai/matches/${anyMatch.id}/explain`).set('Authorization', admin)).body.data;
    assert.equal(explain.mode, 'SIMULATED');
    assert.ok(explain.prompt.system.includes('Use ONLY the facts'));
    assert.ok(explain.output.length > 20);

    const insights = (await api().post('/api/ai/insights').set('Authorization', admin).send({ farmId: I.comcrop })).body.data;
    assert.match(insights.output, /demand coverage/i);

    const rescue = (await api().get(`/api/rescue?farmId=${I.comcrop}`).set('Authorization', admin)).body.data[0];
    const draft = (await api().post('/api/campaigns/generate').set('Authorization', admin).send({ farmId: I.comcrop, campaignType: 'RESCUE_ALERT', rescueListingId: rescue.id })).body.data;
    const variations = (await api().post(`/api/campaigns/${draft.id}/variations`).set('Authorization', admin)).body.data;
    assert.equal(variations.variations.length, 3);
    assert.deepEqual(variations.variations.map((v) => v.tone), ['Concise', 'Friendly', 'Urgent']);

    const price = (await api().get(`/api/rescue/price-suggestion?harvestBatchId=${I.kale}`).set('Authorization', admin)).body.data;
    assert.equal(price.method, 'RULE_BASED');
    assert.ok(price.suggestedPrice <= price.originalPrice && price.suggestedPrice >= price.floorPrice);
    assert.ok(price.rationale.length >= 2);
  });
});

describe('Order guard-rails', () => {
  before(async () => {
    clearTokens();
    await resetDb();
  });
  after(clearTokens);

  it('rejects collection methods the farm does not offer, and disputes on pending orders', async () => {
    const I = await ids();
    const consumer = await login(ACCOUNTS.consumer);
    // Farm B only offers farm pickup.
    const delivery = await api().post('/api/orders').set('Authorization', consumer)
      .send({ items: [{ harvestBatchId: I.pakChoi, quantity: 2 }], collectionMethod: 'DELIVERY' });
    assert.equal(delivery.status, 400);
    assert.equal(delivery.body.code, 'COLLECTION_METHOD_UNAVAILABLE');
    const pending = await api().post('/api/orders').set('Authorization', consumer)
      .send({ items: [{ harvestBatchId: I.pakChoi, quantity: 2 }], collectionMethod: 'FARM_PICKUP' });
    assert.equal(pending.status, 201);
    const dispute = await api().post(`/api/orders/${pending.body.data.id}/disputes`).set('Authorization', consumer)
      .send({ reason: 'QUALITY', description: 'Not yet received' });
    assert.equal(dispute.status, 409);
    assert.equal(dispute.body.code, 'ORDER_NOT_DISPUTABLE');
  });
});
