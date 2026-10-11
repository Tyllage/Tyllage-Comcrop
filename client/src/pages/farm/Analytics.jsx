import { useState } from 'react';
import { api } from '../../services/api.js';
import { useApi } from '../../hooks/useApi.js';
import { useFarm } from '../../context/FarmContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { AsyncBoundary, Badge, Card, Field, KpiCard, Modal, PageHeader } from '../../components/ui.jsx';
import { MetricValue } from '../../components/domain.jsx';
import { date, dateTime, kg, label, money, pct } from '../../utils/format.js';

const METRICS = [
  ['sellThrough', 'Harvest sell-through', 'kg'],
  ['demandCoverage', 'Demand coverage (open batches)', 'kg'],
  ['rescueRate', 'Rescue rate', 'kg'],
  ['matchConversion', 'Match conversion', 'matches'],
  ['repeatBuyerRate', 'Repeat buyer rate', 'buyers'],
  ['channelConcentration', 'Channel concentration', '$'],
];

function MetricCard({ title, metric, unit }) {
  const fmt = (n) => (unit === '$' ? money(n) : unit === 'kg' ? kg(n) : n);
  return (
    <div className="card kpi metric-card">
      <div className="kpi-label">{title}</div>
      <div className="metric-value mt-8"><MetricValue metric={metric} /></div>
      {metric?.sufficient && <div className="kpi-sub">{fmt(metric.numerator)} of {fmt(metric.denominator)}{unit !== '$' && unit !== 'kg' ? ` ${unit}` : ''}</div>}
      {metric?.largestBuyer && <div className="kpi-sub">Largest: {metric.largestBuyer}</div>}
      <div className="formula">{metric?.formula}</div>
    </div>
  );
}

/** KPI with its own unit (hours, kg, $/kg) that honestly reports "Not enough data yet". */
function UnitMetricCard({ title, metric, format, sub }) {
  return (
    <div className="card kpi metric-card">
      <div className="kpi-label">{title}</div>
      <div className="metric-value mt-8">{metric?.sufficient ? format(metric.value) : <span className="insufficient">Not enough data yet</span>}</div>
      {metric?.sufficient && sub && <div className="kpi-sub">{sub(metric)}</div>}
      <div className="formula">{metric?.formula}</div>
    </div>
  );
}

function Bars({ rows, value, labelKey, format }) {
  const max = Math.max(...rows.map(value), 0);
  return (
    <div className="bar-chart">
      {rows.map((r) => (
        <div className="bar-row" key={r[labelKey]}>
          <span className="small">{r[labelKey]}</span>
          <div className="bar-track"><div className="bar-fill" style={{ width: `${max ? (value(r) / max) * 100 : 0}%` }} /></div>
          <span className="small num strong">{format(r)}</span>
        </div>
      ))}
    </div>
  );
}

const fmtValue = (v, unit) => {
  if (v === null || v === undefined) return '—';
  if (unit === '%') return `${Number(v).toFixed(1)}%`;
  if (unit === '$/kg') return `${money(v)}/kg`;
  if (unit === 'hours') return `${Number(v).toFixed(1)} h`;
  return `${Number(v).toFixed(1)} ${unit}`;
};

