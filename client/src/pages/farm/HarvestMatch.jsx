import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../services/api.js';
import { useApi } from '../../hooks/useApi.js';
import { useFarm } from '../../context/FarmContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { AsyncBoundary, Card, EmptyState, PageHeader } from '../../components/ui.jsx';
import { CoverageBar, RiskBadge, StatusBadge } from '../../components/domain.jsx';
import { Icons } from '../../components/Icons.jsx';
import { date, dateTime, kg, label, money, routeLabel } from '../../utils/format.js';

const FACTORS = [
  ['Produce / demand match', 30, 'Exact produce = 100, close name (e.g. Baby Kale ≈ Kale) = 75, otherwise excluded'],
  ['Required date', 20, '0–2 days after harvest = 100, 3–4 = 75, later = 45. Past demand, dates before harvest, or beyond the crop shelf life / freshness policy are excluded.'],
  ['Price compatibility', 20, 'Buyer max ≥ preferred = 100; between minimum and preferred scales 50–100; below minimum = excluded'],
  ['Quantity fit', 10, 'Request fits remaining supply = 100; partial supply scales down'],
  ['Buyer reliability', 10, 'Completed ÷ (completed + buyer cancellations); neutral 60 with fewer than 2 past orders'],
  ['Location / collection', 10, 'Same region 100, neighbouring 75, distant 50; reduced if collection method unsupported'],
];

export default function HarvestMatch() {
  const { farmId } = useFarm();
  const toast = useToast();
  const navigate = useNavigate();
  const [running, setRunning] = useState(null);
  const batches = useApi(() => api.get('/harvests', { farmId }), [farmId], { enabled: Boolean(farmId) });
  const decisions = useApi(() => api.get('/matches', { farmId, status: 'APPROVED,REJECTED' }), [farmId], { enabled: Boolean(farmId) });

  const run = async (b) => {
    setRunning(b.id);
    try {
      await api.post(`/harvests/${b.id}/run-matching`);
      navigate(`/farm/harvests/${b.id}#harvestmatch`);
    } catch (err) {
      toast(err.message, 'error');
      setRunning(null);
    }
  };

  return (
    <>
      <PageHeader
        title="HarvestMatch"
        description="Once a route is chosen in MarketRoute, HarvestMatch ranks the specific buyers within it. You can also rank across all routes. Every recommendation is explainable and nothing is allocated without your approval."
      />
      <div className="grid grid-main-side">
        <Card tight title="Batches to match" description="Open batches with unallocated produce, lowest coverage first.">
          <AsyncBoundary state={batches}>
            {(rows) => {
              const open = rows.filter((b) => b.unallocatedQuantity > 0).sort((a, b) => (a.demandCoverage ?? 0) - (b.demandCoverage ?? 0));
              if (!open.length) return <EmptyState title="Everything is allocated">No open batch has unallocated produce.</EmptyState>;
              return (
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>Produce</th><th>Harvest</th><th>Coverage</th><th className="num">Unallocated</th><th>Risk</th><th>Status</th><th /></tr></thead>
                    <tbody>
                      {open.map((b) => (
                        <tr key={b.id}>
                          <td><Link className="cell-title" to={`/farm/harvests/${b.id}`}>{b.produceName}</Link></td>
                          <td className="nowrap">{date(b.harvestDate, { weekday: true })}</td>
                          <td><CoverageBar value={b.demandCoverage} risk={b.riskLevel} /></td>
                          <td className="num strong">{kg(b.unallocatedQuantity, b.unit)}</td>
                          <td><RiskBadge level={b.riskLevel} /></td>
                          <td><StatusBadge status={b.status} /></td>
                          <td className="nowrap">
                            <Link className="btn btn-sm" to={`/farm/harvests/${b.id}#routes`}><Icons.Route />Routes</Link>{' '}
                            <button className="btn btn-sm btn-primary" onClick={() => run(b)} disabled={running === b.id} title="Rank buyers across all routes">
                              <Icons.Match />{running === b.id ? 'Matching…' : 'All routes'}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            }}
          </AsyncBoundary>
        </Card>

        <Card title="How scores are calculated" description="Transparent weighted rules — not machine learning.">
          {FACTORS.map(([name, weight, rule]) => (
            <div key={name} style={{ padding: '8px 0', borderBottom: '1px dashed var(--border)' }}>
              <div className="row-between"><span className="strong small">{name}</span><span className="badge badge-primary">{weight}%</span></div>
              <div className="small muted">{rule}</div>
            </div>
          ))}
        </Card>
      </div>

      <Card tight title="Recent decisions" className="mt-16">
        <AsyncBoundary state={decisions}>
          {(rows) =>
            rows.length === 0 ? <EmptyState title="No decisions yet">Approved and rejected matches will appear here.</EmptyState> : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Decided</th><th>Produce</th><th>Buyer</th><th>Route</th><th className="num">Score</th><th className="num">Quantity</th><th className="num">Unit price</th><th>Source</th><th>Decision</th><th>Order</th></tr></thead>
                  <tbody>
                    {rows.map((m) => (
                      <tr key={m.id}>
                        <td className="nowrap">{dateTime(m.decidedAt)}</td>
                        <td>{m.produceName}</td>
                        <td>{m.buyerName}<div className="cell-sub">{label(m.buyerType)}</div></td>
                        <td>{m.marketRoute ? routeLabel(m.marketRoute) : '—'}</td>
                        <td className="num">{m.matchScore}%</td>
                        <td className="num">{kg(m.approvedQuantity ?? m.recommendedQuantity)}</td>
                        <td className="num">{money(m.unitPrice)}</td>
                        <td>{label(m.source)}</td>
                        <td><StatusBadge status={m.status} /></td>
                        <td>{m.orderId ? `#${m.orderId}` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
        </AsyncBoundary>
      </Card>
    </>
  );
}
