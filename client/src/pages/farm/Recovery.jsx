import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../services/api.js';
import { useApi } from '../../hooks/useApi.js';
import { useFarm } from '../../context/FarmContext.jsx';
import { AsyncBoundary, Badge, Card, EmptyState, Loading, PageHeader } from '../../components/ui.jsx';
import { CoverageBar, RiskBadge } from '../../components/domain.jsx';
import RecoveryPanel from '../../components/farm/RecoveryPanel.jsx';
import MatchList from '../../components/farm/MatchList.jsx';
import { date, dateTime, kg } from '../../utils/format.js';

function SelectedRecovery({ batchId, onChanged }) {
  const state = useApi(() => api.get(`/recovery/harvests/${batchId}`), [batchId]);
  const reload = () => {
    state.reload();
    onChanged();
  };
  if (state.loading && !state.data) return <Loading />;
  if (!state.data) return null;
  const { batch, matches, recovery, recoveryRun, lastRun } = state.data;
  const recoveryMatches = matches.filter((m) => m.source === 'RECOVERY');
  return (
    <div className="stack">
      <RecoveryPanel batch={batch} recovery={recovery} lastRunAt={recoveryRun?.createdAt} onRecovered={reload} onRescueCreated={reload} />
      {recovery && (
        <Card title="Recovery matches" description="Approve to create orders; weak matches are listed so you can decide.">
          <MatchList matches={recoveryMatches} excluded={lastRun?.runType === 'RECOVERY' ? lastRun.excluded : []} unit={batch.unit} canDecide onChanged={reload} showDecided={false} />
        </Card>
      )}
    </div>
  );
}

export default function Recovery() {
  const { farmId } = useFarm();
  const candidates = useApi(() => api.get('/recovery', { farmId }), [farmId], { enabled: Boolean(farmId) });
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    if (!selected && candidates.data?.length) setSelected(candidates.data[0].id);
  }, [candidates.data, selected]);

  return (
    <>
      <PageHeader
        title="Demand Recovery"
        description="When buyers cancel, harvests exceed demand, or produce stays unallocated near harvest, recover demand before it becomes waste. You approve every action."
      />
      <AsyncBoundary state={candidates}>
        {(rows) =>
          rows.length === 0 ? (
            <Card><EmptyState title="Nothing needs recovery">No batch currently has unallocated produce with a recovery trigger.</EmptyState></Card>
          ) : (
            <div className="grid grid-side-main">
              <Card tight title="Needs attention">
                <ul className="action-list">
                  {rows.map((c) => (
                    <li key={c.id} className="action-item" style={{ cursor: 'pointer', background: selected === c.id ? 'var(--primary-soft)' : undefined, alignItems: 'flex-start' }} onClick={() => setSelected(c.id)}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="row-between">
                          <span className="strong">{c.produceName}</span>
                          <RiskBadge level={c.riskLevel} />
                        </div>
                        <div className="small muted">{date(c.harvestDate)} · {kg(c.unallocatedQuantity, c.unit)} unallocated</div>
                        <div className="mt-8"><CoverageBar value={c.demandCoverage} risk={c.riskLevel} /></div>
                        <div className="row mt-8" style={{ gap: 4 }}>
                          {c.triggers.map((t) => <Badge key={t.code} tone="outline" className="badge-wrap">{t.label}</Badge>)}
                        </div>
                        {c.lastRecoveryAt && <div className="small muted mt-8">Last recovery {dateTime(c.lastRecoveryAt)}</div>}
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
              <div>
                {selected && (
                  <>
                    <div className="row-between" style={{ marginBottom: 12 }}>
                      <span className="small muted">Batch #{selected}</span>
                      <Link className="small" to={`/farm/harvests/${selected}`}>Open batch →</Link>
                    </div>
                    <SelectedRecovery key={selected} batchId={selected} onChanged={candidates.reload} />
                  </>
                )}
              </div>
            </div>
          )
        }
      </AsyncBoundary>
    </>
  );
}
