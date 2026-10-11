/**
 * HarvestMatch — transparent weighted scoring that ranks existing demand against a harvest batch.
 *
 * This is NOT machine learning. Every score is a documented rule (see config/rules.js) and every
 * recommendation carries human-readable reasons. The farm admin approves or rejects each one.
 */
import { withTransaction, query } from '../config/db.js';
import { ADJACENT_REGIONS, DEMAND_ROUTE_KEYS, buyerRoute } from '../config/rules.js';
import { getPolicy } from './policyService.js';
import { marginGuard } from './marginService.js';
import { estimateFulfilment, resolveMethod } from './fulfilmentService.js';
import { round2 } from '../utils/numbers.js';
import { addDays, daysBetween, todayISO } from '../utils/dates.js';
import { camelize } from '../utils/case.js';
import { notFound, conflict } from '../utils/errors.js';
import { lockBatch, findBatchById, toBatchDTO } from '../models/harvestModel.js';
import { getReliabilityStats } from './buyerService.js';
import { assertFarmAccess, assertFarmAdmin } from './farmAccessService.js';
import { logAudit } from './auditService.js';

const LABEL = {
  FARM_PICKUP: 'farm pickup',
  DELIVERY: 'delivery',
  COMMUNITY_DROP: 'community drop',
  CENTRAL_DROP: 'central drop',
};
const money = (n) => `$${Number(n).toFixed(2)}`;
const normalise = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Next occurrence of a recurring requirement on/after the supplied calendar date. */
export function effectiveRequiredDate(demand, onOrAfter) {
  const step = { WEEKLY: 7, BIWEEKLY: 14 }[demand.recurrence];
  const date = demand.required_date;
  if (!demand.recurrence || demand.recurrence === 'NONE' || date >= onOrAfter) return date;
  if (step) return addDays(date, Math.ceil(daysBetween(date, onOrAfter) / step) * step);
  // Keep the original day-of-month anchor; Jan 31 -> Feb 28 -> Mar 31.
  const [y, m, d] = date.split('-').map(Number);
  const [targetY, targetM] = onOrAfter.split('-').map(Number);
  const occurrence = (offset) => {
    const month = new Date(Date.UTC(y, m - 1 + offset, 1));
    const lastDay = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();
    return `${month.getUTCFullYear()}-${String(month.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(d, lastDay)).padStart(2, '0')}`;
  };
  const offset = (targetY - y) * 12 + targetM - m;
  const next = occurrence(offset);
  return next >= onOrAfter ? next : occurrence(offset + 1);
}

// ---- individual factor scores (0-100). Each returns { score, reason?, warning?, exclude? } ----

export function scoreProduce(batch, demand) {
  if (demand.produce_id && demand.produce_id === batch.produce_id) return { score: 100, reason: 'Exact produce match' };
  const a = normalise(batch.produce_name);
  const b = normalise(demand.produce_name);
  if (a === b) return { score: 100, reason: 'Exact produce match' };
  if (a.includes(b) || b.includes(a)) {
    return { score: 75, reason: `Close produce match (${demand.produce_name} ≈ ${batch.produce_name})` };
  }
  return { score: 0, exclude: 'Different produce' };
}

export function scoreDate(batch, demand, today = todayISO()) {
  const required = effectiveRequiredDate(demand, batch.harvest_date > today ? batch.harvest_date : today);
  const gap = daysBetween(batch.harvest_date, required);
  if (gap < 0) return { score: 0, exclude: `Required ${-gap} day(s) before harvest date`, required };
  if (required < today) return { score: 0, exclude: 'Required date has already passed', required };
  const freshness = Math.min(getPolicy().freshnessWindowDays, Number(batch.shelf_life_days) || getPolicy().defaultShelfLifeDays);
  if (gap > freshness) {
    return { score: 0, exclude: `Required ${gap} days after harvest — beyond ${freshness}-day freshness window`, required };
  }
  if (gap <= 2) return { score: 100, reason: 'Required date matches harvest window', required };
  if (gap <= 4) return { score: 75, reason: `Required ${gap} days after harvest`, required };
  return { score: 45, reason: `Required ${gap} days after harvest`, warning: `Produce will be ${gap} days post-harvest at fulfilment`, required };
}

