import { z } from 'zod';
import { createHash } from 'node:crypto';
import { withTransaction, query } from '../config/db.js';
import { validate } from '../utils/validate.js';
import { camelize, camelizeAll } from '../utils/case.js';
import { notFound, conflict, AppError } from '../utils/errors.js';
import { assertFarmAdmin } from './farmAccessService.js';
import { createAllocatedOrder } from './allocationService.js';
import { MATCH_SELECT, scoreCandidate, loadExclusions } from './harvestMatchService.js';
import { findBatchById, lockBatch, toBatchDTO } from '../models/harvestModel.js';
import { estimateFulfilment, resolveMethod } from './fulfilmentService.js';
import { marginGuard } from './marginService.js';
import { round2 } from '../utils/numbers.js';
import { logAudit } from './auditService.js';
import { notifyBuyer } from './notificationService.js';

const approveSchema = z.object({
  quantity: z.coerce.number().positive('must be greater than 0').max(100000).optional(),
  note: z.string().trim().max(500).optional(),
  quoteToken: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  marginOverrideReason: z.string().trim().min(10).max(500).optional(),
});
const rejectSchema = z.object({ reason: z.string().trim().max(500).optional() });

async function lockMatch(client, id) {
  const { rows } = await client.query('SELECT * FROM harvest_matches WHERE id = $1 FOR UPDATE', [id]);
  if (!rows[0]) throw notFound('Match not found');
  return rows[0];
}

async function loadMatch(id, client) {
  const runner = client || { query };
  const { rows } = await runner.query(`${MATCH_SELECT} WHERE hm.id = $1`, [id]);
  return rows[0] ? camelize(rows[0]) : null;
}

