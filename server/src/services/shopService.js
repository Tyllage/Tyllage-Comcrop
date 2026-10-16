import { z } from 'zod';
import { query, withTransaction } from '../config/db.js';
import { validate } from '../utils/validate.js';
import { camelizeAll, camelize } from '../utils/case.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors.js';
import { assertFarmAdmin } from './farmAccessService.js';
import { lockBatch } from '../models/harvestModel.js';
import { createAllocatedOrder } from './allocationService.js';
import { marginGuard } from './marginService.js';
import { estimateFulfilment } from './fulfilmentService.js';
import { logAudit } from './auditService.js';
import { round2 } from '../utils/numbers.js';

const listingSchema = z.object({
  harvestBatchId: z.coerce.number().int().positive(),
  title: z.string().trim().min(2).max(150),
  description: z.string().trim().max(1500).default(''),
  kind: z.enum(['PREORDER', 'SURPRISE_BAG', 'REWARD']),
  quantityPerPack: z.coerce.number().positive().max(10000),
  packPrice: z.coerce.number().min(0).max(100000),
  originalValue: z.coerce.number().min(0).max(100000),
  pointsCost: z.coerce.number().int().min(0).max(1000000).default(0),
  maxPacks: z.coerce.number().int().positive().max(100000),
  pickupDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  pickupStart: z.string().regex(/^\d{2}:\d{2}$/),
  pickupEnd: z.string().regex(/^\d{2}:\d{2}$/),
  communityDropId: z.coerce.number().int().positive().nullable().default(null),
  packagingCost: z.coerce.number().min(0).max(10000).default(0),
  marginOverrideReason: z.string().trim().max(500).default(''),
  farmApproved: z.literal(true),
}).refine(d => d.pickupEnd > d.pickupStart && d.originalValue >= d.packPrice, { message: 'Check the pickup window and original value' })
  .refine(d => d.kind === 'REWARD' ? d.pointsCost > 0 && d.packPrice === 0 : d.packPrice > 0 && d.pointsCost === 0,
    { message: 'Rewards require points and a zero price; other listings require a positive price' });

// Explicit public projection: costs and override reasons never leave the farm workspace.
const SHOP_SELECT = `SELECT sl.id, sl.farm_id, f.name AS farm_name, f.description AS farm_description, f.is_demo,
  sl.title, sl.description, sl.kind, sl.quantity_per_pack, sl.pack_price, sl.original_value, sl.points_cost,
  sl.max_packs, sl.pickup_date, sl.pickup_start, sl.pickup_end, sl.community_drop_id, sl.is_active,
  sl.harvest_batch_id, hb.harvest_date, p.name AS produce_name, p.unit,
  cd.community_name, cd.collection_point, COALESCE(cd.min_orders, 1) AS min_orders,
  (SELECT COUNT(*) FROM orders o WHERE o.community_drop_id = cd.id AND o.status <> 'CANCELLED') AS pickup_orders,
  GREATEST(0, LEAST(sl.max_packs - COALESCE((SELECT SUM(o.shop_pack_count) FROM orders o
    WHERE o.shop_listing_id = sl.id AND o.status <> 'CANCELLED'),0), FLOOR(bs.remaining_quantity / sl.quantity_per_pack))) AS available_packs
  FROM shop_listings sl JOIN farms f ON f.id = sl.farm_id
  JOIN harvest_batches hb ON hb.id = sl.harvest_batch_id JOIN produce p ON p.id = hb.produce_id
  JOIN batch_stock bs ON bs.harvest_batch_id = hb.id LEFT JOIN community_drops cd ON cd.id = sl.community_drop_id`;

export async function listShop(farmId, managed = false) {
  const { rows } = await query(`${SHOP_SELECT} WHERE sl.farm_id = $1 ${managed ? '' : `AND sl.is_active AND f.is_active AND hb.status <> 'CLOSED'
    AND (sl.pickup_date + sl.pickup_end) AT TIME ZONE 'Asia/Singapore' > NOW()
    AND (sl.community_drop_id IS NULL OR cd.status = 'SCHEDULED')`} ORDER BY sl.pickup_date, sl.id DESC`, [farmId]);
  return camelizeAll(rows);
}

