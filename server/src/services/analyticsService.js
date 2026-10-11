/**
 * Tyllage Insights (proposal v3 §8.8) — analytics derived only from database records. When a denominator is zero (no data), the metric is
 * returned with value null and `sufficient: false` so the UI shows "Not enough data yet" instead of
 * inventing a number.
 */
import { query } from '../config/db.js';
import { percent, round2 } from '../utils/numbers.js';
import { todayISO } from '../utils/dates.js';
import { z } from 'zod';
import { orderRoute, emptyRouteTotals, ROUTE_LABELS } from '../config/rules.js';
import { getPolicy } from './policyService.js';
import { listBatches, toBatchDTO } from '../models/harvestModel.js';
import { validate } from '../utils/validate.js';
import { camelizeAll } from '../utils/case.js';
import { logAudit } from './auditService.js';

/** Raw events for the proposal KPIs: disruptions, replacement allocations, dispositions, sale lines with cost. */
async function loadExtendedKpiData(farmId) {
  const [disruptions, allocations, dispositions, lines] = await Promise.all([
    query(
      `SELECT a.harvest_batch_id, o.cancelled_at AS at, SUM(a.quantity) AS quantity
         FROM orders o JOIN order_items oi ON oi.order_id = o.id JOIN allocations a ON a.order_item_id = oi.id
        WHERE o.farm_id = $1 AND o.status = 'CANCELLED' AND o.cancelled_at IS NOT NULL
        GROUP BY a.harvest_batch_id, o.id, o.cancelled_at`,
      [farmId]
    ),
    query(`SELECT harvest_batch_id, created_at AS at, quantity FROM allocations WHERE farm_id = $1 AND status = 'ACTIVE'`, [farmId]),
    query(
      `SELECT COALESCE(SUM(quantity) FILTER (WHERE disposition_type IN ('DONATION', 'ALTERNATIVE_USE')), 0) AS redirected,
              COALESCE(SUM(quantity) FILTER (WHERE disposition_type = 'WASTE'), 0) AS wasted
         FROM batch_dispositions WHERE farm_id = $1`,
      [farmId]
    ),
    // Each line carries its share of the order's estimated fulfilment cost (split by quantity).
    query(
      `SELECT oi.quantity, oi.unit_price, hb.production_cost AS cost,
              COALESCE(o.fulfilment_cost, 0) * oi.quantity / NULLIF(SUM(oi.quantity) OVER (PARTITION BY o.id), 0) AS fulfilment
         FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN harvest_batches hb ON hb.id = oi.harvest_batch_id
        WHERE o.farm_id = $1 AND o.status = ANY($2::text[])`,
      [farmId, SOLD_STATUSES]
    ),
  ]);
  return {
    disruptions: disruptions.rows.map((r) => ({ batchId: r.harvest_batch_id, at: new Date(r.at), quantity: Number(r.quantity) })),
    allocations: allocations.rows.map((r) => ({ batchId: r.harvest_batch_id, at: new Date(r.at), quantity: Number(r.quantity) })),
    redirectedKg: Number(dispositions.rows[0].redirected),
    wastedKg: Number(dispositions.rows[0].wasted),
    marginLines: lines.rows.map((r) => ({ quantity: r.quantity, unitPrice: r.unit_price, cost: r.cost, fulfilment: Number(r.fulfilment || 0) })),
  };
}

// ---------------------------------------------------------------- pilot success framework

/**
 * Pilot success framework (proposal v3 §12). The seven headline KPIs come first, with the proposal's
 * definitions; supporting measures follow. `baselineApplicable: false` = "N/A before Tyllage".
 */