/** Shared preview/approval checks. Batch-first locking also matches re-run and close operations. */
async function prepareApproval(client, user, matchId, input) {
  const initial = (await client.query('SELECT farm_id, harvest_batch_id FROM harvest_matches WHERE id = $1', [matchId])).rows[0];
  if (!initial) throw notFound('Match not found');
  assertFarmAdmin(user, initial.farm_id);
  let batch = await lockBatch(initial.harvest_batch_id, client);
  const match = await lockMatch(client, matchId);
  if (match.status !== 'SUGGESTED') throw conflict(`This match has already been ${match.status.toLowerCase()}`, 'MATCH_NOT_PENDING');
  if (batch.status === 'CLOSED') throw conflict('This harvest batch is closed', 'BATCH_CLOSED');
  // Keep editable commercial inputs stable through the transaction.
  await client.query('SELECT id FROM farms WHERE id = $1 FOR SHARE', [batch.farm_id]);
  await client.query('SELECT id FROM produce WHERE id = $1 FOR SHARE', [batch.produce_id]);
  batch = await findBatchById(batch.id, client);
  const demand = (await client.query('SELECT * FROM demand_requests WHERE id = $1 FOR UPDATE', [match.demand_request_id])).rows[0];
  const buyer = (await client.query('SELECT * FROM buyer_profiles WHERE id = $1 FOR SHARE', [match.buyer_id])).rows[0];
  if (!buyer?.is_active) throw conflict('This buyer is no longer active', 'BUYER_INACTIVE');
  if (buyer.user_id) {
    const account = (await client.query('SELECT is_active FROM users WHERE id = $1 FOR SHARE', [buyer.user_id])).rows[0];
    if (!account?.is_active) throw conflict('This buyer account is no longer active', 'BUYER_INACTIVE');
  }
  if (!demand || !['OPEN', 'PARTIALLY_FULFILLED'].includes(demand.status)) throw conflict('This demand request is no longer open', 'DEMAND_NOT_OPEN');
  if (demand.buyer_id !== match.buyer_id || (demand.farm_id && demand.farm_id !== batch.farm_id)) {
    throw conflict('This demand is no longer available to this farm', 'MATCH_STALE');
  }
  const quantity = round2(input.quantity ?? Number(match.recommended_quantity));
  if (!(quantity > 0)) throw conflict('Quantity must be at least 0.01', 'INVALID_QUANTITY');
  if (quantity > Number(batch.remaining_quantity)) throw conflict('The batch no longer has enough unallocated stock', 'OVER_ALLOCATION');
  const demandRemaining = round2(demand.quantity - demand.fulfilled_quantity);
  if (quantity > demandRemaining) throw conflict('The quantity exceeds the buyer\'s remaining demand', 'DEMAND_EXCEEDED');
  if (quantity < demandRemaining && demand.min_quantity && quantity < Number(demand.min_quantity)) {
    throw conflict('The quantity is below the buyer\'s minimum delivery', 'BELOW_BUYER_MINIMUM');
  }
  if (quantity < demandRemaining && quantity < Number(batch.min_order_quantity || 0)) {
    throw conflict('The quantity is below the farm\'s minimum order', 'BELOW_FARM_MINIMUM');
  }
  const { exclusions, cancelledBuyerIds } = await loadExclusions(client, batch.id);
  if (exclusions.has(demand.id) || cancelledBuyerIds.has(buyer.id)) {
    throw conflict('This buyer or demand was rejected or cancelled for this batch. Run matching again.', 'MATCH_STALE');
  }
  // Allocation permits a final top-up below minimum quantities; those checks ran above.
  const finalTopUp = quantity === demandRemaining;
  const candidate = { ...demand, min_quantity: finalTopUp ? null : demand.min_quantity,
    buyer_type: buyer.buyer_type, region: buyer.region, preferred_collection_method: buyer.preferred_collection_method };
  const scored = scoreCandidate(finalTopUp ? { ...batch, min_order_quantity: 0 } : batch, candidate, { supplyRemaining: Number(batch.remaining_quantity) });
  if (scored.excluded) throw conflict(`${scored.reason}. Run matching again.`, 'MATCH_STALE');
  if (Number(scored.unitPrice) !== Number(match.unit_price)) {
    throw conflict('The farm or buyer price has changed. Run matching again before approving.', 'MATCH_STALE');
  }
  const fulfilment = estimateFulfilment(resolveMethod(buyer.preferred_collection_method, batch.fulfilment_methods), quantity, batch.fulfilment_costs);
  const netMargin = marginGuard({ unitPrice: scored.unitPrice, cost: batch.production_cost, minMarginPct: batch.min_margin_pct ?? 0, quantity, fulfilment: fulfilment.perKg, fulfilmentTotal: fulfilment.total });
  const review = {
    matchId, buyerName: buyer.organisation_name, produceName: batch.produce_name, unit: batch.unit,
    quantity, unitPrice: scored.unitPrice, revenue: round2(quantity * scored.unitPrice),
    scheduledDate: scored.effectiveRequiredDate, fulfilment, netMargin,
    requiresMarginOverride: netMargin.known && netMargin.status !== 'OK',
    warnings: [],
  };
  if (demand.max_price === null) review.warnings.push('The buyer has not set a price. Confirm the farm price with the buyer.');
  if (buyer.preferred_collection_method !== fulfilment.method) review.warnings.push('The buyer\'s preferred fulfilment method is unavailable. Confirm farm pickup with the buyer.');
  if (!netMargin.known) review.warnings.push(netMargin.message);
  const ownCosts = batch.fulfilment_costs?.[fulfilment.method];
  if (ownCosts?.perOrder === undefined || ownCosts?.perKg === undefined) review.warnings.push('Fulfilment includes platform cost estimates. Record your farm costs in Settings for a more accurate margin.');
  // An acknowledgement applies only to these exact commercial terms, including the edited quantity.
  review.quoteToken = createHash('sha256').update(JSON.stringify(review)).digest('hex');
  return { match, batch, review };
}

export async function previewApproval(user, matchId, input) {
  const d = validate(approveSchema, input);
  return withTransaction(async (client) => (await prepareApproval(client, user, matchId, d)).review);
}

/**
 * Farm admin approves a HarvestMatch suggestion (optionally with an edited quantity).
 * Creates the order, order item and allocation atomically; over-allocation is rejected.
 */
