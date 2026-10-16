import { z } from 'zod';
import { query, withTransaction } from '../config/db.js';
import { listBuyersForFarm } from './buyerService.js';
import { assertFarmAdmin } from './farmAccessService.js';
import { camelizeAll } from '../utils/case.js';
import { validate } from '../utils/validate.js';
import { notFound, conflict } from '../utils/errors.js';
import { logAudit } from './auditService.js';
import { createMultiLineOrder } from './allocationService.js';

export async function buyerGrowth(farmId) {
  const buyers = await listBuyersForFarm(farmId);
  const [history, relationships, demand, supply] = await Promise.all([
    query(`SELECT o.buyer_id, MAX(o.completed_at) AS last_purchase,
      COUNT(*) FILTER (WHERE o.status='COMPLETED') AS completed_orders,
      COALESCE(SUM(o.total_amount) FILTER (WHERE o.status='COMPLETED'),0) AS collected_revenue,
      COALESCE(json_agg(json_build_object('id',o.id,'status',o.status,'total',o.total_amount,'date',o.created_at) ORDER BY o.created_at DESC), '[]') AS history
      FROM orders o WHERE o.farm_id=$1 GROUP BY o.buyer_id`, [farmId]),
    query('SELECT * FROM buyer_relationships WHERE farm_id=$1', [farmId]),
    query(`SELECT dr.buyer_id, dr.produce_name, dr.quantity, dr.recurrence, dr.required_date, dr.status
      FROM demand_requests dr WHERE (dr.farm_id=$1 OR dr.farm_id IS NULL) AND dr.status IN ('OPEN','PARTIALLY_FULFILLED')`, [farmId]),
    query(`SELECT p.id AS produce_id, p.name, hb.id AS batch_id, hb.preferred_price AS price, bs.remaining_quantity AS available
      FROM harvest_batches hb JOIN produce p ON p.id=hb.produce_id JOIN batch_stock bs ON bs.harvest_batch_id=hb.id
      WHERE hb.farm_id=$1 AND hb.status <> 'CLOSED' AND hb.harvest_date >= CURRENT_DATE AND bs.remaining_quantity>0 ORDER BY hb.harvest_date LIMIT 12`, [farmId]),
  ]);
  return buyers.map(b => {
    const h = camelizeAll(history.rows).find(x => x.buyerId === b.id) || {};
    const r = camelizeAll(relationships.rows).find(x => x.buyerId === b.id) || {};
    const daysSincePurchase = h.lastPurchase ? Math.floor((Date.now() - new Date(h.lastPurchase)) / 86400000) : null;
    return { ...b, ...h, notes: r.notes || '', nextFollowUp: r.nextFollowUp, daysSincePurchase,
      segment: daysSincePurchase === null ? 'NEW' : daysSincePurchase >= 30 ? 'REACTIVATE' : h.completedOrders >= 2 ? 'REPEAT' : 'ACTIVE',
      requirements: camelizeAll(demand.rows).filter(x => x.buyerId === b.id),
      availableOffers: camelizeAll(supply.rows).slice(0, 4) };
  });
}

export async function saveRelationship(user, farmId, buyerId, input, ip) {
  assertFarmAdmin(user, farmId);
  const buyers = await listBuyersForFarm(farmId);
  if (!buyers.some(b => b.id === buyerId)) throw notFound('Buyer not found for this farm');
  const d = validate(z.object({ notes: z.string().trim().max(3000), nextFollowUp: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable() }), input);
  await query(`INSERT INTO buyer_relationships (farm_id,buyer_id,notes,next_follow_up) VALUES ($1,$2,$3,$4)
    ON CONFLICT (farm_id,buyer_id) DO UPDATE SET notes=EXCLUDED.notes,next_follow_up=EXCLUDED.next_follow_up,updated_at=NOW()`, [farmId,buyerId,d.notes,d.nextFollowUp]);
  await logAudit({ farmId, userId:user.id,action:'BUYER_RELATIONSHIP_UPDATED',entityType:'buyer_profile',entityId:buyerId,ip });
  return d;
}

export async function reorderQuote(user, id) {
  const order = (await query('SELECT * FROM orders WHERE id=$1 AND buyer_id=$2', [id,user.buyerId])).rows[0];
  if (!order) throw notFound('Order not found');
  if (order.shop_listing_id || order.source === 'RESCUE') throw conflict('Choose a current Shop or Rescue offer to buy again', 'OFFER_REQUIRED');
  const { rows } = await query(`SELECT oi.produce_id, p.name, p.unit, SUM(oi.quantity)::numeric AS quantity,
    (SELECT hb.id FROM harvest_batches hb JOIN batch_stock bs ON bs.harvest_batch_id=hb.id
     WHERE hb.produce_id=oi.produce_id AND hb.farm_id=$2 AND hb.status <> 'CLOSED' AND hb.harvest_date>=CURRENT_DATE
     AND bs.remaining_quantity >= SUM(oi.quantity) ORDER BY hb.harvest_date LIMIT 1) AS harvest_batch_id
     FROM order_items oi JOIN produce p ON p.id=oi.produce_id WHERE oi.order_id=$1 GROUP BY oi.produce_id,p.name,p.unit`, [id,order.farm_id]);
  const items = [];
  for (const r of rows) {
    if (!r.harvest_batch_id) throw conflict(`No current harvest can fulfil ${r.name}. Browse available supply or post demand.`, 'REORDER_UNAVAILABLE');
    const b = (await query('SELECT preferred_price FROM harvest_batches WHERE id=$1',[r.harvest_batch_id])).rows[0];
    items.push({ harvestBatchId:r.harvest_batch_id, produceName:r.name, quantity:r.quantity, unit:r.unit, price:b.preferred_price });
  }
  return { items, collectionMethod: order.collection_method === 'COMMUNITY_DROP' ? 'FARM_PICKUP' : order.collection_method,
    total: Math.round(items.reduce((s,i)=>s+i.quantity*i.price,0)*100)/100 };
}

export async function reorder(user, id, input, ip) {
  const d = validate(z.object({ expectedTotal:z.coerce.number().nonnegative() }),input);
  const quote = await reorderQuote(user,id);
  return withTransaction(async client => {
    const order = await createMultiLineOrder(client,{ buyerId:user.buyerId, userId:user.id,
      lines:quote.items.map(i=>({batchId:i.harvestBatchId,quantity:i.quantity})),collectionMethod:quote.collectionMethod,notes:`Reorder of #${id}` });
    if (Math.abs(order.total_amount-d.expectedTotal)>0.001) throw conflict('Prices changed. Review a fresh quote before reordering.', 'PRICE_CHANGED');
    await logAudit({farmId:order.farm_id,userId:user.id,action:'ORDER_REORDERED',entityType:'order',entityId:order.id,details:{originalOrderId:id},ip},client);
    return {id:order.id};
  });
}
