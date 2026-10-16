import { z } from 'zod';
import { query, withTransaction } from '../config/db.js';
import { validate } from '../utils/validate.js';
import { camelize, camelizeAll } from '../utils/case.js';
import { notFound, forbidden, conflict, badRequest } from '../utils/errors.js';
import { hasFarmAccess, assertFarmAdmin, isFarmSide } from './farmAccessService.js';
import { releaseOrderAllocations, createMultiLineOrder } from './allocationService.js';
import { COLLECTION_METHODS } from '../config/rules.js';
import { logAudit } from './auditService.js';
import { notifyBuyer, notifyFarm } from './notificationService.js';
import { lockRewardAccount, settleRewards } from './shopService.js';

export const ORDER_TRANSITIONS = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['READY', 'CANCELLED'],
  READY: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

const statusSchema = z.object({
  status: z.enum(['CONFIRMED', 'READY', 'COMPLETED', 'CANCELLED']),
  reason: z.string().trim().max(500).optional(),
});

const ORDER_SELECT = `
  SELECT o.*, bp.organisation_name AS buyer_name, bp.buyer_type, f.name AS farm_name,
         cd.community_name, cd.collection_point, cd.drop_date,
         COALESCE((SELECT json_agg(json_build_object(
                    'id', oi.id, 'produceId', oi.produce_id, 'produceName', p.name, 'unit', p.unit,
                    'harvestBatchId', oi.harvest_batch_id, 'demandRequestId', oi.demand_request_id,
                    'quantity', oi.quantity, 'unitPrice', oi.unit_price, 'lineTotal', oi.line_total) ORDER BY oi.id)
                     FROM order_items oi JOIN produce p ON p.id = oi.produce_id WHERE oi.order_id = o.id), '[]'::json) AS items
    FROM orders o
    JOIN buyer_profiles bp ON bp.id = o.buyer_id
    JOIN farms f ON f.id = o.farm_id
    LEFT JOIN community_drops cd ON cd.id = o.community_drop_id`;

export async function listOrdersForFarm(farmId, { status } = {}) {
  const params = [farmId];
  let where = 'o.farm_id = $1';
  if (status) {
    params.push(status.split(','));
    where += ` AND o.status = ANY($${params.length}::text[])`;
  }
  const { rows } = await query(`${ORDER_SELECT} WHERE ${where} ORDER BY o.created_at DESC LIMIT 300`, params);
  return camelizeAll(rows);
}

/** Buyer-facing order: the farm's fulfilment cost estimate is farm-private. */
function toBuyerOrder(row) {
  const { fulfilmentCost, ...order } = camelize(row);
  return order;
}

export async function listOrdersForBuyer(user) {
  if (!user.buyerId) return [];
  const { rows } = await query(`${ORDER_SELECT} WHERE o.buyer_id = $1 ORDER BY o.created_at DESC`, [user.buyerId]);
  return rows.map(toBuyerOrder);
}

async function loadOrder(id, client) {
  const runner = client || { query };
  const { rows } = await runner.query(`${ORDER_SELECT} WHERE o.id = $1`, [id]);
  if (!rows[0]) throw notFound('Order not found');
  return rows[0];
}

function canView(user, order) {
  return (user.buyerId && order.buyer_id === user.buyerId) || (isFarmSide(user) && hasFarmAccess(user, order.farm_id));
}

export async function getOrder(user, id) {
  const order = await loadOrder(id);
  if (!canView(user, order)) throw forbidden();
  return isFarmSide(user) ? camelize(order) : toBuyerOrder(order);
}

/**
 * Moves an order through its lifecycle. Farm staff handle fulfilment (confirm/ready/complete);
 * cancelling is restricted to farm admins or the buyer (while PENDING/CONFIRMED).
 * Cancellation releases allocations so stock becomes available for Demand Recovery.
 */