export const BASELINE_METRICS = [
  { key: 'demandCoverage', label: 'Demand Coverage', definition: 'Confirmed demand ÷ expected harvest', unit: '%', headline: true },
  { key: 'sellThrough', label: 'Harvest Sell-Through', definition: 'Produce sold ÷ total harvest', unit: '%', headline: true },
  { key: 'demandRecoveryTime', label: 'Demand Recovery Time', definition: 'Time to replace displaced demand', unit: 'hours', lowerIsBetter: true, headline: true },
  { key: 'averageMarginPerKg', label: 'Average Margin / kg', definition: 'Commercial margin retained per kg sold, after fulfilment', unit: '$/kg', headline: true },
  { key: 'channelConcentration', label: 'Channel Concentration', definition: 'Revenue share from largest buyer', unit: '%', lowerIsBetter: true, headline: true },
  { key: 'matchConversion', label: 'Match Conversion', definition: 'Approved recommendations converting to transactions', unit: '%', baselineApplicable: false, headline: true },
  { key: 'notCommercialised', label: 'Waste / At-Risk Quantity', definition: 'Quantity not successfully commercialised', unit: 'kg', lowerIsBetter: true, headline: true },
  { key: 'repeatBuyerRate', label: 'Repeat Buyer Rate', definition: 'Buyers with 2+ orders ÷ buyers', unit: '%' },
  { key: 'rescueRate', label: 'Rescue Rate', definition: 'Recovered at-risk produce ÷ at-risk produce', unit: '%' },
  { key: 'wasteAvoided', label: 'Waste Avoided', definition: 'At-risk kg sold, donated or put to alternative use', unit: 'kg' },
];

const baselineSchema = z.object({
  metricKey: z.enum(BASELINE_METRICS.map((m) => m.key)),
  baselineValue: z.coerce.number().min(-1000000).max(1000000).nullable(),
  periodLabel: z.string().trim().max(80).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
}).superRefine((d, ctx) => {
  if (d.baselineValue === null) return;
  const metric = BASELINE_METRICS.find((m) => m.key === d.metricKey);
  if (metric.unit !== '$/kg' && d.baselineValue < 0) {
    ctx.addIssue({ code: 'custom', path: ['baselineValue'], message: 'Only margin baselines may be negative' });
  }
  if (metric.unit === '%' && d.baselineValue > 100) {
    ctx.addIssue({ code: 'custom', path: ['baselineValue'], message: 'Percentage baselines must be between 0 and 100' });
  }
});

export async function saveBaseline(user, farmId, input, ip) {
  const d = validate(baselineSchema, input);
  if (BASELINE_METRICS.find((m) => m.key === d.metricKey).baselineApplicable === false) {
    return null; // e.g. match conversion did not exist before Tyllage
  }
  await query(
    `INSERT INTO pilot_baselines (farm_id, metric_key, baseline_value, period_label, notes, recorded_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (farm_id, metric_key) DO UPDATE SET baseline_value = EXCLUDED.baseline_value, period_label = EXCLUDED.period_label,
       notes = EXCLUDED.notes, recorded_by = EXCLUDED.recorded_by, updated_at = NOW()`,
    [farmId, d.metricKey, d.baselineValue, d.periodLabel ?? null, d.notes ?? null, user.id]
  );
  await logAudit({ farmId, userId: user.id, action: 'BASELINE_RECORDED', entityType: 'pilot_baseline', details: d, ip });
  return true;
}

/** Baseline vs pilot result vs change, using the same live measures as the analytics page. */
export function buildComparison(baselineRows, liveValues) {
  const byKey = new Map(baselineRows.map((b) => [b.metric_key, b]));
  return BASELINE_METRICS.map((m) => {
    const b = byKey.get(m.key);
    const baseline = m.baselineApplicable === false ? null : b?.baseline_value ?? null;
    const pilot = liveValues[m.key] ?? null;
    const change = baseline !== null && pilot !== null ? round2(pilot - baseline) : null;
    let direction = null;
    if (change !== null && change !== 0) direction = (change > 0) !== Boolean(m.lowerIsBetter) ? 'IMPROVED' : 'WORSENED';
    return {
      ...m,
      baseline,
      baselineStatus: m.baselineApplicable === false ? 'N/A before Tyllage' : baseline === null ? 'To establish' : 'Recorded',
      periodLabel: b?.period_label || null,
      notes: b?.notes || null,
      pilot,
      change,
      direction,
    };
  });
}

