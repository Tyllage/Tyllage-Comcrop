import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../services/api.js';
import { useApi } from '../../hooks/useApi.js';
import { useFarm } from '../../context/FarmContext.jsx';
import { AsyncBoundary, Card, EmptyState, PageHeader } from '../../components/ui.jsx';
import { CoverageBar, RiskBadge, StatusBadge } from '../../components/domain.jsx';
import { Icons } from '../../components/Icons.jsx';
import HarvestFormModal from '../../components/farm/HarvestFormModal.jsx';
import { date, kg, label, money, relativeDay } from '../../utils/format.js';

export default function Harvests() {
  const { farmId } = useFarm();
  const navigate = useNavigate();
  const [includeClosed, setIncludeClosed] = useState(false);
  const [creating, setCreating] = useState(false);
  const state = useApi(() => api.get('/harvests', { farmId, includeClosed }), [farmId, includeClosed], { enabled: Boolean(farmId) });

  return (
    <>
      <PageHeader
        title="Harvests"
        description="Plan batches, record actual quantities and keep prices current. Coverage and risk update from real allocations."
        actions={<button className="btn btn-primary" onClick={() => setCreating(true)}><Icons.Plus />New harvest batch</button>}
      />
      <Card
        tight
        title="Harvest batches"
        actions={
          <label className="checkbox small">
            <input type="checkbox" checked={includeClosed} onChange={(e) => setIncludeClosed(e.target.checked)} />
            Show closed batches
          </label>
        }
      >
        <AsyncBoundary state={state}>
          {(batches) =>
            batches.length === 0 ? (
              <EmptyState title="No harvest batches yet" action={<button className="btn btn-primary" onClick={() => setCreating(true)}>Create the first batch</button>} />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Produce</th><th>Harvest date</th><th className="num">Expected</th><th className="num">Actual</th><th>Grade</th>
                      <th className="num">Preferred / min</th><th>Coverage</th><th className="num">Unallocated</th><th>Risk</th><th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {batches.map((b) => (
                      <tr key={b.id} className="clickable" onClick={() => navigate(`/farm/harvests/${b.id}`)}>
                        <td className="cell-title nowrap">{b.produceName}<div className="cell-sub">Batch #{b.id}</div></td>
                        <td className="nowrap">{date(b.harvestDate)}<div className="cell-sub">{relativeDay(b.harvestDate)}</div></td>
                        <td className="num">{kg(b.expectedQuantity, b.unit)}</td>
                        <td className="num">{b.actualQuantity ? kg(b.actualQuantity, b.unit) : <span className="muted">—</span>}</td>
                        <td>{label(b.grade)}</td>
                        <td className="num nowrap">{money(b.preferredPrice)} / {money(b.minPrice)}</td>
                        <td><CoverageBar value={b.demandCoverage} risk={b.riskLevel} /></td>
                        <td className="num">{kg(b.unallocatedQuantity, b.unit)}</td>
                        <td><RiskBadge level={b.riskLevel} /></td>
                        <td><StatusBadge status={b.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
        </AsyncBoundary>
      </Card>
      {creating && (
        <HarvestFormModal
          onClose={() => setCreating(false)}
          onSaved={(b) => {
            setCreating(false);
            navigate(`/farm/harvests/${b.id}`);
          }}
        />
      )}
    </>
  );
}