/** Price compatibility. Also returns the unit price the order would use. */
export function scorePrice(batch, demand) {
  const min = Number(batch.min_price);
  const preferred = Number(batch.preferred_price);
  const max = demand.max_price === null || demand.max_price === undefined ? null : Number(demand.max_price);

  if (max === null) {
    return {
      score: 70,
      unitPrice: preferred,
      reason: 'Buyer has not set a price — farm preferred price applied',
      warning: 'Confirm price with buyer',
    };
  }
  if (max < min) {
    return { score: 0, unitPrice: null, exclude: `Buyer max price ${money(max)} is below farm minimum ${money(min)}` };
  }
  if (max >= preferred) return { score: 100, unitPrice: preferred, reason: 'Buyer price meets farm preferred price' };
  const span = preferred - min;
  const score = span > 0 ? Math.round(50 + (50 * (max - min)) / span) : 100;
  return { score, unitPrice: max, reason: `Buyer price ${money(max)} meets farm minimum` };
}

/**
 * Quantity fit, including minimum order quantities:
 *  - buyerMin: the smallest delivery the buyer will accept;
 *  - farmMoq: the farm's minimum order for this produce (smaller requests can go through DemandPool).
 */
export function scoreQuantity(demandRemaining, supplyRemaining, unit = 'kg', { buyerMin = null, farmMoq = 0 } = {}) {
  if (supplyRemaining <= 0) return { score: 0, exclude: 'No unallocated supply remaining' };
  if (farmMoq > 0 && demandRemaining < farmMoq) {
    return { score: 0, exclude: `Request of ${round2(demandRemaining)}${unit} is below the farm minimum order of ${farmMoq}${unit} — consider DemandPool` };
  }
  if (buyerMin && supplyRemaining < buyerMin) {
    return { score: 0, exclude: `Only ${round2(supplyRemaining)}${unit} available; buyer's minimum delivery is ${buyerMin}${unit}` };
  }
  if (demandRemaining <= supplyRemaining) return { score: 100, reason: 'Requested quantity fits available supply' };
  const ratio = supplyRemaining / demandRemaining;
  return {
    score: Math.max(20, Math.round(ratio * 100)),
    reason: `Can partially supply ${round2(supplyRemaining)}${unit} of ${round2(demandRemaining)}${unit} requested`,
  };
}

export function scoreReliability(stats) {
  if (!stats) return { score: getPolicy().neutralReliabilityScore, reason: 'Limited order history — neutral reliability score applied' };
  const score = Math.round((stats.completed / stats.total) * 100);
  return {
    score,
    reason: `Completed ${stats.completed} of ${stats.total} past orders`,
    warning: score < 50 ? 'Buyer has a history of cancellations' : undefined,
  };
}

export function scoreLocation(batch, buyer) {
  const methods = batch.fulfilment_methods || [];
  const method = buyer.preferred_collection_method;
  let score;
  let reason;
  if (!buyer.region || !batch.farm_region) {
    score = 60;
    reason = 'Location not specified — neutral location score';
  } else if (buyer.region === batch.farm_region) {
    score = 100;
    reason = 'Buyer is in the same region as the farm';
  } else if ((ADJACENT_REGIONS[batch.farm_region] || []).includes(buyer.region)) {
    score = 75;
    reason = 'Buyer is in a neighbouring region';
  } else {
    score = 50;
    reason = 'Buyer is in a distant region';
  }
  if (method && !methods.includes(method)) {
    return { score: Math.round(score * 0.4), reason, warning: `Buyer prefers ${LABEL[method]}, which the farm does not currently offer` };
  }
  return { score, reason: `${reason}; ${LABEL[method] || 'collection'} supported` };
}