export async function updateOrderStatus(user, id, input, ip) {
  const { status, reason } = validate(statusSchema, input);

  const result = await withTransaction(async (client) => {
    const existing = (await client.query('SELECT community_drop_id FROM orders WHERE id=$1', [id])).rows[0];
    if (existing?.community_drop_id) await client.query('SELECT id FROM community_drops WHERE id=$1 FOR UPDATE', [existing.community_drop_id]);
    const { rows } = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [id]);
    const order = rows[0];
    if (!order) throw notFound('Order not found');

    const isBuyer = user.buyerId && order.buyer_id === user.buyerId;
    const isFarm = isFarmSide(user) && hasFarmAccess(user, order.farm_id);
    if (!isBuyer && !isFarm) throw forbidden();
    if (isBuyer && !isFarm && (status !== 'CANCELLED' || !['PENDING', 'CONFIRMED'].includes(order.status))) {
      throw forbidden('Buyers can only cancel pending or confirmed orders');
    }
    if (isFarm && status === 'CANCELLED') assertFarmAdmin(user, order.farm_id);

    if (!ORDER_TRANSITIONS[order.status].includes(status)) {
      throw conflict(`Cannot change an order from ${order.status} to ${status}`, 'INVALID_TRANSITION');
    }
    if (status === 'CANCELLED' && !reason && isFarm) {
      throw badRequest('A cancellation reason is required', 'VALIDATION_ERROR');
    }

    if (order.shop_listing_id) {
      await lockRewardAccount(client, order.buyer_id, order.farm_id);
      const listing = (await client.query(`SELECT kind, pickup_date,
        (pickup_date + pickup_end) AT TIME ZONE 'Asia/Singapore' <= NOW() AS expired,
        (pickup_date + pickup_start) AT TIME ZONE 'Asia/Singapore' <= NOW() AS started
        FROM shop_listings WHERE id=$1`, [order.shop_listing_id])).rows[0];
      if (isBuyer && !isFarm && status === 'CANCELLED' && listing.kind === 'SURPRISE_BAG' && listing.expired) {
        throw conflict('Uncollected surprise bags cannot be cancelled after the pickup window. Contact the farm for help.', 'PICKUP_EXPIRED');
      }
      if (status === 'COMPLETED' && !listing.started) throw conflict('Collection has not opened yet', 'PICKUP_NOT_STARTED');
      if (['READY','COMPLETED'].includes(status) && order.community_drop_id) {
        const drop = (await client.query(`SELECT cd.*, (SELECT COUNT(*) FROM orders o
          WHERE o.community_drop_id=cd.id AND o.status <> 'CANCELLED') AS n FROM community_drops cd WHERE cd.id=$1`, [order.community_drop_id])).rows[0];
        if (drop.status === 'CANCELLED' || drop.n < drop.min_orders) throw conflict('Pickup minimum has not been met. Arrange another date or farm pickup first.', 'PICKUP_MINIMUM');
      }
    }

    let released = [];
    if (status === 'CANCELLED') {
      released = await releaseOrderAllocations(client, id);
      await client.query(
        `UPDATE orders SET status = 'CANCELLED', cancelled_reason = $1, cancelled_by_party = $2, cancelled_at = NOW(), updated_at = NOW()
          WHERE id = $3`,
        [reason || null, isFarm ? 'FARM' : 'BUYER', id]
      );
    } else {
      await client.query(
        `UPDATE orders SET status = $1::varchar, completed_at = CASE WHEN $1::varchar = 'COMPLETED' THEN NOW() ELSE completed_at END, updated_at = NOW()
          WHERE id = $2`,
        [status, id]
      );
    }
    await settleRewards(client, order, status);
    await logAudit(
      {
        farmId: order.farm_id, userId: user.id,
        action: status === 'CANCELLED' ? 'ORDER_CANCELLED' : 'ORDER_STATUS_UPDATED',
        entityType: 'order', entityId: id,
        details: { from: order.status, to: status, reason, releasedQuantity: released.reduce((s, a) => s + Number(a.quantity), 0) },
        ip,
      },
      client
    );
    return { order: await loadOrder(id, client), released, cancelledBy: isFarm ? 'FARM' : 'BUYER' };
  });

  const order = camelize(result.order);
  if (status === 'CANCELLED') {
    const qty = result.released.reduce((s, a) => s + Number(a.quantity), 0);
    if (result.cancelledBy === 'BUYER') {
      await notifyFarm({
        farmId: order.farmId,
        type: 'ORDER_CANCELLED',
        title: `${order.buyerName} cancelled order #${order.id}`,
        body: `${qty}kg returned to available stock. Consider running Demand Recovery.`,
      });
    } else {
      await notifyBuyer({ buyerId: order.buyerId, farmId: order.farmId, type: 'ORDER_CANCELLED', title: `Order #${order.id} cancelled`, body: reason || 'Cancelled by the farm.' });
    }
  } else {
    await notifyBuyer({
      buyerId: order.buyerId, farmId: order.farmId, type: `ORDER_${status}`,
      title: `Order #${order.id} is ${status.toLowerCase()}`,
      body: `${order.farmName}: your order is now ${status.toLowerCase()}.`,
    });
  }
  return isFarmSide(user) ? order : toBuyerOrder(result.order);
}

