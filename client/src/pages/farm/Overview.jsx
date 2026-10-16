import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../services/api.js';
import { useApi } from '../../hooks/useApi.js';
import { useFarm } from '../../context/FarmContext.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { AsyncBoundary, Card, EmptyState, KpiCard, PageHeader } from '../../components/ui.jsx';
import { CoverageBar, RiskBadge, StatusBadge } from '../../components/domain.jsx';
import { Icons } from '../../components/Icons.jsx';
import { date, kg, pct, relativeDay } from '../../utils/format.js';
import AiPanel from '../../components/AiPanel.jsx';

const ACTION_STYLE = {
  RUN_HARVESTMATCH: { icon: Icons.Match, bg: 'var(--high-soft)', color: 'var(--high)' },
  COMPARE_ROUTES: { icon: Icons.Route, bg: 'var(--high-soft)', color: 'var(--high)' },
  ROUTING: { icon: Icons.Clock, bg: 'var(--medium-soft)', color: 'var(--medium)' },
  REVIEW_MATCHES: { icon: Icons.Check, bg: 'var(--medium-soft)', color: 'var(--medium)' },
  RECOVER_DEMAND: { icon: Icons.Recovery, bg: 'var(--medium-soft)', color: 'var(--medium)' },
  CONFIRM_ORDERS: { icon: Icons.Orders, bg: 'var(--info-soft)', color: 'var(--info)' },
  RESCUE_EXPIRING: { icon: Icons.Clock, bg: 'var(--high-soft)', color: 'var(--high)' },
  APPROVE_CAMPAIGNS: { icon: Icons.Campaign, bg: 'var(--primary-soft)', color: 'var(--primary)' },
};
const ACTION_ANCHOR = { COMPARE_ROUTES: '#routes', REVIEW_MATCHES: '#harvestmatch', RECOVER_DEMAND: '#recovery' };
const ACTION_LINK = {
  CONFIRM_ORDERS: '/farm/orders',
  RESCUE_EXPIRING: '/farm/rescue',
  APPROVE_CAMPAIGNS: '/farm/campaigns',
};

function BatchAction({ batch, isFarmAdmin }) {
  if (batch.status === 'CLOSED') return null;
  if (isFarmAdmin && batch.pendingMatches > 0) {
    return <Link className="btn btn-sm" to={`/farm/harvests/${batch.id}#harvestmatch`}>Review {batch.pendingMatches} match{batch.pendingMatches > 1 ? 'es' : ''}</Link>;
  }
  if (isFarmAdmin && batch.unallocatedQuantity > 0 && batch.riskLevel !== 'LOW') {
    return <Link className="btn btn-sm btn-primary" to={`/farm/harvests/${batch.id}#routes`}><Icons.Route />Compare routes</Link>;
  }
  if (isFarmAdmin && batch.unallocatedQuantity > 0 && batch.daysToHarvest <= 3) {
    return <Link className="btn btn-sm" to={`/farm/harvests/${batch.id}#recovery`}>Recover demand</Link>;
  }
  return <Link className="btn btn-sm btn-ghost" to={`/farm/harvests/${batch.id}`}>View</Link>;
}

/** Proposal §8.1: expected harvest against confirmed demand, per produce. */
function RadarByProduce({ rows }) {
  if (!rows.length) return null;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th>Produce</th><th className="num">Expected Harvest</th><th className="num">Confirmed Demand</th><th className="num">Potential</th><th className="num">Unallocated</th><th>Coverage</th><th>Risk</th></tr></thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.produceName}>
              <td className="cell-title">{p.produceName}{p.batches > 1 && <div className="cell-sub">{p.batches} batches</div>}</td>
              <td className="num">{kg(p.expectedHarvest, p.unit)}</td>
              <td className="num">{kg(p.confirmedDemand, p.unit)}</td>
              <td className="num muted">{kg(p.potentialDemand, p.unit)}</td>
              <td className="num strong">{kg(p.unallocated, p.unit)}</td>
              <td><CoverageBar value={p.demandCoverage} risk={p.riskLevel} /></td>
              <td><RiskBadge level={p.riskLevel} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Weekly demand briefing from the AI assistant (simulated without an OpenAI key). */
function InsightsCard({ farmId }) {
  const toast = useToast();
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      setResult(await api.post('/ai/insights', { farmId }));
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="AI demand insights" description="A short briefing written from this dashboard's data."
      actions={<button className="btn btn-sm" onClick={run} disabled={busy}><Icons.Sparkle />{busy ? 'Writing…' : result ? 'Refresh' : 'Generate'}</button>}>
      {result ? <AiPanel result={result} title="Demand briefing" /> : <p className="small muted">Summarises coverage gaps, potential demand and routing urgency. The AI only writes text — it never changes stock or prices.</p>}
    </Card>
  );
}

