/**
 * MarketRoute — compares commercial routes for a harvest batch before individual buyers are matched
 * (proposal v3 §8.2). It does not assume the highest-volume buyer is the best outcome: each route gets a
 * transparent, rule-based Commercial Route Score from demand fit, price, margin after fulfilment, order
 * volume, logistics responsibility, buyer reliability and urgency against remaining shelf life.
 *
 * Recommendations only. The farm selects a route, then HarvestMatch ranks buyers within it.
 */
import { z } from 'zod';
import { query, withTransaction } from '../config/db.js';
import {
  MARKET_ROUTES, ROUTE_KEYS, DEMAND_ROUTE_KEYS, LOGISTICS_SCORE, LOGISTICS_RESPONSIBILITY,
  ROUTE_VOLUME_REFERENCE_KG, RESCUE_DEMAND_FIT, buyerRoute,
} from '../config/rules.js';
import { getPolicy } from './policyService.js';
import { marginGuard } from './marginService.js';
import { estimateFulfilment, resolveMethod } from './fulfilmentService.js';
import { rankAndAllocate, loadMatchingContext, loadOpenDemandForFarm, runMatching, scoreProduce } from './harvestMatchService.js';
import { getReliabilityStats } from './buyerService.js';
import { suggestRescuePrice } from './rescueService.js';
import { routingFor } from './routingService.js';
import { assertFarmAccess, assertFarmAdmin } from './farmAccessService.js';
import { logAudit } from './auditService.js';
import { findBatchById, toBatchDTO } from '../models/harvestModel.js';
import { validate } from '../utils/validate.js';
import { camelize, camelizeAll } from '../utils/case.js';
import { notFound, conflict } from '../utils/errors.js';
import { round2 } from '../utils/numbers.js';
import { daysBetween, todayISO } from '../utils/dates.js';

const money = (n) => `$${Number(n).toFixed(2)}`;
const METHOD_LABEL = { FARM_PICKUP: 'Buyer pickup', CENTRAL_DROP: 'Central drop', COMMUNITY_DROP: 'Collection point', DELIVERY: 'Farm delivery' };
const RESPONSIBILITY_LABEL = { BUYER: 'buyer handles logistics', SHARED: 'shared with a distribution partner', FARM: 'farm handles logistics' };

// ---------------------------------------------------------------- factor scores (0–100)

/** At or above preferred = 100; minimum..preferred scales 50–100; below the farm minimum scales 0–40. */
export function routePriceScore(price, min, preferred) {
  if (price >= preferred) return 100;
  if (price >= min) return preferred > min ? Math.round(50 + (50 * (price - min)) / (preferred - min)) : 100;
  return min > 0 ? Math.max(0, Math.round((40 * price) / min)) : 0;
}

/** Margin after fulfilment: loss = 0; otherwise scaled so twice the farm minimum (at least 20%) = 100. Unknown cost = neutral. */
export function routeMarginScore(guard, neutral) {
  if (!guard.known) return neutral;
  if (guard.status === 'LOSS') return 0;
  const reference = Math.max(2 * guard.minMarginPct, 20);
  return Math.min(100, Math.round((guard.pct / reference) * 100));
}

/** Can the route sell before shelf life runs out? Lead within half the sell window = 100, within it = 70, else 30. */
export function routeUrgencyScore(leadDays, sellDays) {
  if (leadDays <= sellDays / 2) return 100;
  if (leadDays <= sellDays) return 70;
  return 30;
}

/** Days from today until the batch's commercial window (shelf life after harvest) closes. */
export function sellWindowDays(batch, today = todayISO()) {
  const shelf = Number(batch.shelf_life_days) || getPolicy().defaultShelfLifeDays;
  return Math.max(0, shelf - daysBetween(batch.harvest_date, today));
}

const weighted = (lines, pick) => {
  const qty = lines.reduce((s, l) => s + l.quantity, 0);
  return qty > 0 ? lines.reduce((s, l) => s + pick(l) * l.quantity, 0) / qty : 0;
};