/**
 * Scores one demand candidate against a batch. Pure function: no I/O.
 * Returns { excluded: true, reason } or a scored candidate with weighted total and reasons.
 */
export function scoreCandidate(batch, demand, { supplyRemaining, reliability, today = todayISO() }) {
  if (batch.allowed_routes?.length && !batch.allowed_routes.includes(buyerRoute(demand.buyer_type))) {
    return { excluded: true, reason: 'Buyer route is excluded by this batch\'s commercial constraints' };
  }
  if (demand.unit && batch.unit && demand.unit !== batch.unit) return { excluded: true, reason: 'Demand and harvest use different units' };
  const demandRemaining = round2(Number(demand.quantity) - Number(demand.fulfilled_quantity || 0));
  const factors = {
    produce: scoreProduce(batch, demand),
    date: scoreDate(batch, demand, today),
    price: scorePrice(batch, demand),
    quantity: scoreQuantity(demandRemaining, supplyRemaining, batch.unit, {
      buyerMin: demand.min_quantity ? Number(demand.min_quantity) : null,
      farmMoq: Number(batch.min_order_quantity || 0),
    }),
    reliability: scoreReliability(reliability),
    location: scoreLocation(batch, demand),
  };
  const blocker = Object.values(factors).find((f) => f.exclude);
  if (blocker) return { excluded: true, reason: blocker.exclude };

  // Margin Guard is advisory: it never changes the score, it warns the farmer.
  const margin = marginGuard({ unitPrice: factors.price.unitPrice, cost: batch.production_cost, minMarginPct: batch.min_margin_pct ?? 0 });
  if (margin.known && margin.status !== 'OK') factors.margin = { warning: margin.message };

  let total = 0;
  const breakdown = {};
  for (const [key, weight] of Object.entries(getPolicy().matchWeights)) {
    const contribution = (factors[key].score * weight) / 100;
    total += contribution;
    breakdown[key] = { score: factors[key].score, weight, contribution: round2(contribution) };
  }

  return {
    excluded: false,
    matchScore: Math.round(total),
    breakdown,
    reasons: Object.values(factors).map((f) => f.reason).filter(Boolean),
    warnings: Object.values(factors).map((f) => f.warning).filter(Boolean),
    unitPrice: factors.price.unitPrice,
    demandRemaining,
    effectiveRequiredDate: factors.date.required,
  };
}

/**
 * Ranks candidates and assigns recommended quantities greedily in score order so the
 * total recommended never exceeds the batch's unallocated quantity.
 */
export function rankAndAllocate(batch, candidates, context) {
  const supply = round2(Number(batch.remaining_quantity));
  const scored = [];
  const excluded = [];

  for (const demand of candidates) {
    const exclusion = context.exclusions?.get(demand.id);
    if (exclusion) {
      excluded.push(describeExcluded(demand, exclusion));
      continue;
    }
    const result = scoreCandidate(batch, demand, {
      supplyRemaining: supply,
      reliability: context.reliability?.get(demand.buyer_id) ?? null,
      today: context.today,
    });
    if (result.excluded) {
      if (result.reason !== 'Different produce') excluded.push(describeExcluded(demand, result.reason));
      continue;
    }
    scored.push({ demand, ...result });
  }

  scored.sort((a, b) => b.matchScore - a.matchScore || a.effectiveRequiredDate.localeCompare(b.effectiveRequiredDate) || a.demand.id - b.demand.id);

  let remaining = supply;
  const matches = [];
  for (const c of scored) {
    const qty = round2(Math.min(c.demandRemaining, remaining));
    if (qty <= 0) {
      excluded.push(describeExcluded(c.demand, 'No supply left after higher-ranked matches'));
      continue;
    }
    if (c.demand.min_quantity && qty < Number(c.demand.min_quantity)) {
      excluded.push(describeExcluded(c.demand, `Supply left after higher-ranked matches (${qty}${batch.unit}) is below the buyer's minimum of ${c.demand.min_quantity}${batch.unit}`));
      continue;
    }
    remaining = round2(remaining - qty);
    matches.push({ ...c, recommendedQuantity: qty, expectedRevenue: round2(qty * c.unitPrice) });
  }
  return { matches, excluded, supply, unmatchedQuantity: remaining };
}