export async function approveMatch(user, matchId, input, ip) {
  const d = validate(approveSchema, input);
  const result = await withTransaction(async (client) => {
    const { match, review } = await prepareApproval(client, user, matchId, d);
    if (d.quoteToken && d.quoteToken !== review.quoteToken) {
      throw new AppError('Commercial terms changed. Review the updated estimate before approving.', 409, 'APPROVAL_QUOTE_CHANGED', review);
    }
    if (review.requiresMarginOverride && (!d.marginOverrideReason || d.quoteToken !== review.quoteToken)) {
      throw new AppError('Margin is below the farm minimum after fulfilment. Review the estimate and record a reason to proceed.', 409, 'MARGIN_REVIEW_REQUIRED', review);
    }
    const quantity = review.quantity;

    const { order } = await createAllocatedOrder(client, {
      batchId: match.harvest_batch_id,
      buyerId: match.buyer_id,
      demandRequestId: match.demand_request_id,
      quantity,
      unitPrice: Number(match.unit_price),
      source: match.source === 'RECOVERY' ? 'RECOVERY' : 'HARVESTMATCH',
      status: 'CONFIRMED',
      collectionMethod: review.fulfilment.method,
      scheduledDate: review.scheduledDate,
      userId: user.id,
    });

    await client.query(
      `UPDATE harvest_matches SET status = 'APPROVED', approved_quantity = $1, order_id = $2, decision_note = $3,
              decided_by = $4, decided_at = NOW()
        WHERE id = $5`,
      [quantity, order.id, d.note || null, user.id, matchId]
    );
    await logAudit(
      {
        farmId: match.farm_id, userId: user.id, action: 'MATCH_APPROVED', entityType: 'harvest_match', entityId: matchId,
        details: { orderId: order.id, quantity, recommended: Number(match.recommended_quantity), unitPrice: review.unitPrice,
          scheduledDate: review.scheduledDate, fulfilment: review.fulfilment, netMargin: review.netMargin,
          marginOverrideReason: review.requiresMarginOverride ? d.marginOverrideReason : null }, ip,
      },
      client
    );
    return { match: await loadMatch(matchId, client), batch: toBatchDTO(await findBatchById(match.harvest_batch_id, client)), order };
  });

  const m = result.match;
  await notifyBuyer({
    buyerId: m.buyerId,
    farmId: m.farmId,
    type: 'ORDER_CONFIRMED',
    title: `Order #${result.order.id} confirmed`,
    body: `${result.batch.farmName} has confirmed ${m.approvedQuantity}${result.batch.unit} of ${result.batch.produceName} for ${result.order.scheduled_date} at $${Number(m.unitPrice).toFixed(2)}/${result.batch.unit}.`,
  });
  return { match: result.match, batch: result.batch, orderId: result.order.id };
}

export async function rejectMatch(user, matchId, input, ip) {
  const d = validate(rejectSchema, input);
  return withTransaction(async (client) => {
    const match = await lockMatch(client, matchId);
    assertFarmAdmin(user, match.farm_id);
    if (match.status !== 'SUGGESTED') {
      throw conflict(`This match has already been ${match.status.toLowerCase()}`, 'MATCH_NOT_PENDING');
    }
    await client.query(
      `UPDATE harvest_matches SET status = 'REJECTED', decision_note = $1, decided_by = $2, decided_at = NOW() WHERE id = $3`,
      [d.reason || null, user.id, matchId]
    );
    await logAudit(
      { farmId: match.farm_id, userId: user.id, action: 'MATCH_REJECTED', entityType: 'harvest_match', entityId: matchId, details: { reason: d.reason }, ip },
      client
    );
    return { match: await loadMatch(matchId, client) };
  });
}

/** Recent match decisions/suggestions across a farm's batches. */
export async function listMatchesForFarm(farmId, { status } = {}) {
  const params = [farmId];
  let where = 'hm.farm_id = $1 AND hm.status <> \'SUPERSEDED\'';
  if (status) {
    params.push(status.split(','));
    where += ` AND hm.status = ANY($${params.length}::text[])`;
  }
  const { rows } = await query(
    `SELECT hm.id, hm.harvest_batch_id, hm.demand_request_id, hm.source, hm.match_score, hm.recommended_quantity,
            hm.approved_quantity, hm.unit_price, hm.expected_revenue, hm.status, hm.order_id, hm.decided_at, hm.created_at, hm.market_route,
            bp.organisation_name AS buyer_name, bp.buyer_type, p.name AS produce_name, hb.harvest_date
       FROM harvest_matches hm
       JOIN buyer_profiles bp ON bp.id = hm.buyer_id
       JOIN harvest_batches hb ON hb.id = hm.harvest_batch_id
       JOIN produce p ON p.id = hb.produce_id
      WHERE ${where} ORDER BY hm.created_at DESC LIMIT 200`,
    params
  );
  return camelizeAll(rows);
}

/** Buyer view: matches the farm has approved for the buyer's demand (never internal suggestions). */
export async function listMatchesForBuyer(user) {
  if (!user.buyerId) return [];
  const { rows } = await query(
    `SELECT hm.id, hm.match_score, hm.reasons, hm.approved_quantity, hm.unit_price, hm.decided_at, hm.order_id,
            dr.id AS demand_request_id, dr.produce_name, dr.unit, dr.quantity AS demand_quantity, dr.required_date,
            hb.harvest_date, f.name AS farm_name, o.status AS order_status
       FROM harvest_matches hm
       JOIN demand_requests dr ON dr.id = hm.demand_request_id
       JOIN harvest_batches hb ON hb.id = hm.harvest_batch_id
       JOIN farms f ON f.id = hm.farm_id
       LEFT JOIN orders o ON o.id = hm.order_id
      WHERE hm.buyer_id = $1 AND hm.status = 'APPROVED'
      ORDER BY hm.decided_at DESC`,
    [user.buyerId]
  );
  return camelizeAll(rows);
}