export async function getComparison(farmId) {
  const [analytics, { rows }] = await Promise.all([
    getFarmAnalytics(farmId),
    query('SELECT * FROM pilot_baselines WHERE farm_id = $1', [farmId]),
  ]);
  const m = analytics.metrics;
  const live = {
    demandCoverage: m.demandCoverage.value,
    sellThrough: m.sellThrough.value,
    notCommercialised: m.notCommercialised.value,
    demandRecoveryTime: m.demandRecoveryTime.value,
    repeatBuyerRate: m.repeatBuyerRate.value,
    matchConversion: m.matchConversion.value,
    rescueRate: m.rescueRate.value,
    wasteAvoided: m.wasteAvoided.value,
    averageMarginPerKg: m.averageMarginPerKg.value,
    channelConcentration: m.channelConcentration.value,
  };
  return { rows: buildComparison(rows, live), baselines: camelizeAll(rows) };
}

const SOLD_STATUSES = ['CONFIRMED', 'READY', 'COMPLETED'];

// ---------------------------------------------------------------- pure formulas

export function metric(numerator, denominator, formula) {
  const value = percent(numerator, denominator, 1);
  return {
    value,
    numerator: round2(numerator || 0),
    denominator: round2(denominator || 0),
    sufficient: value !== null,
    formula,
  };
}

/** Sold Quantity / Actual Harvest × 100 */
export const sellThroughRate = (sold, harvested) => metric(sold, harvested, 'Sold Quantity ÷ Actual Harvest × 100');

/** Confirmed Demand / Expected Harvest × 100 */
export const demandCoverageRate = (confirmed, expected) => metric(confirmed, expected, 'Confirmed Demand ÷ Expected Harvest × 100');

/** Recovered At-Risk Produce / Total At-Risk Produce × 100 */
export const rescueRate = (recovered, atRisk) =>
  metric(Math.min(recovered, atRisk), atRisk, 'Recovered At-Risk Produce ÷ Total At-Risk Produce × 100');

/** Revenue From Largest Buyer / Total Revenue × 100 */
export function channelConcentration(revenueByBuyer) {
  const values = revenueByBuyer.map(Number).filter((v) => v > 0);
  const total = values.reduce((s, v) => s + v, 0);
  const largest = values.length ? Math.max(...values) : 0;
  return metric(largest, total, 'Revenue From Largest Buyer ÷ Total Revenue × 100');
}

/** Returning Buyers / Total Buyers × 100 (returning = 2+ non-cancelled orders) */
export function repeatBuyerRate(orderCountsByBuyer) {
  const buyers = orderCountsByBuyer.filter((c) => c >= 1);
  const returning = buyers.filter((c) => c >= 2);
  return metric(returning.length, buyers.length, 'Returning Buyers ÷ Total Buyers × 100');
}

/** Approved Matches / Generated Matches × 100 */
export const matchConversionRate = (approved, generated) => metric(approved, generated, 'Approved Matches ÷ Generated Matches × 100');

/**
 * Demand Recovery Time: for each disruption (an order cancelled on a batch), hours until new allocations
 * on that batch replaced the released quantity. Pure function over event lists.
 *   disruptions: [{ batchId, at: Date, quantity }]
 *   allocations: [{ batchId, at: Date, quantity }]
 */
export function demandRecoveryTime(disruptions, allocations) {
  const hours = [];
  for (const d of disruptions) {
    let covered = 0;
    const replacements = allocations.filter((a) => a.batchId === d.batchId && a.at > d.at).sort((a, b) => a.at - b.at);
    for (const a of replacements) {
      covered += a.quantity;
      if (covered >= d.quantity - 1e-9) {
        hours.push((a.at - d.at) / 3600000);
        break;
      }
    }
  }
  const avg = hours.length ? Math.round((hours.reduce((s, h) => s + h, 0) / hours.length) * 10) / 10 : null;
  return {
    value: avg,
    unit: 'hours',
    recovered: hours.length,
    disruptions: disruptions.length,
    sufficient: avg !== null,
    formula: 'Average time from a cancellation until new allocations replace the released quantity',
  };
}

