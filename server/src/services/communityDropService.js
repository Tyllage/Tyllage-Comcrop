/**
 * Community Drops (P1) — several consumers in one area collect from one scheduled point.
 * No route optimisation; just community, collection point, date, window and participating orders.
 */
import { z } from 'zod';
import { query, withTransaction } from '../config/db.js';
import { validate } from '../utils/validate.js';
import { camelize, camelizeAll } from '../utils/case.js';
import { notFound, conflict, forbidden, badRequest } from '../utils/errors.js';
import { todayISO } from '../utils/dates.js';
import { REGIONS } from '../config/rules.js';
import { assertFarmAdmin } from './farmAccessService.js';
import { logAudit } from './auditService.js';

const time = z.string().regex(/^\d{2}:\d{2}$/, 'must be HH:MM');
const dropSchema = z
  .object({
    communityName: z.string().trim().min(2).max(120),
    collectionPoint: z.string().trim().min(2).max(200),
    region: z.enum(REGIONS).nullable().optional(),
    dropDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    windowStart: time,
    windowEnd: time,
    notes: z.string().trim().max(1000).nullable().optional(),
    minOrders: z.coerce.number().int().min(1).max(1000).default(1),
  })
  .refine((d) => d.windowEnd > d.windowStart, { message: 'Window end must be after start', path: ['windowEnd'] });

const DROP_SELECT = `
  SELECT cd.*, f.name AS farm_name,
         COUNT(DISTINCT o.id) FILTER (WHERE o.status <> 'CANCELLED') AS order_count,
         COALESCE(SUM(oi.quantity) FILTER (WHERE o.status <> 'CANCELLED'), 0) AS total_quantity
    FROM community_drops cd
    JOIN farms f ON f.id = cd.farm_id
    LEFT JOIN orders o ON o.community_drop_id = cd.id
    LEFT JOIN order_items oi ON oi.order_id = o.id`;

export async function listForFarm(farmId) {
  const { rows } = await query(`${DROP_SELECT} WHERE cd.farm_id = $1 GROUP BY cd.id, f.name ORDER BY cd.drop_date DESC`, [farmId]);
  return camelizeAll(rows);
}

export async function listUpcoming() {
  const { rows } = await query(
    `${DROP_SELECT} WHERE cd.status = 'SCHEDULED' AND cd.drop_date >= $1 AND f.is_active
      GROUP BY cd.id, f.name ORDER BY cd.drop_date ASC`,
    [todayISO()]
  );
  return camelizeAll(rows);
}

async function loadDrop(id) {
  const { rows } = await query(`${DROP_SELECT} WHERE cd.id = $1 GROUP BY cd.id, f.name`, [id]);
  if (!rows[0]) throw notFound('Community Drop not found');
  return rows[0];
}

export async function createDrop(user, farmId, input, ip) {
  assertFarmAdmin(user, farmId);
  const d = validate(dropSchema, input);
  if (d.dropDate < todayISO()) throw badRequest('Drop date cannot be in the past', 'VALIDATION_ERROR');
  const { rows } = await query(
    `INSERT INTO community_drops (farm_id, community_name, collection_point, region, drop_date, window_start, window_end, notes, created_by, min_orders)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [farmId, d.communityName, d.collectionPoint, d.region ?? null, d.dropDate, d.windowStart, d.windowEnd, d.notes ?? null, user.id, d.minOrders]
  );
  await logAudit({ farmId, userId: user.id, action: 'COMMUNITY_DROP_CREATED', entityType: 'community_drop', entityId: rows[0].id, details: d, ip });
  return camelize(await loadDrop(rows[0].id));
}

export async function updateDropStatus(user, id, status, ip) {
  if (!['COMPLETED', 'CANCELLED'].includes(status)) throw badRequest('Invalid status', 'VALIDATION_ERROR');
  await withTransaction(async client => {
    const drop = (await client.query('SELECT * FROM community_drops WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if (!drop) throw notFound('Community Drop not found');
    assertFarmAdmin(user, drop.farm_id);
    if (drop.status !== 'SCHEDULED') throw conflict('Only scheduled drops can be updated', 'DROP_NOT_SCHEDULED');
    const orders = (await client.query("SELECT COUNT(*) AS n FROM orders WHERE community_drop_id=$1 AND status <> 'CANCELLED'",[id])).rows[0].n;
    if (status==='COMPLETED' && orders<drop.min_orders) throw conflict('The minimum pickup order count has not been met','PICKUP_MINIMUM');
    const open = (await client.query("SELECT COUNT(*) AS n FROM orders WHERE community_drop_id=$1 AND status IN ('PENDING','CONFIRMED','READY')",[id])).rows[0].n;
    if (open) throw conflict('Complete or cancel participating orders before closing this pickup. Offer customers another scheduled date or farm pickup.','PICKUP_HAS_OPEN_ORDERS');
    await client.query('UPDATE community_drops SET status = $1, updated_at = NOW() WHERE id = $2', [status, id]);
    await logAudit({ farmId: drop.farm_id, userId: user.id, action: `COMMUNITY_DROP_${status}`, entityType: 'community_drop', entityId: id, ip },client);
  });
  return camelize(await loadDrop(id));
}

/** A buyer attaches one of their open orders from the same farm to a scheduled drop. */
export async function joinDrop(user, id, orderId) {
  if (!user.buyerId) throw forbidden('A buyer account is required');
  return withTransaction(async client => {
  const prior = (await client.query('SELECT community_drop_id FROM orders WHERE id=$1',[orderId])).rows[0];
  const dropIds = [...new Set([id,prior?.community_drop_id].filter(Boolean))].sort((a,b)=>a-b);
  for (const dropId of dropIds) await client.query('SELECT id FROM community_drops WHERE id=$1 FOR UPDATE',[dropId]);
  const drop = await loadDrop(id);
  if (drop.status !== 'SCHEDULED' || drop.drop_date < todayISO()) throw conflict('This Community Drop is not open', 'DROP_NOT_SCHEDULED');
  const { rows } = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
  const order = rows[0];
  if (!order || order.buyer_id !== user.buyerId) throw notFound('Order not found');
  if (order.shop_listing_id) throw conflict('Shop orders use their approved pickup. Cancel and choose a new offer to change pickup.', 'SHOP_PICKUP_FIXED');
  const latestHarvest = (await client.query('SELECT MAX(hb.harvest_date) AS day FROM order_items oi JOIN harvest_batches hb ON hb.id=oi.harvest_batch_id WHERE oi.order_id=$1',[orderId])).rows[0].day;
  if (latestHarvest > drop.drop_date) throw badRequest('Pickup cannot be before harvest');
  if (order.farm_id !== drop.farm_id) throw badRequest('Order is from a different farm', 'FARM_MISMATCH');
  if (!['PENDING', 'CONFIRMED', 'READY'].includes(order.status)) throw conflict('Only open orders can join a drop', 'ORDER_NOT_OPEN');
  await client.query(
    `UPDATE orders SET community_drop_id = $1, collection_method = 'COMMUNITY_DROP', scheduled_date = $2, updated_at = NOW() WHERE id = $3`,
    [id, drop.drop_date, orderId]
  );
  return { ...camelize(drop), orderId };
  });
}