export default function Overview() {
  const { farmId, farm } = useFarm();
  const { isFarmAdmin } = useAuth();
  const state = useApi(() => api.get(`/farms/${farmId}/dashboard`), [farmId], { enabled: Boolean(farmId) });

  return (
    <>
      <PageHeader
        title="Demand Radar"
        description="Expected harvest against confirmed and potential demand, the strongest commercial route for what is still exposed, and what needs action today."
        actions={<Link className="btn" to="/farm/harvests"><Icons.Plus />New harvest</Link>}
      />
      {!farmId && <EmptyState title="No farm assigned">Ask a platform admin to link your account to a farm.</EmptyState>}
      {farmId && (
        <AsyncBoundary state={state}>
          {({ kpis, upcomingHarvest, actions, rules, radar }) => (
            <>
              <div className="kpi-grid">
                <KpiCard label="Expected Harvest" value={kg(kpis.expectedHarvest)} sub={`${upcomingHarvest.length} open batches`} tone="primary" />
                <KpiCard label="Confirmed Demand" value={kg(kpis.confirmedDemand)} sub={`${pct(kpis.demandCoverage)} coverage · ${kg(kpis.potentialDemand)} potential`} tone={kpis.riskLevel ? kpis.riskLevel.toLowerCase() : 'neutral'} />
                <KpiCard label="Unallocated Produce" value={kg(kpis.unallocatedProduce)} sub="No buyer or Rescue yet" tone="neutral" />
                <KpiCard label="At-Risk Produce" value={kg(kpis.atRiskProduce)} sub="Needs matching or recovery" tone={kpis.atRiskProduce > 0 ? 'high' : 'low'} />
                <KpiCard label="Active Orders" value={kpis.activeOrders} sub="Pending, confirmed or ready" tone="neutral" />
                <KpiCard label="Rescue Quantity" value={kg(kpis.rescueQuantity)} sub="Committed to Rescue" tone="neutral" />
              </div>

              <div className="grid grid-main-side">
                <div className="stack">
                <Card title="Demand coverage by produce" description="Expected harvest vs confirmed demand across open batches. Unallocated produce is commercial exposure." tight>
                  <RadarByProduce rows={radar} />
                  {radar.length === 0 && <EmptyState title="No upcoming harvests" />}
                </Card>
                <Card
                  title="Upcoming harvest batches"
                  description={`Potential = open demand not yet confirmed. Risk is rule-based on Demand Coverage: ≥${rules.riskThresholds.LOW}% LOW · ${rules.riskThresholds.MEDIUM}–${rules.riskThresholds.LOW - 1}% MEDIUM · <${rules.riskThresholds.MEDIUM}% HIGH`}
                  tight
                >
                  {upcomingHarvest.length === 0 ? (
                    <EmptyState title="No upcoming harvests" action={<Link className="btn btn-primary" to="/farm/harvests">Add a harvest batch</Link>} />
                  ) : (
                    <div className="table-wrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>Produce</th><th>Harvest Date</th><th className="num">Expected</th><th className="num">Confirmed Demand</th>
                            <th className="num">Potential Demand</th><th>Demand Coverage</th><th className="num">Unallocated</th><th>Risk</th><th>MarketRoute</th><th>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {upcomingHarvest.map((b) => (
                            <tr key={b.id}>
                              <td><Link className="cell-title" to={`/farm/harvests/${b.id}`}>{b.produceName}</Link><div className="cell-sub">{b.grade.toLowerCase()} grade</div></td>
                              <td className="nowrap">{date(b.harvestDate)}<div className="cell-sub">{relativeDay(b.harvestDate)}</div></td>
                              <td className="num">{kg(b.harvestQuantity, b.unit)}</td>
                              <td className="num">{kg(b.confirmedDemand, b.unit)}</td>
                              <td className="num" title={`${b.potentialDemand.requests} open request(s) fit this batch`}>{kg(b.potentialDemand.quantity, b.unit)}</td>
                              <td><CoverageBar value={b.demandCoverage} risk={b.riskLevel} /></td>
                              <td className="num strong">{kg(b.unallocatedQuantity, b.unit)}</td>
                              <td><RiskBadge level={b.riskLevel} /></td>
                              <td>
                                {b.marketRoute?.recommendedRoute ? (
                                  <><div className="strong small">{b.marketRoute.label}</div><div className="cell-sub">score {b.marketRoute.score}</div></>
                                ) : <StatusBadge status={b.status} />}
                              </td>
                              <td><BatchAction batch={b} isFarmAdmin={isFarmAdmin} /></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Card>
                </div>

                <div className="stack">
                <InsightsCard farmId={farmId} />
                <Card title="Requires action" tight>
                  {actions.length === 0 ? (
                    <EmptyState title="All clear">No harvests currently need attention.</EmptyState>
                  ) : (
                    <ul className="action-list">
                      {actions.map((a, i) => {
                        const s = ACTION_STYLE[a.type] || ACTION_STYLE.RECOVER_DEMAND;
                        const to = a.harvestBatchId ? `/farm/harvests/${a.harvestBatchId}${ACTION_ANCHOR[a.type] || ''}` : ACTION_LINK[a.type];
                        return (
                          <li key={i} className="action-item">
                            <div className="action-icon" style={{ background: s.bg, color: s.color }}><s.icon /></div>
                            <div className="action-text">{a.message}</div>
                            {to && <Link className="btn btn-sm btn-ghost" to={to} aria-label="Open"><Icons.Arrow /></Link>}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </Card>
                </div>
              </div>
            </>
          )}
        </AsyncBoundary>
      )}
    </>
  );
}