/**
 * Demand Radar "Potential Demand": open, unconfirmed demand whose produce and timing fit the batch
 * (price and quantity are not yet considered — this is the raw demand signal).
 */
export function potentialDemandFor(batch, candidates) {
  let total = 0;
  let requests = 0;
  for (const d of candidates) {
    if (scoreProduce(batch, d).exclude || scoreDate(batch, d).exclude) continue;
    total += Number(d.quantity) - Number(d.fulfilled_quantity || 0);
    requests += 1;
  }
  return { quantity: round2(total), requests };
}

/** Open demand visible to a farm (directed to it, or open-market). */
export async function loadOpenDemandForFarm(farmId, client) {
  const runner = client || { query };
  const { rows } = await runner.query(
    `SELECT dr.*, bp.organisation_name, bp.buyer_type, bp.region, bp.preferred_collection_method
       FROM demand_requests dr
       JOIN buyer_profiles bp ON bp.id = dr.buyer_id AND bp.is_active
      WHERE dr.status IN ('OPEN', 'PARTIALLY_FULFILLED')
        AND dr.quantity > dr.fulfilled_quantity
        AND (dr.farm_id IS NULL OR dr.farm_id = $1)`,
    [farmId]
  );
  return rows;
}

function describeExcluded(demand, reason) {
  return {
    demandRequestId: demand.id,
    buyerId: demand.buyer_id,
    buyerName: demand.organisation_name,
    buyerType: demand.buyer_type,
    quantity: round2(Number(demand.quantity) - Number(demand.fulfilled_quantity || 0)),
    reason,
  };
}

// ---------------------------------------------------------------- persistence

/**
 * Demand that must not be recommended for this batch:
 *  - the farm already rejected this demand for this batch;
 *  - the buyer cancelled an order on this batch (don't immediately re-offer the same stock).
 */
export async function loadExclusions(client, batchId) {
  const exclusions = new Map();
  const rejected = await client.query(
    `SELECT DISTINCT demand_request_id FROM harvest_matches WHERE harvest_batch_id = $1 AND status = 'REJECTED'`,
    [batchId]
  );
  for (const r of rejected.rows) exclusions.set(r.demand_request_id, 'Previously rejected by farm for this batch');

  const cancelledBuyers = await client.query(
    `SELECT DISTINCT o.buyer_id FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE oi.harvest_batch_id = $1 AND o.status = 'CANCELLED'`,
    [batchId]
  );
  return { exclusions, cancelledBuyerIds: new Set(cancelledBuyers.rows.map((r) => r.buyer_id)) };
}

/** Everything scoring needs for one batch: open demand, exclusions and buyer reliability. Shared with MarketRoute. */
export async function loadMatchingContext(client, batch) {
  const candidates = await loadOpenDemandForFarm(batch.farm_id, client);
  const { exclusions, cancelledBuyerIds } = await loadExclusions(client, batch.id);
  for (const c of candidates) {
    if (!exclusions.has(c.id) && cancelledBuyerIds.has(c.buyer_id)) {
      exclusions.set(c.id, 'Buyer cancelled an order for this batch');
    }
  }
  const reliability = await getReliabilityStats([...new Set(candidates.map((c) => c.buyer_id))], client);
  return { candidates, exclusions, reliability };
}

/**
 * Runs HarvestMatch (or Demand Recovery) for a batch and stores the suggestions.
 * Previous unactioned suggestions for the batch are superseded. Nothing is allocated here —
 * allocation only happens when the farm admin approves a match.
 */