/** Waste Avoided: kg that were at risk and were then sold, reserved, donated or put to alternative use. */
export function wasteAvoided(recoveredKg, redirectedKg, wastedKg) {
  const value = round2(recoveredKg + redirectedKg);
  const sufficient = value > 0 || wastedKg > 0;
  return {
    value: sufficient ? value : null,
    unit: 'kg',
    recovered: round2(recoveredKg),
    redirected: round2(redirectedKg),
    recordedWaste: round2(wastedKg),
    sufficient,
    formula: 'At-risk kg recovered through sales/Rescue + kg donated or put to alternative use',
  };
}

/**
 * Average Margin per Kilogram = Σ ((unit price − production cost) × qty − fulfilment cost) ÷ Σ qty,
 * over sales with a recorded production cost. Lines without a fulfilment estimate count it as 0.
 */
export function averageMarginPerKg(lines) {
  const known = lines.filter((l) => l.cost !== null && l.cost !== undefined);
  const qty = known.reduce((s, l) => s + Number(l.quantity), 0);
  const fulfilment = known.reduce((s, l) => s + Number(l.fulfilment || 0), 0);
  const margin = known.reduce((s, l) => s + (Number(l.unitPrice) - Number(l.cost)) * Number(l.quantity), 0) - fulfilment;
  return {
    value: qty > 0 ? round2(margin / qty) : null,
    unit: '$/kg',
    numerator: round2(margin),
    denominator: round2(qty),
    fulfilment: round2(fulfilment),
    coverage: lines.length ? Math.round((known.length / lines.length) * 100) : 0,
    sufficient: qty > 0,
    formula: 'Σ ((unit price − production cost) × quantity − fulfilment cost) ÷ Σ quantity sold (sales with a recorded cost)',
  };
}

/** Quantity not successfully commercialised, over batches whose commercial window has closed. */
export function notCommercialised(batches) {
  const value = round2(batches.reduce((s, b) => s + Math.max(0, Number(b.harvest) - Number(b.sold)), 0));
  return {
    value: batches.length ? value : null,
    unit: 'kg',
    batches: batches.length,
    harvested: round2(batches.reduce((s, b) => s + Number(b.harvest), 0)),
    sufficient: batches.length > 0,
    formula: 'Harvest − quantity sold (incl. Rescue), for closed batches or batches past their shelf-life window',
  };
}

/**
 * Insights by MarketRoute: which routes preserve margin after fulfilment, how often orders cancel, and how
 * much surplus each route recovered. `lines` are order lines; `firstRecoveryAt` maps batch id → first
 * Demand Recovery run time (lines created after it count as recovered).
 */
export function routePerformance(lines, firstRecoveryAt = new Map()) {
  const out = Object.fromEntries(Object.keys(emptyRouteTotals()).map((k) => [k, {
    route: k, label: ROUTE_LABELS[k], orders: new Set(), cancelledOrders: new Set(), revenue: 0, quantity: 0,
    costedQty: 0, netMargin: 0, fulfilment: 0, recoveredQuantity: 0,
  }]));
  for (const l of lines) {
    const r = out[orderRoute(l.source, l.buyerType)];
    if (l.status === 'CANCELLED') {
      r.cancelledOrders.add(l.orderId);
      continue;
    }
    r.orders.add(l.orderId);
    if (!SOLD_STATUSES.includes(l.status)) continue;
    const qty = Number(l.quantity);
    r.quantity += qty;
    r.revenue += qty * Number(l.unitPrice);
    r.fulfilment += Number(l.fulfilment || 0);
    if (l.cost !== null && l.cost !== undefined) {
      r.costedQty += qty;
      r.netMargin += (Number(l.unitPrice) - Number(l.cost)) * qty - Number(l.fulfilment || 0);
    }
    const recoveryAt = firstRecoveryAt.get(l.batchId);
    if (recoveryAt && new Date(l.createdAt) >= recoveryAt) r.recoveredQuantity += qty;
  }
  return Object.values(out).map((r) => {
    const all = r.orders.size + r.cancelledOrders.size;
    return {
      route: r.route,
      label: r.label,
      orders: r.orders.size,
      revenue: round2(r.revenue),
      quantity: round2(r.quantity),
      averagePricePerKg: r.quantity > 0 ? round2(r.revenue / r.quantity) : null,
      fulfilmentPerKg: r.quantity > 0 ? round2(r.fulfilment / r.quantity) : null,
      netMarginPerKg: r.costedQty > 0 ? round2(r.netMargin / r.costedQty) : null,
      cancellationRate: all > 0 ? percent(r.cancelledOrders.size, all, 1) : null,
      recoveredQuantity: round2(r.recoveredQuantity),
    };
  });
}

