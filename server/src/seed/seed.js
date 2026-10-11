/**
 * DEMO / PILOT DATA
 *
 * Fictional seed data for the ComCrop-first pilot demo. Nothing here represents ComCrop's actual
 * production levels, customers, revenue, costs, harvest quantities or commercial agreements.
 * Buyer names, prices and quantities are invented for demonstration only.
 *
 * Usage:  npm run seed            (only seeds an empty database)
 *         npm run seed -- --force (wipes ALL data, then seeds)
 */
import { pathToFileURL } from 'node:url';
import bcrypt from 'bcryptjs';
import { pool, withTransaction } from '../config/db.js';
import env from '../config/env.js';
import { addDays, todayISO } from '../utils/dates.js';
import { round2 } from '../utils/numbers.js';
import { syncBatchStatus } from '../models/harvestModel.js';
import { runMigrations } from '../db/migrate.js';
import { estimateFulfilment } from '../services/fulfilmentService.js';
import { assertNonProductionReset } from '../db/safety.js';

export const DEMO_PASSWORD = 'TyllageDemo2026!';

export const DEMO_ACCOUNTS = [
  { email: 'admin@tyllage.demo', role: 'platform_admin', fullName: 'Platform Admin (Demo)' },
  { email: 'farmadmin@comcrop.demo', role: 'farm_admin', fullName: 'Farm Admin (Demo)', farm: 'comcrop', staffRole: 'ADMIN' },
  { email: 'staff@comcrop.demo', role: 'farm_staff', fullName: 'Farm Staff (Demo)', farm: 'comcrop', staffRole: 'STAFF' },
  { email: 'farmb@tyllage.demo', role: 'farm_admin', fullName: 'Farm B Admin (Demo)', farm: 'farmB', staffRole: 'ADMIN' },
  { email: 'restaurant@tyllage.demo', role: 'business_buyer', fullName: 'Restaurant A Buyer (Demo)', buyer: 'restaurantA' },
  { email: 'hotel@tyllage.demo', role: 'business_buyer', fullName: 'Hotel B Buyer (Demo)', buyer: 'hotelB' },
  { email: 'consumer@tyllage.demo', role: 'consumer', fullName: 'Demo Consumer', buyer: 'consumer' },
];

// Fake 8-digit numbers in an unallocated range; WhatsApp runs in mock mode without credentials.
const BUYERS = {
  restaurantA: { name: 'Restaurant A (Demo)', type: 'RESTAURANT', region: 'CENTRAL', method: 'DELIVERY', phone: '80000001', optIn: true },
  hotelB: { name: 'Hotel B (Demo)', type: 'HOTEL', region: 'EAST', method: 'FARM_PICKUP', phone: '80000002', optIn: true },
  communityC: { name: 'Community Buyer C (Demo)', type: 'COMMUNITY', region: 'NORTH_EAST', method: 'COMMUNITY_DROP', phone: '80000003', optIn: true, managed: true },
  cafeD: { name: 'Café D (Demo)', type: 'CAFE', region: 'CENTRAL', method: 'DELIVERY', phone: '80000004', optIn: true, managed: true },
  catererE: { name: 'Caterer E (Demo)', type: 'CATERER', region: 'WEST', method: 'DELIVERY', phone: '80000005', optIn: false, managed: true },
  retailerF: { name: 'Retailer F (Demo)', type: 'RETAILER', region: 'NORTH', method: 'FARM_PICKUP', phone: '80000006', optIn: true, managed: true },
  consumerG: { name: 'Consumer G (Demo)', type: 'CONSUMER', region: 'EAST', method: 'FARM_PICKUP', phone: '80000007', optIn: true, managed: true },
  wholesalerH: { name: 'Wholesaler H (Demo)', type: 'WHOLESALER', region: 'WEST', method: 'CENTRAL_DROP', phone: '80000008', optIn: false, managed: true },
  wetMarketJ: { name: 'Wet Market Stall J (Demo)', type: 'WET_MARKET', region: 'NORTH', method: 'FARM_PICKUP', phone: '80000010', optIn: true, managed: true },
  consumer: { name: 'Demo Consumer', type: 'CONSUMER', region: 'NORTH', method: 'COMMUNITY_DROP', phone: '80000009', optIn: true },
};