export async function runMatching(user, batchId, { runType = 'HARVESTMATCH', trigger = null, route = null, ip } = {}, existingClient) {
  return withTransaction(async (client) => {
    const batch = await lockBatch(batchId, client);
    if (!batch) throw notFound('Harvest batch not found');
    assertFarmAdmin(user, batch.farm_id);
    if (batch.status === 'CLOSED') throw conflict('Matching cannot run on a closed batch', 'BATCH_CLOSED');
    if (route && !DEMAND_ROUTE_KEYS.includes(route)) throw conflict(`HarvestMatch cannot run within the ${route} route`, 'ROUTE_NOT_MATCHABLE');
    if (route && batch.allowed_routes?.length && !batch.allowed_routes.includes(route)) {
      throw conflict('This route is excluded by the batch\'s commercial constraints', 'ROUTE_EXCLUDED');
    }

    const ctx = await loadMatchingContext(client, batch);
    // Within a route (proposal §8.3): only buyers in that channel are ranked.
    const candidates = route ? ctx.candidates.filter((c) => buyerRoute(c.buyer_type) === route) : ctx.candidates;
    const result = rankAndAllocate(batch, candidates, ctx);

    await client.query(
      `UPDATE harvest_matches SET status = 'SUPERSEDED' WHERE harvest_batch_id = $1 AND status = 'SUGGESTED'`,
      [batchId]
    );
    // "Existing customers" = buyers with a completed order from this farm; "subscribers" = recurring demand.
    const existing = await client.query(
      `SELECT DISTINCT buyer_id FROM orders WHERE farm_id = $1 AND status = 'COMPLETED'`,
      [batch.farm_id]
    );
    const summary = buildSummary(result, new Set(existing.rows.map((r) => r.buyer_id)));
    const run = await client.query(
      `INSERT INTO match_runs (farm_id, harvest_batch_id, run_type, trigger_reason, remaining_quantity,
                               candidates_count, excluded, summary, created_by, market_route)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [batch.farm_id, batchId, runType, trigger, result.supply, result.matches.length,
        JSON.stringify(result.excluded), JSON.stringify(summary), user.id, route]
    );
    const runId = run.rows[0].id;

    for (const m of result.matches) {
      await client.query(
        `INSERT INTO harvest_matches (farm_id, run_id, harvest_batch_id, demand_request_id, buyer_id, source, match_score,
                                      score_breakdown, reasons, warnings, recommended_quantity, unit_price, expected_revenue, market_route)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [batch.farm_id, runId, batchId, m.demand.id, m.demand.buyer_id, runType, m.matchScore,
          JSON.stringify(m.breakdown), JSON.stringify(m.reasons), JSON.stringify(m.warnings),
          m.recommendedQuantity, m.unitPrice, m.expectedRevenue, buyerRoute(m.demand.buyer_type)]
      );
    }

    await logAudit(
      {
        farmId: batch.farm_id,
        userId: user.id,
        action: runType === 'RECOVERY' ? 'RECOVERY_STARTED' : 'HARVESTMATCH_RUN',
        entityType: 'harvest_batch',
        entityId: batchId,
        details: { runId, trigger, route, matches: result.matches.length, excluded: result.excluded.length },
        ip,
      },
      client
    );

    return { run: camelize(run.rows[0]), ...(await getMatchesForBatch(user, batchId, client)) };
  }, existingClient);
}

/** Groups strong matches by MarketRoute for the recovery view; weak matches are reported separately. */
export function buildSummary(result, existingCustomerIds = new Set()) {
  const threshold = getPolicy().strongMatchThreshold;
  const routes = Object.fromEntries(DEMAND_ROUTE_KEYS.map((k) => [k, 0]));
  let strongTotal = 0;
  let weakTotal = 0;
  let existingCustomers = 0;
  let subscribers = 0;
  for (const m of result.matches) {
    if (m.matchScore >= threshold) {
      const r = buyerRoute(m.demand.buyer_type);
      routes[r] = round2(routes[r] + m.recommendedQuantity);
      strongTotal = round2(strongTotal + m.recommendedQuantity);
      if (existingCustomerIds.has(m.demand.buyer_id)) existingCustomers = round2(existingCustomers + m.recommendedQuantity);
      if (m.demand.recurrence && m.demand.recurrence !== 'NONE') subscribers = round2(subscribers + m.recommendedQuantity);
    } else {
      weakTotal = round2(weakTotal + m.recommendedQuantity);
    }
  }
  // Small requests excluded only because they are below the farm MOQ can still be served together.
  const demandPoolCandidates = result.excluded.filter((e) => /below the farm minimum order/.test(e.reason));
  return {
    remainingAtStart: result.supply,
    strongMatchThreshold: threshold,
    potentialByRoute: routes,
    potentialFromExistingCustomers: existingCustomers,
    potentialFromSubscribers: subscribers,
    potentialStrongTotal: strongTotal,
    potentialWeakTotal: weakTotal,
    demandPoolQuantity: round2(demandPoolCandidates.reduce((s, e) => s + e.quantity, 0)),
    demandPoolRequests: demandPoolCandidates.length,
    remainingAfterStrong: round2(result.supply - strongTotal),
  };
}