// ---------------------------------------------------------------- aggregation

/** Insight inputs: order lines by route, recovery start per batch, coverage by crop, closed-window batches. */
async function loadInsights(farmId, today) {
  const [lines, recoveries, coverage, windows] = await Promise.all([
    query(
      `SELECT o.id AS order_id, o.source, o.status, o.created_at, bp.buyer_type, oi.harvest_batch_id AS batch_id,
              oi.quantity, oi.unit_price, hb.production_cost AS cost,
              COALESCE(o.fulfilment_cost, 0) * oi.quantity / NULLIF(SUM(oi.quantity) OVER (PARTITION BY o.id), 0) AS fulfilment
         FROM orders o JOIN buyer_profiles bp ON bp.id = o.buyer_id JOIN order_items oi ON oi.order_id = o.id
         LEFT JOIN harvest_batches hb ON hb.id = oi.harvest_batch_id
        WHERE o.farm_id = $1`,
      [farmId]
    ),
    query(
      `SELECT harvest_batch_id, MIN(created_at) AS at FROM match_runs WHERE farm_id = $1 AND run_type = 'RECOVERY' GROUP BY harvest_batch_id`,
      [farmId]
    ),
    // Which crops achieve stronger demand coverage (batches harvesting within the last 60 days, or later).
    query(
      `SELECT p.name, p.unit, COUNT(*) AS batches, SUM(bs.harvest_quantity) AS harvest, SUM(bs.allocated_quantity) AS confirmed
         FROM harvest_batches hb JOIN produce p ON p.id = hb.produce_id JOIN batch_stock bs ON bs.harvest_batch_id = hb.id
        WHERE hb.farm_id = $1 AND hb.harvest_date >= ($2::date - 60)
        GROUP BY p.id ORDER BY p.name`,
      [farmId, today]
    ),
    // Batches whose commercial window has closed: closed, or past harvest date + shelf life.
    query(
      `SELECT bs.harvest_quantity AS harvest,
              (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi JOIN orders o ON o.id = oi.order_id
                WHERE oi.harvest_batch_id = hb.id AND o.status = ANY($3::text[])) AS sold
         FROM harvest_batches hb JOIN produce p ON p.id = hb.produce_id JOIN batch_stock bs ON bs.harvest_batch_id = hb.id
        WHERE hb.farm_id = $1 AND hb.harvest_date <= $2
          AND (hb.status = 'CLOSED' OR hb.harvest_date + COALESCE(p.shelf_life_days, $4) < $2::date)`,
      [farmId, today, SOLD_STATUSES, getPolicy().defaultShelfLifeDays]
    ),
  ]);
  const firstRecoveryAt = new Map(recoveries.rows.map((r) => [r.harvest_batch_id, new Date(r.at)]));
  const routeLines = lines.rows.map((r) => ({
    orderId: r.order_id, source: r.source, status: r.status, createdAt: r.created_at, buyerType: r.buyer_type, batchId: r.batch_id,
    quantity: r.quantity, unitPrice: r.unit_price, cost: r.cost, fulfilment: Number(r.fulfilment || 0),
  }));
  return {
    routes: routePerformance(routeLines, firstRecoveryAt),
    coverageByProduce: coverage.rows.map((r) => ({
      name: r.name, unit: r.unit, batches: Number(r.batches), harvest: round2(r.harvest), confirmed: round2(r.confirmed),
      coverage: percent(r.confirmed, r.harvest, 1),
    })),
    closedWindowBatches: windows.rows,
  };
}