const TABLES = [
  'route_selections', 'pilot_baselines', 'platform_policies', 'order_disputes', 'demand_pool_members', 'demand_pools', 'batch_dispositions',
  'audit_logs', 'notifications', 'campaigns', 'allocations', 'harvest_matches', 'match_runs', 'order_items', 'orders',
  'rescue_listings', 'community_drops', 'demand_requests', 'buyer_profiles', 'harvest_batches', 'produce', 'farm_staff', 'farms', 'users',
];

async function insert(client, table, data) {
  const cols = Object.keys(data);
  const { rows } = await client.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    Object.values(data)
  );
  return rows[0];
}

/** Inserts order + item + allocation consistently (seed bypasses API but keeps stock rules). */
async function seedOrder(client, { farmId, buyerId, batch, quantity, unitPrice, status, source = 'HARVESTMATCH', createdAt, demandId = null, cancelledBy = null, collection = 'FARM_PICKUP', dropId = null, userId, farmCosts = {} }) {
  const total = round2(quantity * unitPrice);
  const order = await insert(client, 'orders', {
    farm_id: farmId, buyer_id: buyerId, status, source, collection_method: collection, community_drop_id: dropId,
    fulfilment_cost: estimateFulfilment(collection, quantity, farmCosts).total,
    scheduled_date: batch.harvest_date, total_amount: total, created_by: userId, created_at: createdAt, updated_at: createdAt,
    completed_at: status === 'COMPLETED' ? createdAt : null,
    cancelled_at: status === 'CANCELLED' ? createdAt : null,
    cancelled_by_party: cancelledBy,
    cancelled_reason: status === 'CANCELLED' ? 'Demo: buyer menu change' : null,
  });
  const item = await insert(client, 'order_items', {
    order_id: order.id, produce_id: batch.produce_id, harvest_batch_id: batch.id, demand_request_id: demandId,
    quantity, unit_price: unitPrice, line_total: total, created_at: createdAt,
  });
  await insert(client, 'allocations', {
    farm_id: farmId, harvest_batch_id: batch.id, order_item_id: item.id, quantity,
    status: status === 'CANCELLED' ? 'RELEASED' : 'ACTIVE',
    released_at: status === 'CANCELLED' ? createdAt : null, created_at: createdAt,
  });
  return order;
}