const MATCH_SELECT = `
  SELECT hm.*, bp.organisation_name AS buyer_name, bp.buyer_type, bp.region AS buyer_region,
         bp.preferred_collection_method,
         dr.quantity AS demand_quantity, dr.fulfilled_quantity AS demand_fulfilled_quantity,
         dr.required_date, dr.max_price, dr.recurrence, dr.produce_name AS demand_produce_name,
         u.full_name AS decided_by_name, o.scheduled_date
    FROM harvest_matches hm
    JOIN buyer_profiles bp ON bp.id = hm.buyer_id
    JOIN demand_requests dr ON dr.id = hm.demand_request_id
    LEFT JOIN users u ON u.id = hm.decided_by
    LEFT JOIN orders o ON o.id = hm.order_id`;

/** Current suggestions plus decided matches for a batch, with the latest run's exclusions. */
export async function getMatchesForBatch(user, batchId, client) {
  const runner = client || { query };
  const batchRow = (await runner.query('SELECT farm_id FROM harvest_batches WHERE id = $1', [batchId])).rows[0];
  if (!batchRow) throw notFound('Harvest batch not found');
  assertFarmAccess(user, batchRow.farm_id);

  const batch = toBatchDTO(await findBatchById(batchId, client));
  const { rows } = await runner.query(
    `${MATCH_SELECT} WHERE hm.harvest_batch_id = $1 AND hm.status <> 'SUPERSEDED'
      ORDER BY (hm.status = 'SUGGESTED') DESC, hm.match_score DESC, hm.id`,
    [batchId]
  );
  const lastRun = (
    await runner.query('SELECT * FROM match_runs WHERE harvest_batch_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [batchId])
  ).rows[0];

  // Decision support: fulfilment terms and cost, margin before and after fulfilment (Margin Guard), urgency.
  const decorate = (row) => {
    const m = camelize(row);
    const qty = Number(m.approvedQuantity ?? m.recommendedQuantity);
    const guard = { unitPrice: m.unitPrice, cost: batch.productionCost, minMarginPct: batch.minMarginPct ?? 0, quantity: qty };
    m.marketRoute = m.marketRoute || buyerRoute(m.buyerType);
    m.fulfilment = estimateFulfilment(resolveMethod(m.preferredCollectionMethod, batch.fulfilmentMethods), qty, batch.fulfilmentCosts);
    m.margin = marginGuard(guard);
    m.netMargin = marginGuard({ ...guard, fulfilment: m.fulfilment.perKg, fulfilmentTotal: m.fulfilment.total });
    const today = todayISO();
    m.effectiveRequiredDate = m.scheduledDate || (m.status === 'SUGGESTED'
      ? effectiveRequiredDate({ recurrence: m.recurrence, required_date: m.requiredDate }, batch.harvestDate > today ? batch.harvestDate : today)
      : m.requiredDate);
    m.urgency = batch.routing?.urgency || null;
    return m;
  };

  return {
    batch,
    matches: rows.map(decorate),
    lastRun: lastRun ? camelize(lastRun) : null,
  };
}

export { MATCH_SELECT };