/**
 * Scores one route from its "lines" — live matched demand, or a single profile-based estimate when the
 * route has no demand yet. Pure function.
 */
function scoreRoute(key, batch, lines, { demandFit, demandReason, live, sellDays, today }) {
  const policy = getPolicy();
  const profile = MARKET_ROUTES[key];
  const unit = batch.unit || 'kg';
  const qty = round2(lines.reduce((s, l) => s + l.quantity, 0));
  const orders = lines.reduce((s, l) => s + l.orders, 0);
  const avgPrice = round2(weighted(lines, (l) => l.unitPrice));

  let fulfilmentTotal = 0;
  const methods = new Map();
  for (const l of lines) {
    const est = estimateFulfilment(l.method, l.quantity, batch.fulfilment_costs, l.orders);
    fulfilmentTotal += est.total;
    methods.set(l.method, round2((methods.get(l.method) || 0) + l.quantity));
  }
  const fulfilmentPerKg = qty > 0 ? round2(fulfilmentTotal / qty) : 0;
  const mainMethod = [...methods.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || profile.method;

  const guard = marginGuard({
    unitPrice: avgPrice, cost: batch.production_cost, minMarginPct: batch.min_margin_pct ?? 0, quantity: qty, fulfilment: fulfilmentPerKg, fulfilmentTotal,
  });
  const avgOrderKg = orders > 0 ? qty / orders : 0;
  const lead = round2(weighted(lines, (l) => l.leadDays));
  const reliability = Math.round(weighted(lines, (l) => l.reliability));
  const min = Number(batch.min_price);
  const preferred = Number(batch.preferred_price);

  const factors = {
    demandFit: { score: demandFit, reason: demandReason },
    price: {
      score: routePriceScore(avgPrice, min, preferred),
      reason: live
        ? `Average achievable price ${money(avgPrice)}/${unit} (preferred ${money(preferred)}, minimum ${money(min)})`
        : `Estimated ${money(avgPrice)}/${unit} — ${key === 'RESCUE' ? 'rule-based Rescue price' : `typically ${Math.round(profile.priceIndex * 100)}% of your preferred price`}`,
      warning: avgPrice < min && key !== 'RESCUE' ? `Below your minimum price of ${money(min)}` : undefined,
    },
    margin: {
      score: routeMarginScore(guard, policy.neutralReliabilityScore),
      reason: guard.known ? guard.message : 'Production cost not recorded — neutral margin score',
      warning: guard.known && guard.status !== 'OK' ? guard.message : undefined,
    },
    volume: {
      score: Math.min(100, Math.round((avgOrderKg / ROUTE_VOLUME_REFERENCE_KG) * 100)),
      reason: `${live ? 'Average' : 'Typical'} order ${round2(avgOrderKg)}${unit} → ${orders} order(s) to fulfil`,
    },
    fulfilment: {
      score: Math.round(weighted(lines, (l) => LOGISTICS_SCORE[l.method] ?? 50)),
      reason: `${METHOD_LABEL[mainMethod]} — ${RESPONSIBILITY_LABEL[LOGISTICS_RESPONSIBILITY[mainMethod]]}, est. ${money(fulfilmentPerKg)}/${unit}`,
    },
    reliability: {
      score: reliability,
      reason: live && lines.some((l) => l.hasHistory) ? `Buyer reliability ${reliability}% (completed vs cancelled orders)` : 'Limited order history — neutral reliability',
    },
    urgency: {
      score: routeUrgencyScore(lead, sellDays),
      reason: `${sellDays} sell day(s) left in the shelf-life window; route needs about ${Math.ceil(lead)} day(s)`,
      warning: lead > sellDays ? 'May not sell through this route before the shelf-life window closes' : undefined,
    },
  };

  let total = 0;
  const breakdown = {};
  for (const [k, weight] of Object.entries(policy.routeWeights)) {
    const contribution = (factors[k].score * weight) / 100;
    total += contribution;
    breakdown[k] = { score: factors[k].score, weight, contribution: round2(contribution) };
  }

  return {
    key,
    label: profile.label,
    score: Math.round(total),
    breakdown,
    reasons: Object.values(factors).map((f) => f.reason).filter(Boolean),
    warnings: Object.values(factors).map((f) => f.warning).filter(Boolean),
    live,
    averagePrice: avgPrice,
    expectedRevenue: round2(avgPrice * qty),
    orders,
    fulfilment: {
      method: mainMethod,
      responsibility: LOGISTICS_RESPONSIBILITY[mainMethod],
      total: round2(fulfilmentTotal),
      perKg: fulfilmentPerKg,
      methods: Object.fromEntries(methods),
    },
    margin: guard,
    leadDays: lead,
  };
}

function demandRouteAssessment(key, batch, candidates, ctx, env) {
  const profile = MARKET_ROUTES[key];
  const remaining = env.remaining;
  const unit = batch.unit || 'kg';
  // Requests from this route's buyers for this produce (other crops are not part of the comparison).
  const subset = candidates.filter((c) => buyerRoute(c.buyer_type) === key && !scoreProduce(batch, c).exclude);
  const ranked = rankAndAllocate(batch, subset, ctx);
  const matches = ranked.matches;
  const coverable = round2(matches.reduce((s, m) => s + m.recommendedQuantity, 0));
  const demandQuantity = round2(subset.reduce((s, c) => s + Number(c.quantity) - Number(c.fulfilled_quantity || 0), 0));
  const offered = batch.fulfilment_methods || [];
  const toHarvest = Math.max(0, daysBetween(env.today, batch.harvest_date));

  let lines;
  let demandReason;
  if (coverable > 0) {
    lines = matches.map((m) => ({
      quantity: m.recommendedQuantity,
      unitPrice: m.unitPrice,
      orders: 1,
      method: resolveMethod(m.demand.preferred_collection_method, offered),
      reliability: m.breakdown.reliability.score,
      hasHistory: Boolean(ctx.reliability?.get(m.demand.buyer_id)),
      leadDays: Math.max(0, daysBetween(env.today, m.effectiveRequiredDate)),
    }));
    const buyers = new Set(matches.map((m) => m.demand.buyer_id)).size;
    demandReason = `${matches.length} eligible request(s) from ${buyers} buyer(s) can cover ${coverable} of ${remaining}${unit}`;
  } else {
    lines = [{
      quantity: remaining,
      unitPrice: round2(Number(batch.preferred_price) * profile.priceIndex),
      orders: Math.max(1, Math.ceil(remaining / profile.typicalKg)),
      method: resolveMethod(profile.method, offered),
      reliability: getPolicy().neutralReliabilityScore,
      leadDays: toHarvest + profile.leadDays,
    }];
    demandReason = subset.length
      ? `${subset.length} request(s) in this route, but none fit this batch (see exclusions)`
      : 'No open demand in this route yet — outreach could create it';
  }
  const demandFit = Math.round(Math.min(1, remaining > 0 ? coverable / remaining : 0) * 100);
  const scored = scoreRoute(key, batch, lines, { demandFit, demandReason, live: coverable > 0, sellDays: env.sellDays, today: env.today });

  return {
    ...scored,
    coverableQuantity: coverable,
    demandQuantity,
    requests: subset.length,
    buyers: [...new Set(matches.map((m) => m.demand.organisation_name))],
    excluded: ranked.excluded.map((e) => ({ buyerName: e.buyerName, quantity: e.quantity, reason: e.reason })),
  };
}

function rescueRouteAssessment(batch, env) {
  const remaining = env.remaining;
  const price = suggestRescuePrice(batch).suggestedPrice;
  const scored = scoreRoute('RESCUE', batch, [{
    quantity: remaining,
    unitPrice: price,
    orders: Math.max(1, Math.ceil(remaining / MARKET_ROUTES.RESCUE.typicalKg)),
    method: 'FARM_PICKUP',
    reliability: getPolicy().neutralReliabilityScore,
    leadDays: Math.max(0, daysBetween(env.today, batch.harvest_date)) + MARKET_ROUTES.RESCUE.leadDays,
  }], {
    demandFit: RESCUE_DEMAND_FIT,
    demandReason: 'Alternative route for farm-approved surplus, imperfect or short-dated produce — sell-through depends on Rescue reach',
    live: false,
    sellDays: env.sellDays,
    today: env.today,
  });
  if (scored.margin.known && scored.margin.status === 'LOSS') {
    // Sunk cost: recovering part of it still beats waste. Flagged, not blocked.
    scored.warnings = scored.warnings.map((w) => (w === scored.margin.message ? `${w} — still recovers more than wasting the produce` : w));
  }
  return { ...scored, coverableQuantity: remaining, demandQuantity: null, requests: 0, buyers: [], excluded: [] };
}

const ACTIONS = { VIABLE: 'RUN_HARVESTMATCH', NO_DEMAND: 'OUTREACH', NOT_VIABLE: 'REVIEW_PRICE', EXCLUDED: null, PAST_WINDOW: 'RECORD_DISPOSITION' };

/**
 * Compares every route for a batch. Pure: `candidates` and `ctx` (exclusions, reliability) are pre-loaded.
 * Returns routes sorted by score, a recommended route, and a route plan for the remaining quantity.
 */
export function assessRoutes(batch, candidates, ctx = {}) {
  const today = ctx.today || todayISO();
  const remaining = Math.max(0, round2(Number(batch.remaining_quantity)));
  const routing = routingFor(batch, today);
  const env = { today, remaining, sellDays: sellWindowDays(batch, today) };
  const base = {
    remainingQuantity: remaining,
    unit: batch.unit || 'kg',
    sellWindowDays: env.sellDays,
    routingStage: routing.stage,
    primaryRoute: batch.primary_route || null,
    allowedRoutes: batch.allowed_routes || null,
    weights: getPolicy().routeWeights,
  };
  if (remaining <= 0 || batch.status === 'CLOSED') {
    return { ...base, routes: [], recommendedRoute: null, plan: [], unplannedQuantity: 0, recommendation: 'Nothing left to route — all produce is allocated or listed.' };
  }

  const pastWindow = routing.stage === 'DONATION';
  const allowed = batch.allowed_routes?.length ? batch.allowed_routes : null;
  const routes = [...DEMAND_ROUTE_KEYS.map((k) => demandRouteAssessment(k, batch, candidates, ctx, env)), rescueRouteAssessment(batch, env)];
  for (const r of routes) {
    if (allowed && !allowed.includes(r.key)) r.status = 'EXCLUDED';
    else if (pastWindow) r.status = 'PAST_WINDOW';
    else if (r.key !== 'RESCUE' && r.coverableQuantity <= 0) r.status = 'NO_DEMAND';
    else if (r.key !== 'RESCUE' && r.margin.known && r.margin.status === 'LOSS') r.status = 'NOT_VIABLE';
    else r.status = 'VIABLE';
    r.action = r.key === 'RESCUE' && r.status === 'VIABLE' ? 'MOVE_TO_RESCUE' : ACTIONS[r.status];
  }
  // Viable routes first (routes without demand are scored on a hypothetical profile), then by score.
  routes.sort((a, b) => (a.status === 'VIABLE' ? 0 : 1) - (b.status === 'VIABLE' ? 0 : 1) || b.score - a.score || b.coverableQuantity - a.coverableQuantity);

  const demandViable = routes.filter((r) => r.key !== 'RESCUE' && r.status === 'VIABLE');
  const rescue = routes.find((r) => r.key === 'RESCUE');
  const recommended = demandViable[0] || (rescue.status === 'VIABLE' ? rescue : null);
  if (recommended) routes.unshift(...routes.splice(routes.indexOf(recommended), 1)); // recommended route leads the list

  // Route plan: fill the remaining quantity route by route in score order; Rescue (or a final disposition) takes the rest.
  let left = remaining;
  const plan = [];
  for (const r of demandViable) {
    const q = round2(Math.min(r.coverableQuantity, left));
    if (q > 0) {
      plan.push({ route: r.key, label: r.label, quantity: q });
      left = round2(left - q);
    }
  }
  if (left > 0 && rescue.status === 'VIABLE') {
    plan.push({ route: 'RESCUE', label: rescue.label, quantity: left });
    left = 0;
  } else if (left > 0 && pastWindow) {
    plan.push({ route: 'FINAL_DISPOSITION', label: 'Donation / alternative use', quantity: left });
    left = 0;
  }

  let recommendation;
  if (pastWindow) recommendation = 'Past its commercial window — record a donation or alternative use (final disposition).';
  else if (!recommended) recommendation = 'No route is currently viable. Review prices or commercial constraints, or start outreach.';
  else if (recommended.key === 'RESCUE') recommendation = 'No viable buyer route has demand for this batch. Consider Rescue, or outreach to create demand.';
  else recommendation = `${recommended.label} is the strongest commercial route (score ${recommended.score}) for ${recommended.coverableQuantity}${base.unit} of ${remaining}${base.unit}.`;

  return { ...base, routes, recommendedRoute: recommended?.key || null, recommendation, plan, unplannedQuantity: left };
}

// ---------------------------------------------------------------- loaders

const runner = { query };

async function latestSelections(batchId, limit = 5) {
  const { rows } = await query(
    `SELECT rs.id, rs.route, rs.recommended_route, rs.route_score, rs.stage, rs.remaining_quantity, rs.created_at,
            u.full_name AS created_by_name
       FROM route_selections rs LEFT JOIN users u ON u.id = rs.created_by
      WHERE rs.harvest_batch_id = $1 ORDER BY rs.created_at DESC, rs.id DESC LIMIT $2`,
    [batchId, limit]
  );
  return camelizeAll(rows);
}

export async function assessBatch(row, client = runner) {
  const ctx = await loadMatchingContext(client, row);
  return assessRoutes(row, ctx.candidates, ctx);
}

/** MarketRoute comparison for one batch (farm users). */
export async function getRouteAssessment(user, batchId) {
  const row = await findBatchById(batchId);
  if (!row) throw notFound('Harvest batch not found');
  assertFarmAccess(user, row.farm_id);
  const assessment = await assessBatch(row);
  return { batch: toBatchDTO(row), ...assessment, selections: await latestSelections(batchId) };
}

/**
 * Route recommendation for every open batch of a farm (Demand Radar). Loads open demand, reliability
 * and exclusions once for the farm instead of per batch.
 */
export async function assessFarmBatches(farmId, rows) {
  const open = rows.filter((r) => r.status !== 'CLOSED' && Number(r.remaining_quantity) > 0);
  if (!open.length) return new Map();
  const candidates = await loadOpenDemandForFarm(farmId);
  const reliability = await getReliabilityStats([...new Set(candidates.map((c) => c.buyer_id))]);
  const [rejected, cancelled] = await Promise.all([
    query(`SELECT DISTINCT harvest_batch_id, demand_request_id FROM harvest_matches WHERE farm_id = $1 AND status = 'REJECTED'`, [farmId]),
    query(
      `SELECT DISTINCT oi.harvest_batch_id, o.buyer_id FROM orders o JOIN order_items oi ON oi.order_id = o.id
        WHERE o.farm_id = $1 AND o.status = 'CANCELLED'`,
      [farmId]
    ),
  ]);
  const result = new Map();
  for (const row of open) {
    const exclusions = new Map();
    for (const r of rejected.rows) if (r.harvest_batch_id === row.id) exclusions.set(r.demand_request_id, 'Previously rejected by farm for this batch');
    const cancelledBuyers = new Set(cancelled.rows.filter((r) => r.harvest_batch_id === row.id).map((r) => r.buyer_id));
    for (const c of candidates) {
      if (!exclusions.has(c.id) && cancelledBuyers.has(c.buyer_id)) exclusions.set(c.id, 'Buyer cancelled an order for this batch');
    }
    result.set(row.id, assessRoutes(row, candidates, { exclusions, reliability }));
  }
  return result;
}

/** Compact form for dashboards and stored run summaries. */
export const compactAssessment = (a) => ({
  recommendedRoute: a.recommendedRoute,
  recommendation: a.recommendation,
  plan: a.plan,
  routes: a.routes.map((r) => ({ key: r.key, label: r.label, score: r.score, status: r.status, coverableQuantity: r.coverableQuantity })),
});

const selectSchema = z.object({ route: z.enum(ROUTE_KEYS) });

/**
 * Farm admin selects the route for a batch. The decision is recorded with the comparison the farm saw.
 * For buyer routes, HarvestMatch then runs within that route; for Rescue, the farm creates a listing next.
 * The first route chosen is the primary route; another route chosen after the primary has made sales
 * is recorded as an alternative route (proposal §8.5).
 */
export async function selectRoute(user, batchId, input, ip) {
  const d = validate(selectSchema, input);
  const row = await findBatchById(batchId);
  if (!row) throw notFound('Harvest batch not found');
  assertFarmAdmin(user, row.farm_id);
  if (row.status === 'CLOSED') throw conflict('This harvest batch is closed', 'BATCH_CLOSED');

  const assessment = await assessBatch(row);
  const chosen = assessment.routes.find((r) => r.key === d.route);
  if (!chosen) throw conflict('Nothing left to route — the batch is fully allocated', 'NOTHING_TO_ROUTE');
  if (chosen.status === 'EXCLUDED') throw conflict(`${chosen.label} is excluded by this batch's commercial constraints`, 'ROUTE_EXCLUDED');
  if (chosen.status === 'PAST_WINDOW') throw conflict('This batch is past its commercial window — record a final disposition instead', 'PAST_SALES_WINDOW');

  let stage = 'PRIMARY';
  if (d.route === 'RESCUE') stage = 'RESCUE';
  else if (row.primary_route && row.primary_route !== d.route) {
    const sold = await query(
      `SELECT 1 FROM harvest_matches WHERE harvest_batch_id = $1 AND market_route = $2 AND status = 'APPROVED' LIMIT 1`,
      [batchId, row.primary_route]
    );
    if (sold.rowCount) stage = 'ALTERNATIVE';
  }

  const selection = await withTransaction(async (client) => {
    if (stage === 'PRIMARY') {
      await client.query('UPDATE harvest_batches SET primary_route = $1, updated_at = NOW() WHERE id = $2', [d.route, batchId]);
    }
    const { rows } = await client.query(
      `INSERT INTO route_selections (farm_id, harvest_batch_id, route, recommended_route, route_score, stage, remaining_quantity, assessment, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [row.farm_id, batchId, d.route, assessment.recommendedRoute, chosen.score, stage, assessment.remainingQuantity,
        JSON.stringify(compactAssessment(assessment)), user.id]
    );
    await logAudit(
      {
        farmId: row.farm_id, userId: user.id, action: 'ROUTE_SELECTED', entityType: 'harvest_batch', entityId: batchId,
        details: { route: d.route, stage, score: chosen.score, recommended: assessment.recommendedRoute }, ip,
      },
      client
    );
    return camelize(rows[0]);
  });

  const matching = d.route === 'RESCUE' ? null : await runMatching(user, batchId, { route: d.route, ip });
  return { selection, stage, route: chosen, matching };
}