export async function getFarmAnalytics(farmId) {
  const today = todayISO();

  const [sales, harvested, buyers, matches, atRisk, rescue, topProduce, weekly, openBatches] = await Promise.all([
    query(
      `SELECT COALESCE(SUM(oi.line_total), 0) AS revenue, COALESCE(SUM(oi.quantity), 0) AS quantity,
              COUNT(DISTINCT o.id) AS orders
         FROM orders o JOIN order_items oi ON oi.order_id = o.id
        WHERE o.farm_id = $1 AND o.status = ANY($2::text[])`,
      [farmId, SOLD_STATUSES]
    ),
    // Sell-through only considers batches that have been harvested (harvest date today or earlier).
    query(
      `SELECT COALESCE(SUM(COALESCE(hb.actual_quantity, hb.expected_quantity)), 0) AS harvested,
              COALESCE(SUM((SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi JOIN orders o ON o.id = oi.order_id
                              WHERE oi.harvest_batch_id = hb.id AND o.status = ANY($3::text[]))), 0) AS sold
         FROM harvest_batches hb WHERE hb.farm_id = $1 AND hb.harvest_date <= $2`,
      [farmId, today, SOLD_STATUSES]
    ),
    query(
      `SELECT bp.id, bp.organisation_name, bp.buyer_type, MAX(o.created_at) AS last_order_at,
              COUNT(DISTINCT o.id) AS orders, COALESCE(SUM(o.total_amount) FILTER (WHERE o.status = ANY($2::text[])), 0) AS revenue
         FROM orders o JOIN buyer_profiles bp ON bp.id = o.buyer_id
        WHERE o.farm_id = $1 AND o.status <> 'CANCELLED'
        GROUP BY bp.id`,
      [farmId, SOLD_STATUSES]
    ),
    query(
      `SELECT COUNT(*) FILTER (WHERE status = 'APPROVED') AS approved,
              COUNT(*) FILTER (WHERE status IN ('APPROVED', 'REJECTED', 'SUGGESTED')) AS generated,
              COUNT(*) FILTER (WHERE status = 'REJECTED') AS rejected
         FROM harvest_matches WHERE farm_id = $1`,
      [farmId]
    ),
    // At-risk produce = quantity unallocated when Demand Recovery first started for a batch.
    // Recovered = quantity allocated (incl. Rescue sales) on that batch after that point.
    query(
      `WITH first_run AS (
         SELECT DISTINCT ON (harvest_batch_id) harvest_batch_id, remaining_quantity, created_at
           FROM match_runs WHERE farm_id = $1 AND run_type = 'RECOVERY'
          ORDER BY harvest_batch_id, created_at ASC
       )
       SELECT COALESCE(SUM(fr.remaining_quantity), 0) AS at_risk,
              COALESCE(SUM(LEAST(fr.remaining_quantity,
                (SELECT COALESCE(SUM(a.quantity), 0) FROM allocations a
                  WHERE a.harvest_batch_id = fr.harvest_batch_id AND a.status = 'ACTIVE' AND a.created_at >= fr.created_at))), 0) AS recovered
         FROM first_run fr`,
      [farmId]
    ),
    query(
      `SELECT COALESCE(SUM(CASE WHEN rl.status = 'CANCELLED' THEN rs.sold_quantity ELSE rl.quantity END), 0) AS listed,
              COALESCE(SUM(rs.sold_quantity), 0) AS sold,
              COALESCE(SUM(rs.available_quantity) FILTER (WHERE rl.status = 'ACTIVE'), 0) AS active_available
         FROM rescue_listings rl JOIN rescue_stock rs ON rs.rescue_listing_id = rl.id WHERE rl.farm_id = $1`,
      [farmId]
    ),
    query(
      `SELECT p.name, p.unit, SUM(oi.quantity) AS quantity, SUM(oi.line_total) AS revenue
         FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN produce p ON p.id = oi.produce_id
        WHERE o.farm_id = $1 AND o.status = ANY($2::text[])
        GROUP BY p.id ORDER BY revenue DESC LIMIT 5`,
      [farmId, SOLD_STATUSES]
    ),
    query(
      `SELECT to_char(date_trunc('week', o.created_at), 'YYYY-MM-DD') AS week, SUM(o.total_amount) AS revenue, COUNT(*) AS orders
         FROM orders o WHERE o.farm_id = $1 AND o.status = ANY($2::text[]) AND o.created_at > NOW() - INTERVAL '8 weeks'
        GROUP BY 1 ORDER BY 1`,
      [farmId, SOLD_STATUSES]
    ),
    listBatches(farmId),
  ]);
  const extra = await loadExtendedKpiData(farmId);
  const insights = await loadInsights(farmId, today);

  const batches = openBatches.map(toBatchDTO);
  const expected = batches.reduce((s, b) => s + b.harvestQuantity, 0);
  const confirmed = batches.reduce((s, b) => s + b.confirmedDemand, 0);
  const atRiskNow = batches.reduce((s, b) => s + b.atRiskQuantity, 0);

  const s = sales.rows[0];
  const h = harvested.rows[0];
  const m = matches.rows[0];
  const r = rescue.rows[0];
  const ar = atRisk.rows[0];

  const largestBuyer = [...buyers.rows].sort((a, b) => b.revenue - a.revenue)[0];

  return {
    totals: {
      revenue: round2(s.revenue),
      orders: s.orders,
      soldQuantity: round2(s.quantity),
      atRiskQuantity: round2(atRiskNow),
      rescueListedQuantity: round2(r.listed),
      rescueSoldQuantity: round2(r.sold),
      rescueActiveQuantity: round2(r.active_available),
      matchesGenerated: m.generated,
      matchesApproved: m.approved,
      matchesRejected: m.rejected,
    },
    metrics: {
      sellThrough: sellThroughRate(Number(h.sold), Number(h.harvested)),
      demandCoverage: demandCoverageRate(confirmed, expected),
      rescueRate: rescueRate(Number(ar.recovered), Number(ar.at_risk)),
      channelConcentration: {
        ...channelConcentration(buyers.rows.map((b) => b.revenue)),
        largestBuyer: largestBuyer && Number(largestBuyer.revenue) > 0 ? largestBuyer.organisation_name : null,
      },
      repeatBuyerRate: repeatBuyerRate(buyers.rows.map((b) => b.orders)),
      matchConversion: matchConversionRate(m.approved, m.generated),
      demandRecoveryTime: demandRecoveryTime(extra.disruptions, extra.allocations),
      wasteAvoided: wasteAvoided(Number(ar.recovered), extra.redirectedKg, extra.wastedKg),
      averageMarginPerKg: averageMarginPerKg(extra.marginLines),
      notCommercialised: notCommercialised(insights.closedWindowBatches),
    },
    routeLabels: ROUTE_LABELS,
    topProduce: topProduce.rows.map((p) => ({ name: p.name, unit: p.unit, quantity: round2(p.quantity), revenue: round2(p.revenue) })),
    revenueByRoute: Object.fromEntries(insights.routes.map((r) => [r.route, r.revenue])),
    routePerformance: insights.routes,
    coverageByProduce: insights.coverageByProduce,
    buyerReorders: buyers.rows
      .map((b) => ({ buyerName: b.organisation_name, buyerType: b.buyer_type, orders: Number(b.orders), revenue: round2(b.revenue), lastOrderAt: b.last_order_at, repeat: Number(b.orders) >= 2 }))
      .sort((a, b) => b.orders - a.orders || b.revenue - a.revenue)
      .slice(0, 10),
    // A trend needs at least two data points; otherwise the UI shows "Not enough data yet".
    weeklyRevenue: {
      sufficient: weekly.rows.length >= 2,
      points: weekly.rows.map((w) => ({ week: w.week, revenue: round2(w.revenue), orders: w.orders })),
    },
  };
}