async function pickup(client, listing, { requireThreshold = false } = {}) {
  if (!listing.community_drop_id) return null;
  // Every operation altering drop membership locks this row first.
  const { rows } = await client.query('SELECT * FROM community_drops WHERE id = $1 FOR UPDATE', [listing.community_drop_id]);
  const drop = rows[0];
  if (!drop || drop.farm_id !== listing.farm_id || drop.status !== 'SCHEDULED' || drop.drop_date !== listing.pickup_date
      || drop.window_start !== `${listing.pickup_start}` || drop.window_end !== `${listing.pickup_end}`) {
    throw conflict('Choose a scheduled pickup with the same date and window', 'PICKUP_UNAVAILABLE');
  }
  if (requireThreshold) {
    const { rows: counts } = await client.query("SELECT COUNT(*) AS n FROM orders WHERE community_drop_id = $1 AND status <> 'CANCELLED'", [drop.id]);
    if (counts[0].n < drop.min_orders) throw conflict('This pickup has not reached its minimum orders. Choose farm pickup or an established delivery.', 'PICKUP_MINIMUM');
  }
  return drop;
}

export async function publishListing(user, farmId, input, ip) {
  assertFarmAdmin(user, farmId);
  const d = validate(listingSchema, input);
  return withTransaction(async client => {
    const draft = { farm_id: farmId, community_drop_id: d.communityDropId, pickup_date: d.pickupDate, pickup_start: `${d.pickupStart}:00`, pickup_end: `${d.pickupEnd}:00` };
    await pickup(client, draft, { requireThreshold: d.kind === 'SURPRISE_BAG' });
    const b = await lockBatch(d.harvestBatchId, client);
    if (!b || b.farm_id !== farmId) throw notFound('Harvest batch not found for this farm');
    if (b.status === 'CLOSED' || d.pickupDate < b.harvest_date) throw badRequest('Pickup must be on or after an open batch’s harvest date');
    const { rows: timing } = await client.query("SELECT ($1::date + $2::time) AT TIME ZONE 'Asia/Singapore' > NOW() AS valid", [d.pickupDate, d.pickupEnd]);
    if (!timing[0].valid) throw badRequest('Pickup window must be in the future');
    if (round2(d.quantityPerPack) <= 0 || d.quantityPerPack * d.maxPacks > b.remaining_quantity) throw conflict('Pack quantity exceeds unallocated harvest', 'OVER_ALLOCATION');
    const method = d.communityDropId ? 'COMMUNITY_DROP' : 'FARM_PICKUP';
    if (!b.fulfilment_methods.includes(method)) throw badRequest('This farm does not offer the selected pickup method');
    const fulfilment = estimateFulfilment(method, d.quantityPerPack, b.fulfilment_costs).total + d.packagingCost;
    const guard = marginGuard({ unitPrice: d.packPrice / d.quantityPerPack, quantity: d.quantityPerPack, cost: b.production_cost, minMarginPct: b.min_margin_pct, fulfilmentTotal: fulfilment });
    const below = d.packPrice < b.min_price * d.quantityPerPack || ['LOSS', 'BELOW_MINIMUM'].includes(guard.status);
    if (below && d.marginOverrideReason.length < 10) throw conflict('Margin Guard: this offer needs an explicit farm approval reason (at least 10 characters) for its price or reward cost.', 'MARGIN_APPROVAL_REQUIRED');
    const { rows } = await client.query(`INSERT INTO shop_listings
      (farm_id, harvest_batch_id, title, description, kind, quantity_per_pack, pack_price, original_value, points_cost,
       max_packs, pickup_date, pickup_start, pickup_end, community_drop_id, packaging_cost, margin_override_reason, approved_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [farmId, b.id, d.title, d.description, d.kind, d.quantityPerPack, d.packPrice, d.originalValue, d.pointsCost,
        d.maxPacks, d.pickupDate, d.pickupStart, d.pickupEnd, d.communityDropId, d.packagingCost, d.marginOverrideReason || null, user.id]);
    await logAudit({ farmId, userId: user.id, action: 'SHOP_LISTING_APPROVED', entityType: 'shop_listing', entityId: rows[0].id, details: { ...d, margin: guard }, ip }, client);
    return camelize(rows[0]);
  });
}

export async function closeListing(user, id) {
  const { rows } = await query('SELECT farm_id FROM shop_listings WHERE id = $1', [id]);
  if (!rows[0]) throw notFound('Listing not found');
  assertFarmAdmin(user, rows[0].farm_id);
  await query('UPDATE shop_listings SET is_active = FALSE WHERE id = $1', [id]);
  await logAudit({ farmId: rows[0].farm_id, userId: user.id, action: 'SHOP_LISTING_CLOSED', entityType: 'shop_listing', entityId: id });
  return { id };
}

export async function lockRewardAccount(client, buyerId, farmId) {
  await client.query('INSERT INTO reward_accounts (buyer_id, farm_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [buyerId, farmId]);
  return (await client.query('SELECT * FROM reward_accounts WHERE buyer_id = $1 AND farm_id = $2 FOR UPDATE', [buyerId, farmId])).rows[0];
}

export async function rewards(user, farmId) {
  if (!user.buyerId) throw forbidden();
  const [balance, ledger] = await Promise.all([
    query('SELECT points FROM reward_accounts WHERE buyer_id = $1 AND farm_id = $2', [user.buyerId, farmId]),
    query('SELECT order_id, kind, points, created_at FROM reward_ledger WHERE buyer_id = $1 AND farm_id = $2 ORDER BY id DESC LIMIT 50', [user.buyerId, farmId]),
  ]);
  return { points: balance.rows[0]?.points || 0, pointsPerDollar: 1, discountPointsPerDollar: 100, ledger: camelizeAll(ledger.rows) };
}

export async function checkout(user, id, input, ip) {
  if (user.role !== 'consumer' || !user.buyerId) throw forbidden('A consumer account is required');
  const d = validate(z.object({ packs: z.coerce.number().int().min(1).max(100), redeemPoints: z.coerce.number().int().min(0).max(1000000).default(0), acceptDemoPayment: z.literal(true) }), input);
  return withTransaction(async client => {
    const initial = (await client.query('SELECT * FROM shop_listings WHERE id = $1', [id])).rows[0];
    if (!initial) throw notFound('Listing not found');
    await pickup(client, initial, { requireThreshold: initial.kind === 'SURPRISE_BAG' });
    const account = await lockRewardAccount(client, user.buyerId, initial.farm_id);
    const b = await lockBatch(initial.harvest_batch_id, client);
    const l = (await client.query(`SELECT *, (pickup_date + pickup_end) AT TIME ZONE 'Asia/Singapore' > NOW() AS in_window
      FROM shop_listings WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    const farm = (await client.query('SELECT is_active FROM farms WHERE id = $1', [l.farm_id])).rows[0];
    if (!l.is_active || !l.in_window || !farm.is_active || b.status === 'CLOSED') throw conflict('This offer is no longer available', 'SHOP_UNAVAILABLE');
    const sold = (await client.query("SELECT COALESCE(SUM(shop_pack_count),0) AS n FROM orders WHERE shop_listing_id = $1 AND status <> 'CANCELLED'", [id])).rows[0].n;
    if (sold + d.packs > l.max_packs) throw conflict('Not enough packs remain', 'OVER_ALLOCATION');
    if (l.kind === 'REWARD' && d.redeemPoints) throw badRequest('Reward items use their listed points price');
    if (d.redeemPoints % 100) throw badRequest('Redeem discounts in blocks of 100 points');
    const points = l.kind === 'REWARD' ? l.points_cost * d.packs : d.redeemPoints;
    if (points > account.points) throw conflict('Not enough reward points', 'INSUFFICIENT_POINTS');
    const discount = l.kind === 'REWARD' ? 0 : d.redeemPoints / 100;
    const quantity = round2(l.quantity_per_pack * d.packs);
    const gross = round2(l.pack_price * d.packs);
    if (discount > gross) throw badRequest('Discount exceeds the order total');
    const total = round2(gross - discount);
    const method = l.community_drop_id ? 'COMMUNITY_DROP' : 'FARM_PICKUP';
    const logistics = estimateFulfilment(method, quantity, b.fulfilment_costs).total + l.packaging_cost * d.packs;
    const guard = marginGuard({ unitPrice: total / quantity, quantity, cost: b.production_cost, minMarginPct: b.min_margin_pct, fulfilmentTotal: logistics });
    // The publication approval covers its listed price, never a further discount below the margin floor.
    if ((discount > 0 || !l.margin_override_reason) && (total < b.min_price * quantity || ['LOSS', 'BELOW_MINIMUM'].includes(guard.status))) {
      throw conflict('This price or reward discount exceeds the farm’s approved margin. Try fewer points or another offer.', 'MARGIN_GUARD');
    }
    const { order } = await createAllocatedOrder(client, { batchId: b.id, buyerId: user.buyerId, quantity,
      unitPrice: total / quantity, source: l.kind === 'PREORDER' ? 'DIRECT' : 'RESCUE', collectionMethod: method,
      scheduledDate: l.pickup_date, userId: user.id, status: 'CONFIRMED', notes: `${l.title} · ${d.packs} pack(s). Prototype checkout; no money charged.` });
    // Unit prices are stored to 2dp by PostgreSQL; retain the pack total as the authoritative sale value.
    await client.query('UPDATE order_items SET line_total = $1 WHERE order_id = $2', [total, order.id]);
    await client.query(`UPDATE orders SET shop_listing_id=$1, shop_pack_count=$2, reward_discount=$3,
      community_drop_id=$4, fulfilment_cost=$5, total_amount=$6, payment_status=$7 WHERE id=$8`,
      [id, d.packs, discount, l.community_drop_id, logistics, total, total > 0 ? 'DEMO_PAID' : 'NO_PAYMENT', order.id]);
    if (points) {
      await client.query('UPDATE reward_accounts SET points = points - $1 WHERE buyer_id=$2 AND farm_id=$3', [points, user.buyerId, l.farm_id]);
      await client.query("INSERT INTO reward_ledger (buyer_id,farm_id,order_id,kind,points) VALUES ($1,$2,$3,'REDEEM',$4)", [user.buyerId, l.farm_id, order.id, -points]);
    }
    await logAudit({ farmId: l.farm_id, userId: user.id, action: 'SHOP_CHECKOUT', entityType: 'order', entityId: order.id, details: { listingId: id, packs: d.packs, points, total, simulatedPayment: true }, ip }, client);
    return { id: order.id, totalAmount: total, pointsRedeemed: points, paymentStatus: total > 0 ? 'DEMO_PAID' : 'NO_PAYMENT' };
  });
}

/** Called within the order transaction; account lock is acquired before inventory locks. */
export async function settleRewards(client, order, status) {
  if (!order.shop_listing_id) return;
  let points = 0;
  let kind;
  if (status === 'COMPLETED') { points = Math.floor(order.total_amount); kind = 'EARN'; }
  if (status === 'CANCELLED') {
    const redeemed = (await client.query("SELECT points FROM reward_ledger WHERE order_id=$1 AND kind='REDEEM'", [order.id])).rows[0];
    points = -(redeemed?.points || 0); kind = 'RESTORE';
    await client.query("UPDATE orders SET payment_status=CASE WHEN payment_status='DEMO_PAID' THEN 'DEMO_REFUNDED' ELSE payment_status END WHERE id=$1", [order.id]);
  }
  if (!points || !kind) return;
  const result = await client.query(`INSERT INTO reward_ledger (buyer_id,farm_id,order_id,kind,points)
    VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id`, [order.buyer_id, order.farm_id, order.id, kind, points]);
  if (result.rowCount) await client.query('UPDATE reward_accounts SET points=points+$1 WHERE buyer_id=$2 AND farm_id=$3', [points, order.buyer_id, order.farm_id]);
}

export async function shopInsights(farmId) {
  const { rows } = await query(`SELECT COALESCE(cd.community_name, 'Farm pickup') AS pickup_area, sl.pickup_date,
    p.name AS produce_name, COUNT(*) FILTER (WHERE o.status='COMPLETED') AS collected_orders,
    COALESCE(SUM(o.total_amount) FILTER (WHERE o.status='COMPLETED'),0) AS revenue,
    COUNT(*) FILTER (WHERE o.status='CANCELLED') AS cancelled_orders
    FROM orders o JOIN shop_listings sl ON sl.id=o.shop_listing_id JOIN harvest_batches hb ON hb.id=sl.harvest_batch_id
    JOIN produce p ON p.id=hb.produce_id LEFT JOIN community_drops cd ON cd.id=o.community_drop_id
    WHERE o.farm_id=$1 GROUP BY cd.community_name, sl.pickup_date,p.name ORDER BY sl.pickup_date DESC`, [farmId]);
  return camelizeAll(rows);
}
