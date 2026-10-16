// Tyllage-specific display components: risk, status, coverage, stock and match score.
import { Badge } from './ui.jsx';
import { kg, label, pct } from '../utils/format.js';

const RISK_TONE = { HIGH: 'high', MEDIUM: 'medium', LOW: 'low' };

export function RiskBadge({ level }) {
  if (!level) return <Badge tone="outline">—</Badge>;
  return (
    <Badge tone={RISK_TONE[level]} dot>
      {level}
    </Badge>
  );
}

const STATUS_TONE = {
  // harvests
  PLANNED: 'outline', AVAILABLE: 'info', PARTIALLY_ALLOCATED: 'primary', FULLY_ALLOCATED: 'low', AT_RISK: 'high', CLOSED: undefined,
  // orders
  PENDING: 'medium', CONFIRMED: 'info', READY: 'primary', COMPLETED: 'low', CANCELLED: undefined,
  // demand
  OPEN: 'info', PARTIALLY_FULFILLED: 'primary', FULFILLED: 'low', EXPIRED: undefined,
  // matches
  SUGGESTED: 'medium', APPROVED: 'low', REJECTED: undefined, SUPERSEDED: undefined,
  // rescue / campaigns / drops
  ACTIVE: 'low', SOLD_OUT: 'primary', DRAFT: 'medium', SENT: 'low', SCHEDULED: 'info',
  MOCK_SENT: 'low', FAILED: 'high', RESOLVED: 'low',
};

export function StatusBadge({ status }) {
  return <Badge tone={STATUS_TONE[status]}>{label(status)}</Badge>;
}

export function CoverageBar({ value, risk }) {
  const tone = RISK_TONE[risk] || (value >= 80 ? 'low' : value >= 50 ? 'medium' : 'high');
  return (
    <div className="coverage" title="Demand Coverage = Confirmed Demand ÷ Expected Harvest × 100">
      <div className="coverage-track">
        <div className={`coverage-fill ${tone}`} style={{ width: `${Math.min(100, value || 0)}%` }} />
      </div>
      <span className="coverage-value">{pct(value)}</span>
    </div>
  );
}

/** Horizontal breakdown of a batch: allocated / rescue / unallocated. */
export function StockBar({ batch }) {
  const total = batch.harvestQuantity || 1;
  const w = (n) => `${(Math.max(0, n) / total) * 100}%`;
  return (
    <div>
      <div className="stock-bar" role="img" aria-label={`Allocated ${batch.confirmedDemand}, Rescue ${batch.rescueQuantity}, unallocated ${batch.unallocatedQuantity}`}>
        <span className="stock-allocated" style={{ width: w(batch.confirmedDemand) }} />
        <span className="stock-rescue" style={{ width: w(batch.rescueQuantity) }} />
        <span style={{ width: w(batch.disposedQuantity || 0), background: 'var(--info)' }} />
        <span className="stock-remaining" style={{ width: w(batch.unallocatedQuantity) }} />
      </div>
      <div className="legend">
        <span><i style={{ background: 'var(--primary)' }} />Confirmed {kg(batch.confirmedDemand, batch.unit)}</span>
        {batch.rescueQuantity > 0 && <span><i style={{ background: 'var(--accent)' }} />Rescue {kg(batch.rescueQuantity, batch.unit)}</span>}
        {batch.disposedQuantity > 0 && <span><i style={{ background: 'var(--info)' }} />Donated / other {kg(batch.disposedQuantity, batch.unit)}</span>}
        <span><i style={{ background: '#e5b4ae' }} />Unallocated {kg(batch.unallocatedQuantity, batch.unit)}</span>
      </div>
    </div>
  );
}

export function ScoreRing({ score }) {
  const r = 23;
  const c = 2 * Math.PI * r;
  const color = score >= 80 ? 'var(--low)' : score >= 70 ? 'var(--primary)' : score >= 50 ? 'var(--medium)' : 'var(--high)';
  return (
    <div className="score-ring" title={`${score}% match`}>
      <svg width="54" height="54" viewBox="0 0 54 54" aria-hidden="true">
        <circle cx="27" cy="27" r={r} fill="none" stroke="var(--neutral-soft)" strokeWidth="5" />
        <circle cx="27" cy="27" r={r} fill="none" stroke={color} strokeWidth="5" strokeLinecap="round"
          strokeDasharray={`${(score / 100) * c} ${c}`} transform="rotate(-90 27 27)" />
      </svg>
      <span>{score}%</span>
    </div>
  );
}

/** Analytics metric that honestly reports insufficient data. */
export function MetricValue({ metric, suffix = '%' }) {
  if (!metric || !metric.sufficient) return <span className="insufficient">Not enough data yet</span>;
  return (
    <span>
      {Number(metric.value).toFixed(1)}
      {suffix}
    </span>
  );
}