export async function seed({ log = console.log } = {}) {
  const T = todayISO();
  const ts = (iso, hour = 9) => `${iso}T${String(hour).padStart(2, '0')}:00:00+08:00`;
  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);

  await withTransaction(async (client) => {
    // ---------------------------------------------------------------- farms
    const comcrop = await insert(client, 'farms', {
      name: 'ComCrop Singapore — Pilot Demo',
      slug: 'comcrop-pilot-demo',
      description: 'DEMO / PILOT DATA — fictional records for the ComCrop-first Tyllage pilot. Not actual ComCrop production, customers or revenue.',
      region: 'NORTH',
      address: 'Demo address (not a real location)',
      contact_email: 'farm@comcrop.demo',
      fulfilment_methods: ['FARM_PICKUP', 'CENTRAL_DROP', 'COMMUNITY_DROP', 'DELIVERY'],
      // DEMO ASSUMPTIONS for fulfilment cost estimates (S$), not ComCrop figures.
      fulfilment_costs: JSON.stringify({
        FARM_PICKUP: { perOrder: 0, perKg: 0 },
        CENTRAL_DROP: { perOrder: 8, perKg: 0.3 },
        COMMUNITY_DROP: { perOrder: 3, perKg: 0.2 },
        DELIVERY: { perOrder: 15, perKg: 0.2 },
      }),
      is_demo: true,
    });
    const farmB = await insert(client, 'farms', {
      name: 'Farm B — Onboarding Demo',
      slug: 'farm-b-demo',
      description: 'DEMO DATA — a second fictional farm showing multi-farm readiness.',
      region: 'WEST',
      address: 'Demo address (not a real location)',
      fulfilment_methods: ['FARM_PICKUP'],
      is_demo: true,
    });
    const farms = { comcrop, farmB };
    const costs = comcrop.fulfilment_costs; // jsonb comes back parsed
    const methodFor = (key) => (comcrop.fulfilment_methods.includes(BUYERS[key].method) ? BUYERS[key].method : 'FARM_PICKUP');

    // ---------------------------------------------------------------- users
    const users = {};
    for (const a of DEMO_ACCOUNTS) {
      const u = await insert(client, 'users', { email: a.email, password_hash: hash, full_name: a.fullName, role: a.role });
      users[a.email] = u;
      if (a.farm) await insert(client, 'farm_staff', { farm_id: farms[a.farm].id, user_id: u.id, staff_role: a.staffRole });
    }
    const farmAdminId = users['farmadmin@comcrop.demo'].id;

    // ---------------------------------------------------------------- buyers
    const buyers = {};
    const buyerUser = Object.fromEntries(DEMO_ACCOUNTS.filter((a) => a.buyer).map((a) => [a.buyer, users[a.email].id]));
    for (const [key, b] of Object.entries(BUYERS)) {
      buyers[key] = await insert(client, 'buyer_profiles', {
        user_id: buyerUser[key] ?? null,
        organisation_name: b.name,
        buyer_type: b.type,
        contact_name: `${b.name} contact`,
        contact_phone: b.phone,
        whatsapp_opt_in: b.optIn,
        region: b.region,
        preferred_collection_method: b.method,
        managed_by_farm_id: b.managed ? comcrop.id : null,
      });
    }

    // ---------------------------------------------------------------- produce (demo prices)
    // [name, category, default price, farm minimum order (kg), shelf life (days)] — demo values.
    const P = {};
    for (const [name, category, price, moq, shelf] of [
      ['Sweet Basil', 'HERBS', 28, 1, 6],
      ['Mint', 'HERBS', 26, 1, 6],
      ['Kale', 'LEAFY_GREENS', 14, 2, 7],
      ['Nai Bai', 'LEAFY_GREENS', 8, 5, 5],
      ['Lettuce', 'LEAFY_GREENS', 10, 2, 6],
    ]) {
      P[name] = await insert(client, 'produce', {
        farm_id: comcrop.id, name, category, unit: 'kg', default_price: price, min_order_quantity: moq, shelf_life_days: shelf,
      });
    }
    const pakChoi = await insert(client, 'produce', { farm_id: farmB.id, name: 'Pak Choi', category: 'LEAFY_GREENS', unit: 'kg', default_price: 9 });
    const farmBLettuce = await insert(client, 'produce', { farm_id: farmB.id, name: 'Lettuce', category: 'LEAFY_GREENS', unit: 'kg', default_price: 9.5, min_order_quantity: 2 });

    const batch = (produce, d) =>
      insert(client, 'harvest_batches', {
        farm_id: produce.farm_id, produce_id: produce.id, grade: 'EVERYDAY', created_by: farmAdminId, notes: 'DEMO / PILOT DATA', ...d,
      });

    // ---------------------------------------------------------------- historical (closed) batches → order history
    // production_cost = demo cost per kg (farm-private; feeds Margin Guard and Average Margin per kg).
    const hKale = await batch(P.Kale, { expected_quantity: 60, actual_quantity: 60, harvest_date: addDays(T, -14), preferred_price: 14, min_price: 10, production_cost: 7, status: 'CLOSED', marked_available: true });
    const hBasil = await batch(P['Sweet Basil'], { expected_quantity: 25, actual_quantity: 25, harvest_date: addDays(T, -10), preferred_price: 28, min_price: 22, production_cost: 15, status: 'CLOSED', marked_available: true });
    const hNaiBai = await batch(P['Nai Bai'], { expected_quantity: 50, actual_quantity: 50, harvest_date: addDays(T, -7), preferred_price: 8, min_price: 6, production_cost: 4, status: 'CLOSED', marked_available: true });

    const hist = [
      [hKale, 'restaurantA', 15, 14, 'COMPLETED'], [hKale, 'hotelB', 20, 13, 'COMPLETED'], [hKale, 'cafeD', 10, 14, 'COMPLETED'], [hKale, 'retailerF', 10, 12, 'COMPLETED'],
      [hBasil, 'restaurantA', 10, 28, 'COMPLETED'], [hBasil, 'cafeD', 8, 26, 'COMPLETED'], [hBasil, 'hotelB', 5, 26, 'CANCELLED', 'BUYER'],
      [hNaiBai, 'retailerF', 25, 7, 'COMPLETED'], [hNaiBai, 'wholesalerH', 15, 6.5, 'COMPLETED'], [hNaiBai, 'hotelB', 6, 8, 'COMPLETED'], [hNaiBai, 'restaurantA', 5, 8, 'COMPLETED'],
    ];
    for (const [b, key, qty, price, status, cancelledBy] of hist) {
      await seedOrder(client, { farmId: comcrop.id, buyerId: buyers[key].id, batch: b, quantity: qty, unitPrice: price, status, cancelledBy, createdAt: ts(addDays(b.harvest_date, -2)), userId: farmAdminId, collection: methodFor(key), farmCosts: costs });
    }

    // ---------------------------------------------------------------- current batches
    // Kale: HIGH risk (24/70 = 34%), harvested today — the core demo batch.
    const kale = await batch(P.Kale, { expected_quantity: 70, actual_quantity: 70, harvest_date: T, preferred_price: 14, min_price: 10, production_cost: 7, marked_available: true });
    // Sweet Basil: well covered (26/30 = 87%, LOW).
    const basil = await batch(P['Sweet Basil'], { expected_quantity: 30, harvest_date: addDays(T, 2), preferred_price: 28, min_price: 22, production_cost: 15, grade: 'PREMIUM' });
    // Nai Bai: MEDIUM (33/60 = 55%).
    const naiBai = await batch(P['Nai Bai'], { expected_quantity: 60, harvest_date: addDays(T, 3), preferred_price: 8, min_price: 6, production_cost: 4 });
    // Mint: MEDIUM (10/20 = 50%).
    const mint = await batch(P.Mint, { expected_quantity: 20, harvest_date: addDays(T, 5), preferred_price: 26, min_price: 20, production_cost: 14 });
    // Lettuce: MEDIUM (34/55 = 62%) — can contribute to the FarmPool request below.
    const lettuce = await batch(P.Lettuce, { expected_quantity: 55, harvest_date: addDays(T, 7), preferred_price: 10, min_price: 7, production_cost: 5 });
    // Farm B (multi-farm demo).
    await batch(pakChoi, { expected_quantity: 25, harvest_date: addDays(T, 4), preferred_price: 9, min_price: 7 });
    const farmBLettuceBatch = await batch(farmBLettuce, { expected_quantity: 40, harvest_date: addDays(T, 6), preferred_price: 9.5, min_price: 7, created_by: users['farmb@tyllage.demo'].id });

    const recent = ts(addDays(T, -3));
    const current = [
      [kale, 'cafeD', 14, 14], [kale, 'retailerF', 10, 13],
      [basil, 'restaurantA', 12, 28], [basil, 'cafeD', 8, 27], [basil, 'hotelB', 6, 26],
      [naiBai, 'retailerF', 25, 7.5], [naiBai, 'wholesalerH', 8, 7],
      [mint, 'cafeD', 6, 26], [mint, 'restaurantA', 4, 25],
      [lettuce, 'restaurantA', 14, 10], [lettuce, 'hotelB', 18, 9.5],
    ];
    const basilOrders = [];
    for (const [b, key, qty, price] of current) {
      const o = await seedOrder(client, { farmId: comcrop.id, buyerId: buyers[key].id, batch: b, quantity: qty, unitPrice: price, status: 'CONFIRMED', createdAt: recent, userId: farmAdminId, collection: methodFor(key), farmCosts: costs });
      if (b === basil) basilOrders.push({ o, key, qty, price });
    }
    // A buyer-cancelled Kale order (Wholesaler H) — Demand Recovery excludes this buyer for the batch.
    await seedOrder(client, { farmId: comcrop.id, buyerId: buyers.wholesalerH.id, batch: kale, quantity: 12, unitPrice: 12, status: 'CANCELLED', cancelledBy: 'BUYER', createdAt: ts(addDays(T, -1), 15), userId: farmAdminId, collection: methodFor('wholesalerH'), farmCosts: costs });

    // Community Drop with the demo consumer's lettuce order.
    const drop = await insert(client, 'community_drops', {
      farm_id: comcrop.id, community_name: 'Yishun Neighbours (Demo)', collection_point: 'Demo collection point — Yishun',
      region: 'NORTH', drop_date: addDays(T, 7), window_start: '10:00', window_end: '11:30', created_by: farmAdminId,
      notes: 'DEMO / PILOT DATA',
    });
    await seedOrder(client, { farmId: comcrop.id, buyerId: buyers.consumer.id, batch: lettuce, quantity: 2, unitPrice: 10, status: 'CONFIRMED', source: 'DIRECT', collection: 'COMMUNITY_DROP', dropId: drop.id, createdAt: recent, userId: farmAdminId, farmCosts: costs });

    // ---------------------------------------------------------------- open demand
    const demand = (key, d) =>
      insert(client, 'demand_requests', { buyer_id: buyers[key].id, unit: 'kg', created_by: buyers[key].user_id ?? farmAdminId, notes: 'DEMO / PILOT DATA', ...d });
    // Kale demand that HarvestMatch will rank.
    await demand('restaurantA', { farm_id: comcrop.id, produce_id: P.Kale.id, produce_name: 'Kale', category: 'LEAFY_GREENS', quantity: 15, required_date: addDays(T, 1), max_price: 13 });
    await demand('hotelB', { farm_id: comcrop.id, produce_id: P.Kale.id, produce_name: 'Kale', category: 'LEAFY_GREENS', quantity: 18, min_quantity: 10, required_date: addDays(T, 3), max_price: 12 });
    await demand('communityC', { farm_id: null, produce_name: 'Kale', category: 'LEAFY_GREENS', quantity: 8, required_date: addDays(T, 5) });
    await demand('consumerG', { farm_id: null, produce_name: 'Baby Kale', category: 'LEAFY_GREENS', quantity: 3, required_date: addDays(T, 6), max_price: 10 });
    // Excluded on price (max below farm minimum).
    await demand('catererE', { farm_id: comcrop.id, produce_id: P.Kale.id, produce_name: 'Kale', category: 'LEAFY_GREENS', quantity: 10, required_date: addDays(T, 2), max_price: 8 });
    // Excluded: this buyer cancelled an order on the current Kale batch.
    await demand('wholesalerH', { farm_id: comcrop.id, produce_id: P.Kale.id, produce_name: 'Kale', category: 'LEAFY_GREENS', quantity: 20, required_date: addDays(T, 2), max_price: 12 });
    // Other produce.
    await demand('catererE', { farm_id: comcrop.id, produce_id: P['Nai Bai'].id, produce_name: 'Nai Bai', category: 'LEAFY_GREENS', quantity: 10, required_date: addDays(T, 4), max_price: 7 });
    await demand('hotelB', { farm_id: comcrop.id, produce_id: P.Lettuce.id, produce_name: 'Lettuce', category: 'LEAFY_GREENS', quantity: 8, required_date: addDays(T, 7), max_price: 10, recurrence: 'WEEKLY' });
    await demand('consumer', { farm_id: null, produce_name: 'Mint', category: 'HERBS', quantity: 0.5, required_date: addDays(T, 6) });
    // Retail route: a wet-market stall's weekly Lettuce requirement.
    await demand('wetMarketJ', { farm_id: comcrop.id, produce_id: P.Lettuce.id, produce_name: 'Lettuce', category: 'LEAFY_GREENS', quantity: 10, required_date: addDays(T, 8), max_price: 8.5, recurrence: 'WEEKLY' });

    // DemandPool: small Nai Bai requests, each below the 5kg farm minimum order, viable together (6kg).
    await demand('consumerG', { farm_id: null, produce_name: 'Nai Bai', category: 'LEAFY_GREENS', quantity: 2, required_date: addDays(T, 4) });
    await demand('consumer', { farm_id: null, produce_name: 'Nai Bai', category: 'LEAFY_GREENS', quantity: 1.5, required_date: addDays(T, 4) });
    await demand('communityC', { farm_id: null, produce_name: 'Nai Bai', category: 'LEAFY_GREENS', quantity: 2.5, required_date: addDays(T, 5), max_price: 8 });

    // FarmPool: a 60kg open-market Lettuce requirement no single farm covers; Farm B has committed 30kg.
    const pooled = await demand('wholesalerH', {
      farm_id: null, produce_name: 'Lettuce', category: 'LEAFY_GREENS', quantity: 60, required_date: addDays(T, 7), max_price: 9,
      allow_pooling: true, fulfilled_quantity: 30, status: 'PARTIALLY_FULFILLED',
    });
    await seedOrder(client, {
      farmId: farmB.id, buyerId: buyers.wholesalerH.id, batch: farmBLettuceBatch, quantity: 30, unitPrice: 9, status: 'CONFIRMED',
      source: 'FARMPOOL', demandId: pooled.id, createdAt: recent, userId: users['farmb@tyllage.demo'].id,
    });

    // Dynamic Routing final stage on a past batch: surplus donated (counts towards Waste Avoided).
    await insert(client, 'batch_dispositions', {
      farm_id: comcrop.id, harvest_batch_id: hBasil.id, disposition_type: 'DONATION', quantity: 2,
      recipient: 'Demo community food programme', notes: 'DEMO / PILOT DATA', created_by: farmAdminId, created_at: ts(addDays(hBasil.harvest_date, 5), 17),
    });

    // An open order dispute for the platform admin to resolve.
    const disputed = (await client.query(
      `SELECT o.id FROM orders o JOIN order_items oi ON oi.order_id = o.id WHERE oi.harvest_batch_id = $1 AND o.buyer_id = $2 LIMIT 1`,
      [hNaiBai.id, buyers.restaurantA.id]
    )).rows[0];
    await insert(client, 'order_disputes', {
      order_id: disputed.id, farm_id: comcrop.id, raised_by: users['restaurant@tyllage.demo'].id, raised_by_party: 'BUYER', reason: 'QUANTITY',
      description: 'Demo: delivery was about 0.5kg short of the ordered quantity.',
    });

    // ---------------------------------------------------------------- MarketRoute + HarvestMatch history on Sweet Basil
    await client.query('UPDATE harvest_batches SET primary_route = $1 WHERE id = $2', ['RESTAURANT', basil.id]);
    await insert(client, 'route_selections', {
      farm_id: comcrop.id, harvest_batch_id: basil.id, route: 'RESTAURANT', recommended_route: 'RESTAURANT', route_score: 88, stage: 'PRIMARY',
      remaining_quantity: 30, assessment: JSON.stringify({ note: 'DEMO / PILOT DATA' }), created_by: farmAdminId, created_at: ts(addDays(T, -3), 8),
    });
    const run = await insert(client, 'match_runs', {
      farm_id: comcrop.id, harvest_batch_id: basil.id, run_type: 'HARVESTMATCH', remaining_quantity: 30, candidates_count: 4,
      summary: JSON.stringify({ note: 'DEMO / PILOT DATA' }), created_by: farmAdminId, created_at: ts(addDays(T, -3), 8),
    });
    for (const { o, key, qty, price } of basilOrders) {
      const dr = await demand(key, {
        farm_id: comcrop.id, produce_id: P['Sweet Basil'].id, produce_name: 'Sweet Basil', category: 'HERBS', quantity: qty,
        fulfilled_quantity: qty, required_date: basil.harvest_date, max_price: price, status: 'FULFILLED',
      });
      await client.query('UPDATE order_items SET demand_request_id = $1 WHERE order_id = $2', [dr.id, o.id]);
      await insert(client, 'harvest_matches', {
        farm_id: comcrop.id, run_id: run.id, harvest_batch_id: basil.id, demand_request_id: dr.id, buyer_id: buyers[key].id,
        match_score: key === 'restaurantA' ? 94 : key === 'cafeD' ? 90 : 81, market_route: key === 'hotelB' ? 'INSTITUTIONAL' : 'RESTAURANT',
        reasons: JSON.stringify(['Exact produce match', 'Required date matches harvest window']),
        recommended_quantity: qty, approved_quantity: qty, unit_price: price, expected_revenue: round2(qty * price),
        status: 'APPROVED', order_id: o.id, decided_by: farmAdminId, decided_at: ts(addDays(T, -3), 9), created_at: ts(addDays(T, -3), 8),
      });
    }
    const rejectedDemand = await demand('catererE', {
      farm_id: comcrop.id, produce_id: P['Sweet Basil'].id, produce_name: 'Sweet Basil', category: 'HERBS', quantity: 5,
      required_date: addDays(T, 4), max_price: 22, status: 'OPEN',
    });
    await insert(client, 'harvest_matches', {
      farm_id: comcrop.id, run_id: run.id, harvest_batch_id: basil.id, demand_request_id: rejectedDemand.id, buyer_id: buyers.catererE.id,
      match_score: 66, reasons: JSON.stringify(['Exact produce match', 'Buyer price $22.00 meets farm minimum']),
      recommended_quantity: 4, unit_price: 22, expected_revenue: 88, status: 'REJECTED', decision_note: 'Demo: reserved for premium buyers', market_route: 'INSTITUTIONAL',
      decided_by: farmAdminId, decided_at: ts(addDays(T, -3), 9), created_at: ts(addDays(T, -3), 8),
    });

    // ---------------------------------------------------------------- Rescue listing (farm-confirmed suitable for sale)
    await insert(client, 'rescue_listings', {
      farm_id: comcrop.id, harvest_batch_id: basil.id, quantity: 2, original_price: 28, rescue_price: 18,
      reason: 'COSMETIC_IMPERFECTION', reason_details: 'Demo: slightly bruised leaves, flavour unaffected',
      collection_deadline: ts(addDays(T, 3), 18), suitability_confirmed_by: farmAdminId, created_by: farmAdminId,
    });

    // ---------------------------------------------------------------- a past campaign (mock mode)
    await insert(client, 'campaigns', {
      farm_id: comcrop.id, campaign_type: 'B2B_AVAILABILITY', audience: 'BUSINESS_BUYERS', title: 'B2B availability: Nai Bai',
      context: JSON.stringify({ campaignType: 'B2B_AVAILABILITY', farm: comcrop.name, produce: 'Nai Bai', quantity: 27, unit: 'kg', harvestDate: naiBai.harvest_date, price: 8 }),
      generated_content: `Hello from ${comcrop.name}.\nWe have 27kg of Nai Bai harvesting on ${naiBai.harvest_date}, at $8.00/kg.\nReply or submit demand on Tyllage to secure supply for your kitchen.`,
      final_content: `Hello from ${comcrop.name}.\nWe have 27kg of Nai Bai harvesting on ${naiBai.harvest_date}, at $8.00/kg.\nReply or submit demand on Tyllage to secure supply for your kitchen.`,
      generation_mode: 'MOCK', status: 'SENT', harvest_batch_id: naiBai.id, recipients_count: 3,
      created_by: farmAdminId, approved_by: farmAdminId, approved_at: ts(addDays(T, -2), 10), sent_at: ts(addDays(T, -2), 10),
    });

    // Derive statuses from allocations.
    for (const b of [kale, basil, naiBai, mint, lettuce, farmBLettuceBatch]) await syncBatchStatus(b.id, client);
  });

  log('Seeded DEMO / PILOT DATA for "ComCrop Singapore — Pilot Demo"');
  log(`Demo accounts (password: ${DEMO_PASSWORD}):`);
  for (const a of DEMO_ACCOUNTS) log(`  ${a.role.padEnd(15)} ${a.email}`);
}

export async function truncateAll() {
  assertNonProductionReset();
  await pool.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.includes('--force')) assertNonProductionReset();
    if (env.isProduction && process.env.ALLOW_DEMO_SEED !== 'true') {
      throw new Error('Refusing to seed demo data in production. Set ALLOW_DEMO_SEED=true to override.');
    }
    await runMigrations();
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM farms');
    if (rows[0].n > 0) {
      if (!process.argv.includes('--force')) {
        throw new Error('Database already has data. Re-run with `npm run seed -- --force` to wipe it and reseed.');
      }
      await truncateAll();
      console.log('Existing data wiped');
    }
    await seed();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