// ---------------------------------------------------------------- direct (bulk) orders

const directOrderSchema = z.object({
  items: z
    .array(z.object({ harvestBatchId: z.coerce.number().int().positive(), quantity: z.coerce.number().positive().max(100000) }))
    .min(1, 'Add at least one item')
    .max(20),
  collectionMethod: z.enum(COLLECTION_METHODS).optional(),
  notes: z.string().trim().max(1000).optional(),
});

/**
 * Business buyers (bulk, multi-line) and consumers buy directly from available supply.
 * Orders start PENDING; the farm confirms or cancels. Stock is reserved immediately.
 */
export async function createDirectOrder(user, input, ip) {
  if (!user.buyerId) throw forbidden('A buyer account is required to place orders');
  const d = validate(directOrderSchema, input);
  const order = await withTransaction(async (client) => {
    const o = await createMultiLineOrder(client, {
      buyerId: user.buyerId,
      lines: d.items.map((i) => ({ batchId: i.harvestBatchId, quantity: i.quantity })),
      collectionMethod: d.collectionMethod,
      notes: d.notes,
      userId: user.id,
    });
    await logAudit({ farmId: o.farm_id, userId: user.id, action: 'ORDER_PLACED', entityType: 'order', entityId: o.id, details: { items: d.items.length, total: o.total_amount }, ip }, client);
    return loadOrder(o.id, client);
  });
  const o = toBuyerOrder(order);
  await notifyFarm({
    farmId: o.farmId,
    type: 'ORDER_PLACED',
    title: `New order #${o.id} from ${o.buyerName}`,
    body: `${o.items.map((i) => `${i.quantity}${i.unit} ${i.produceName}`).join(', ')} — awaiting your confirmation.`,
  });
  return o;
}

// ---------------------------------------------------------------- disputes

export const DISPUTE_REASONS = ['QUALITY', 'QUANTITY', 'LATE', 'NO_SHOW', 'PRICING', 'OTHER'];
const disputeSchema = z.object({
  reason: z.enum(DISPUTE_REASONS),
  description: z.string().trim().min(5, 'Describe the issue').max(2000),
});
const resolveSchema = z.object({
  status: z.enum(['RESOLVED', 'REJECTED']),
  resolution: z.string().trim().min(3).max(2000),
});

const DISPUTE_SELECT = `
  SELECT d.*, o.total_amount, o.status AS order_status, bp.organisation_name AS buyer_name, f.name AS farm_name,
         u.full_name AS raised_by_name, r.full_name AS resolved_by_name
    FROM order_disputes d
    JOIN orders o ON o.id = d.order_id
    JOIN buyer_profiles bp ON bp.id = o.buyer_id
    JOIN farms f ON f.id = d.farm_id
    LEFT JOIN users u ON u.id = d.raised_by
    LEFT JOIN users r ON r.id = d.resolved_by`;