function BaselineModal({ farmId, row, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({ baselineValue: row.baseline ?? '', periodLabel: row.periodLabel || '', notes: row.notes || '' });
  const submit = async (e) => {
    e.preventDefault();
    try {
      const data = await api.put('/analytics/baselines', {
        farmId, metricKey: row.key, baselineValue: Number(form.baselineValue), periodLabel: form.periodLabel || null, notes: form.notes || null,
      });
      toast(`Baseline for ${row.label} saved`);
      onSaved(data);
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  return (
    <Modal title={`Baseline — ${row.label}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="baseline-form">Save baseline</button></>}>
      <form id="baseline-form" className="form" onSubmit={submit}>
        <p className="small muted">Record the farm's figure from before the pilot, measured the same way. Tyllage never invents baselines.</p>
        <Field label={`Baseline value (${row.unit})`}><input className="input" aria-label={`Baseline value (${row.unit})`} type="number" min={row.unit === '$/kg' ? undefined : 0} max={row.unit === '%' ? 100 : undefined} step="0.1" value={form.baselineValue} onChange={(e) => setForm((f) => ({ ...f, baselineValue: e.target.value }))} required /></Field>
        <Field label="Period"><input className="input" value={form.periodLabel} onChange={(e) => setForm((f) => ({ ...f, periodLabel: e.target.value }))} placeholder="e.g. Aug 2026, before Tyllage" /></Field>
        <Field label="How it was measured"><input className="input" value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} /></Field>
      </form>
    </Modal>
  );
}

function FrameworkRows({ rows, onEdit }) {
  return rows.map((r) => (
    <tr key={r.key}>
      <td className="cell-title">{r.label}{r.periodLabel && <div className="cell-sub">Baseline: {r.periodLabel}</div>}</td>
      <td className="small muted">{r.definition}</td>
      <td className="num">{r.baseline !== null ? fmtValue(r.baseline, r.unit) : <span className="muted">{r.baselineStatus}</span>}</td>
      <td className="num">{r.pilot !== null ? fmtValue(r.pilot, r.unit) : <span className="muted">To measure</span>}</td>
      <td className="num">
        {r.change === null ? '—' : (
          <Badge tone={r.direction === 'IMPROVED' ? 'low' : r.direction === 'WORSENED' ? 'high' : undefined}>
            {r.change > 0 ? '+' : ''}{fmtValue(r.change, r.unit === '%' ? 'pp' : r.unit)}
          </Badge>
        )}
      </td>
      <td>{r.baselineApplicable !== false && <button className="btn btn-sm btn-ghost" onClick={() => onEdit(r)}>{r.baseline !== null ? 'Edit' : 'Set baseline'}</button>}</td>
    </tr>
  ));
}

function PilotFramework({ farmId }) {
  const state = useApi(() => api.get('/analytics/comparison', { farmId }), [farmId]);
  const [editing, setEditing] = useState(null);
  return (
    <Card tight title="Pilot success framework" description="Measured against the farm's own pre-pilot baseline — no improvement percentages are promised before a baseline exists.">
      <AsyncBoundary state={state}>
        {({ rows }) => (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>KPI</th><th>Definition</th><th className="num">Baseline</th><th className="num">Pilot result</th><th className="num">Change</th><th /></tr></thead>
              <tbody>
                <FrameworkRows rows={rows.filter((r) => r.headline)} onEdit={setEditing} />
                <tr><td colSpan={6} className="small muted strong" style={{ background: 'var(--surface-2)' }}>Supporting measures</td></tr>
                <FrameworkRows rows={rows.filter((r) => !r.headline)} onEdit={setEditing} />
              </tbody>
            </table>
          </div>
        )}
      </AsyncBoundary>
      {editing && <BaselineModal farmId={farmId} row={editing} onClose={() => setEditing(null)} onSaved={(data) => { setEditing(null); state.setData(data); }} />}
    </Card>
  );
}

/** Which routes preserve margin after fulfilment, cancel least, and recover surplus best. */
function RoutePerformance({ rows }) {
  const active = rows.filter((r) => r.orders > 0 || r.cancellationRate !== null);
  if (!active.length) return <span className="insufficient">Not enough data yet</span>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Route</th><th className="num">Orders</th><th className="num">Sold</th><th className="num">Revenue</th><th className="num">Avg price</th>
            <th className="num">Fulfilment</th><th className="num">Net margin</th><th className="num">Cancellation</th><th className="num">Recovered</th>
          </tr>
        </thead>
        <tbody>
          {active.map((r) => (
            <tr key={r.route}>
              <td className="cell-title">{r.label}</td>
              <td className="num">{r.orders}</td>
              <td className="num">{kg(r.quantity)}</td>
              <td className="num">{money(r.revenue)}</td>
              <td className="num">{r.averagePricePerKg !== null ? `${money(r.averagePricePerKg)}/kg` : '—'}</td>
              <td className="num">{r.fulfilmentPerKg !== null ? `${money(r.fulfilmentPerKg)}/kg` : '—'}</td>
              <td className="num strong">{r.netMarginPerKg !== null ? `${money(r.netMarginPerKg)}/kg` : '—'}</td>
              <td className="num">{pct(r.cancellationRate)}</td>
              <td className="num">{r.recoveredQuantity > 0 ? kg(r.recoveredQuantity) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Analytics() {
  const { farmId } = useFarm();
  const state = useApi(() => api.get('/analytics', { farmId }), [farmId], { enabled: Boolean(farmId) });

  return (
    <>
      <PageHeader title="Tyllage Insights" description="Commercial learning from your own transactions: which crops achieve stronger coverage, which routes preserve margin, which buyers reorder and which routes recover surplus. Where data is thin, we say so instead of drawing a trend." />
      <AsyncBoundary state={state}>
        {({ totals, metrics, topProduce, routePerformance, coverageByProduce, buyerReorders, weeklyRevenue }) => (
          <div className="stack">
            <div className="kpi-grid">
              <KpiCard label="Revenue" value={money(totals.revenue)} sub="Confirmed, ready & completed" tone="primary" />
              <KpiCard label="Orders" value={totals.orders} sub={`${kg(totals.soldQuantity)} sold`} tone="neutral" />
              <KpiCard label="At-risk now" value={kg(totals.atRiskQuantity)} tone={totals.atRiskQuantity > 0 ? 'high' : 'low'} />
              <KpiCard label="Rescue listed" value={kg(totals.rescueListedQuantity)} sub={`${kg(totals.rescueSoldQuantity)} reserved`} tone="neutral" />
              <KpiCard label="Matches generated" value={totals.matchesGenerated} sub={`${totals.matchesApproved} approved · ${totals.matchesRejected} rejected`} tone="neutral" />
              <KpiCard label="Rescue active" value={kg(totals.rescueActiveQuantity)} sub="Still available to buyers" tone="neutral" />
            </div>

            <div className="grid grid-3">
              {METRICS.map(([key, title, unit]) => <MetricCard key={key} title={title} metric={metrics[key]} unit={unit} />)}
              <UnitMetricCard title="Demand Recovery Time" metric={metrics.demandRecoveryTime}
                format={(v) => `${v.toFixed(1)} h`} sub={(m) => `${m.recovered} of ${m.disruptions} disruption(s) recovered`} />
              <UnitMetricCard title="Waste avoided" metric={metrics.wasteAvoided}
                format={(v) => kg(v)} sub={(m) => `${kg(m.recovered)} recovered · ${kg(m.redirected)} donated/alt. use · ${kg(m.recordedWaste)} recorded waste`} />
              <UnitMetricCard title="Average margin per kg (after fulfilment)" metric={metrics.averageMarginPerKg}
                format={(v) => `${money(v)}/kg`} sub={(m) => `${money(m.numerator)} margin on ${kg(m.denominator)} after ${money(m.fulfilment)} fulfilment · costs known for ${m.coverage}% of sales`} />
              <UnitMetricCard title="Waste / at-risk quantity" metric={metrics.notCommercialised}
                format={(v) => kg(v)} sub={(m) => `Not commercialised, of ${kg(m.harvested)} across ${m.batches} batch(es) whose sales window has closed`} />
            </div>

            <Card tight title="Route performance" description="By MarketRoute route. Net margin is after production cost and estimated fulfilment cost; recovered = sold after Demand Recovery started on the batch.">
              <RoutePerformance rows={routePerformance} />
            </Card>

            <PilotFramework farmId={farmId} />

            <div className="grid grid-3">
              <Card title="Top produce by revenue">
                {topProduce.length ? (
                  <Bars rows={topProduce} labelKey="name" value={(r) => r.revenue} format={(r) => money(r.revenue)} />
                ) : <span className="insufficient">Not enough data yet</span>}
              </Card>
              <Card title="Demand coverage by crop" description="Last 60 days and upcoming batches">
                {coverageByProduce.length ? (
                  <Bars rows={coverageByProduce} labelKey="name" value={(r) => r.coverage || 0} format={(r) => pct(r.coverage)} />
                ) : <span className="insufficient">Not enough data yet</span>}
              </Card>
              <Card title="Weekly revenue (8 weeks)">
                {weeklyRevenue.sufficient ? (
                  <div className="column-chart" role="img" aria-label="Weekly revenue">
                    {weeklyRevenue.points.map((p) => {
                      const max = Math.max(...weeklyRevenue.points.map((x) => x.revenue));
                      return (
                        <div className="column" key={p.week} title={`${money(p.revenue)} · ${p.orders} orders`}>
                          <small className="strong">{money(p.revenue).replace('.00', '')}</small>
                          <div className="column-bar" style={{ height: `${(p.revenue / max) * 110}px` }} />
                          <small>{date(p.week)}</small>
                        </div>
                      );
                    })}
                  </div>
                ) : <span className="insufficient">Not enough data yet — at least two weeks of sales are needed to show a trend.</span>}
              </Card>
            </div>

            <Card tight title="Buyer reorders" description="Which buyers come back. Reducing reliance on one buyer lowers channel concentration.">
              {buyerReorders.length ? (
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>Buyer</th><th>Type</th><th className="num">Orders</th><th className="num">Revenue</th><th>Last order</th><th /></tr></thead>
                    <tbody>
                      {buyerReorders.map((b) => (
                        <tr key={b.buyerName}>
                          <td className="cell-title">{b.buyerName}</td>
                          <td>{label(b.buyerType)}</td>
                          <td className="num">{b.orders}</td>
                          <td className="num">{money(b.revenue)}</td>
                          <td className="nowrap">{dateTime(b.lastOrderAt)}</td>
                          <td>{b.repeat ? <Badge tone="low">Repeat buyer</Badge> : <Badge tone="outline">First order</Badge>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <div className="card-body"><span className="insufficient">Not enough data yet</span></div>}
            </Card>
          </div>
        )}
      </AsyncBoundary>
    </>
  );
}
