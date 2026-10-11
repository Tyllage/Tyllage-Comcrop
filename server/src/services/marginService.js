/**
 * Margin Guard — "selling everything is not enough if the farm loses money".
 * Compares a price against the farm-private production cost and the farm's minimum margin.
 * Advisory only: it warns, the farmer decides.
 */
import { round2 } from '../utils/numbers.js';

const round1 = (n) => Math.round(n * 10) / 10;

/** Lowest price that still meets the farm's minimum margin. */
export function minViablePrice(cost, minMarginPct) {
  if (cost === null || cost === undefined) return null;
  return round2(Number(cost) / (1 - Number(minMarginPct) / 100));
}

/**
 * Margin on a sale. `fulfilment` is the estimated fulfilment cost per unit (0 = margin before logistics);
 * margin % is always relative to the selling price.
 */
export function marginGuard({ unitPrice, cost, minMarginPct, quantity = 0, fulfilment = 0, fulfilmentTotal }) {
  if (cost === null || cost === undefined) {
    return { known: false, status: 'UNKNOWN', message: 'Production cost not recorded — margin unknown' };
  }
  const price = Number(unitPrice);
  const logistics = quantity > 0 && fulfilmentTotal !== undefined ? Number(fulfilmentTotal) / quantity : Number(fulfilment) || 0;
  const rawMargin = price - Number(cost) - logistics;
  const perUnit = round2(rawMargin);
  const rawPct = price > 0 ? (rawMargin / price) * 100 : null;
  const pct = rawPct === null ? null : round1(rawPct);
  let status = 'OK';
  if (rawMargin < 0) status = 'LOSS';
  else if (rawPct < Number(minMarginPct)) status = 'BELOW_MINIMUM';
  const after = logistics > 0 ? ` after $${logistics.toFixed(2)}/unit fulfilment` : '';
  const message = {
    OK: `${pct}% margin ($${perUnit.toFixed(2)}/unit)${after} meets the farm minimum of ${minMarginPct}%`,
    BELOW_MINIMUM: `Margin Guard: ${pct}% margin${after} is below the farm minimum of ${minMarginPct}%`,
    LOSS: `Margin Guard: sells $${Math.abs(perUnit).toFixed(2)}/unit below production cost${after}`,
  }[status];
  return {
    known: true, status, perUnit, pct, total: round2(rawMargin * quantity), minMarginPct: Number(minMarginPct),
    fulfilmentPerUnit: round2(logistics), message,
  };
}

/** Batch-level view: viable price floor, margins at preferred/minimum price, and margin on committed sales. */
export function batchMarginGuard(row) {
  const cost = row.production_cost === null || row.production_cost === undefined ? null : Number(row.production_cost);
  const minMargin = Number(row.min_margin_pct ?? 0);
  if (cost === null) return { known: false, message: 'Record a production cost to enable Margin Guard' };
  const floor = minViablePrice(cost, minMargin);
  const committedQty = Number(row.allocated_quantity || 0) + Number(row.rescue_sold_quantity || 0);
  const committedRevenue = Number(row.committed_revenue || 0);
  const committedMargin = round2(committedRevenue - committedQty * cost);
  const warnings = [];
  if (Number(row.min_price) < floor) {
    warnings.push(`Minimum acceptable price $${Number(row.min_price).toFixed(2)} is below the minimum viable price $${floor.toFixed(2)}`);
  }
  return {
    known: true,
    costPerUnit: cost,
    minMarginPct: minMargin,
    minViablePrice: floor,
    atPreferredPrice: marginGuard({ unitPrice: row.preferred_price, cost, minMarginPct: minMargin }),
    atMinimumPrice: marginGuard({ unitPrice: row.min_price, cost, minMarginPct: minMargin }),
    committedRevenue: round2(committedRevenue),
    committedMargin,
    committedMarginPct: committedRevenue > 0 ? round1((committedMargin / committedRevenue) * 100) : null,
    warnings,
  };
}