/** Buyer or farm raises an issue on an order; a platform admin resolves it. */
export async function raiseDispute(user, orderId, input, ip) {
  const d = validate(disputeSchema, input);
  const order = await loadOrder(orderId);
  if (!canView(user, order)) throw forbidden();
  if (['PENDING', 'CANCELLED'].includes(order.status)) {
    throw conflict('Issues can only be reported on confirmed, ready or completed orders', 'ORDER_NOT_DISPUTABLE');
  }
  const party = user.buyerId && order.buyer_id === user.buyerId ? 'BUYER' : 'FARM';
  const open = await query(`SELECT 1 FROM order_disputes WHERE order_id = $1 AND status = 'OPEN'`, [orderId]);
  if (open.rowCount) throw conflict('An open dispute already exists for this order', 'DISPUTE_EXISTS');
  const { rows } = await query(
    `INSERT INTO order_disputes (order_id, farm_id, raised_by, raised_by_party, reason, description)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [orderId, order.farm_id, user.id, party, d.reason, d.description]
  );
  await logAudit({ farmId: order.farm_id, userId: user.id, action: 'DISPUTE_RAISED', entityType: 'order', entityId: orderId, details: { reason: d.reason, party }, ip });
  if (party === 'BUYER') {
    await notifyFarm({ farmId: order.farm_id, type: 'DISPUTE_RAISED', title: `Issue reported on order #${orderId}`, body: `${order.buyer_name}: ${d.reason.toLowerCase()} — ${d.description}` });
  }
  return camelize((await query(`${DISPUTE_SELECT} WHERE d.id = $1`, [rows[0].id])).rows[0]);
}

export async function listDisputes(user, { status } = {}) {
  const params = [];
  const where = [];
  if (user.role === 'platform_admin') {
    // all disputes
  } else if (isFarmSide(user)) {
    params.push(user.farmIds);
    where.push(`d.farm_id = ANY($${params.length}::int[])`);
  } else {
    params.push(user.buyerId || 0);
    where.push(`o.buyer_id = $${params.length}`);
  }
  if (status) {
    params.push(status);
    where.push(`d.status = $${params.length}`);
  }
  const { rows } = await query(`${DISPUTE_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY d.created_at DESC`, params);
  return camelizeAll(rows);
}

export async function resolveDispute(user, id, input, ip) {
  const d = validate(resolveSchema, input);
  const { rows } = await query('SELECT * FROM order_disputes WHERE id = $1', [id]);
  const dispute = rows[0];
  if (!dispute) throw notFound('Dispute not found');
  if (dispute.status !== 'OPEN') throw conflict('This dispute is already closed', 'DISPUTE_CLOSED');
  await query(
    `UPDATE order_disputes SET status = $1, resolution = $2, resolved_by = $3, resolved_at = NOW() WHERE id = $4`,
    [d.status, d.resolution, user.id, id]
  );
  await logAudit({ farmId: dispute.farm_id, userId: user.id, action: `DISPUTE_${d.status}`, entityType: 'order_dispute', entityId: id, details: d, ip });
  const order = await loadOrder(dispute.order_id);
  await notifyBuyer({ buyerId: order.buyer_id, farmId: order.farm_id, type: 'DISPUTE_UPDATE', title: `Your issue on order #${order.id} was ${d.status.toLowerCase()}`, body: d.resolution });
  await notifyFarm({ farmId: order.farm_id, type: 'DISPUTE_UPDATE', title: `Dispute on order #${order.id} ${d.status.toLowerCase()}`, body: d.resolution });
  return camelize((await query(`${DISPUTE_SELECT} WHERE d.id = $1`, [id])).rows[0]);
}
