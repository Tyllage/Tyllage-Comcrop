import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { api } from '../../services/api.js';
import { useApi } from '../../hooks/useApi.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useDialog } from '../../context/DialogContext.jsx';
import { AsyncBoundary, Card, Notice } from '../../components/ui.jsx';
import { CoverageBar, RiskBadge, StatusBadge, StockBar } from '../../components/domain.jsx';
import { Icons } from '../../components/Icons.jsx';
import HarvestFormModal from '../../components/farm/HarvestFormModal.jsx';
import MatchList from '../../components/farm/MatchList.jsx';
import RecoveryPanel from '../../components/farm/RecoveryPanel.jsx';
import RoutingCard from '../../components/farm/RoutingCard.jsx';
import MarginGuardCard from '../../components/farm/MarginGuardCard.jsx';
import MarketRouteCard from '../../components/farm/MarketRouteCard.jsx';
import { date, dateTime, kg, label, money, relativeDay, routeLabel } from '../../utils/format.js';

function Summary({ b }) {
  return (
    <Card>
      <div className="grid grid-2" style={{ alignItems: 'center' }}>
        <div>
          <div className="row" style={{ gap: 28 }}>
            <div><div className="small muted">{b.actualQuantity ? 'Actual harvest' : 'Expected harvest'}</div><div className="kpi-value">{kg(b.harvestQuantity, b.unit)}</div></div>
            <div><div className="small muted">Confirmed demand</div><div className="kpi-value">{kg(b.confirmedDemand, b.unit)}</div></div>
            <div><div className="small muted">Remaining</div><div className="kpi-value" style={{ color: b.unallocatedQuantity > 0 ? 'var(--high)' : 'var(--low)' }}>{kg(b.unallocatedQuantity, b.unit)}</div></div>
          </div>
          <div className="mt-16"><StockBar batch={b} /></div>
        </div>
        <div>
          <div className="stat-line"><span>Demand coverage</span><span style={{ width: 180 }}><CoverageBar value={b.demandCoverage} risk={b.riskLevel} /></span></div>
          <div className="stat-line"><span>Expected / actual</span><b>{kg(b.expectedQuantity, b.unit)} / {b.actualQuantity ? kg(b.actualQuantity, b.unit) : '—'}</b></div>
          <div className="stat-line"><span>Preferred / minimum price</span><b>{money(b.preferredPrice)} / {money(b.minPrice)}</b></div>
          <div className="stat-line"><span>Grade</span><b>{label(b.grade)}</b></div>
          {b.minOrderQuantity > 0 && <div className="stat-line"><span>Farm minimum order</span><b>{kg(b.minOrderQuantity, b.unit)}</b></div>}
          <div className="stat-line"><span>Allowed routes</span><b>{b.allowedRoutes?.length ? b.allowedRoutes.map(routeLabel).join(', ') : 'Any route'}</b></div>
          {b.primaryRoute && <div className="stat-line"><span>Primary route</span><b>{routeLabel(b.primaryRoute)}</b></div>}
          {b.disposedQuantity > 0 && <div className="stat-line"><span>Donated / alternative use / waste</span><b>{kg(b.disposedQuantity, b.unit)}</b></div>}
          {b.notes && <div className="stat-line"><span>Notes</span><span className="muted">{b.notes}</span></div>}
        </div>
      </div>
    </Card>
  );
}

export default function HarvestDetail() {
  const { id } = useParams();
  const location = useLocation();
  const { isFarmAdmin } = useAuth();
  const toast = useToast();
  const dialog = useDialog();
  const state = useApi(() => api.get(`/recovery/harvests/${id}`), [id]);
  const [editing, setEditing] = useState(false);
  const [matching, setMatching] = useState(false);

  useEffect(() => {
    const target = location.hash.slice(1);
    if (['recovery', 'routes', 'harvestmatch'].includes(target) && state.data) document.getElementById(target)?.scrollIntoView({ behavior: 'smooth' });
  }, [location.hash, state.data]);

  const runMatching = async (route) => {
    setMatching(true);
    try {
      await api.post(`/harvests/${id}/run-matching`, route ? { route } : {});
      toast(route ? `HarvestMatch re-ran within ${routeLabel(route)}` : 'HarvestMatch ranked buyers across all routes');
      await state.reload();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setMatching(false);
    }
  };

  const act = async (path, message) => {
    try {
      await api.post(path);
      toast(message);
      state.reload();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  return (
    <AsyncBoundary state={state} loadingLabel="Loading harvest batch…">
      {({ batch: b, matches, lastRun, recovery, recoveryRun }) => {
        const excluded = lastRun?.excluded || [];
        const closed = b.status === 'CLOSED';
        return (
          <>
            <div className="small muted"><Link to="/farm/harvests">Harvests</Link> / Batch #{b.id}</div>
            <div className="page-header mt-8">
              <div>
                <div className="row" style={{ gap: 10 }}>
                  <h1>{b.produceName}</h1>
                  <RiskBadge level={b.riskLevel} />
                  <StatusBadge status={b.status} />
                </div>
                <p>Harvest {date(b.harvestDate, { weekday: true })} · {relativeDay(b.harvestDate)} · {b.farmName}</p>
              </div>
              {!closed && (
                <div className="page-actions">
                  <button className="btn" onClick={() => setEditing(true)}>Edit batch</button>
                  {!b.markedAvailable && <button className="btn" onClick={() => act(`/harvests/${b.id}/mark-available`, 'Marked available')}>Mark available</button>}
                  {isFarmAdmin && (
                    <button className="btn btn-danger" onClick={async () => (await dialog.confirm({
                      title: `Close the ${b.produceName} batch?`, tone: 'danger', icon: 'Harvest',
                      message: 'It will be archived and no further matching can run. Existing orders are kept.',
                      confirmLabel: 'Close batch', cancelLabel: 'Keep open',
                    })) && act(`/harvests/${b.id}/close`, 'Batch closed')}>
                      Close batch
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="stack">
              <Summary b={b} />

              {!closed && (
                <div id="routes">
                  <MarketRouteCard batch={b} canAct={isFarmAdmin} version={`${b.unallocatedQuantity}-${lastRun?.id ?? 0}`} onSelected={() => state.reload()} />
                </div>
              )}

              {isFarmAdmin && !closed && (
                <div id="harvestmatch">
                  <Card
                    title={lastRun?.marketRoute ? `HarvestMatch — within ${routeLabel(lastRun.marketRoute)}` : 'HarvestMatch'}
                    description="Ranks buyers with transparent weighted rules: produce 30% · date 20% · price 20% · quantity 10% · buyer reliability 10% · location 10%. Select a route above to rank buyers within it."
                    actions={
                      <>
                        {lastRun?.marketRoute && (
                          <button className="btn btn-ghost" onClick={() => runMatching(null)} disabled={matching || b.unallocatedQuantity <= 0}>All routes</button>
                        )}
                        <button className="btn btn-primary" onClick={() => runMatching(lastRun?.marketRoute)} disabled={matching || b.unallocatedQuantity <= 0}>
                          <Icons.Match />{matching ? 'Matching…' : lastRun ? 'Re-run HarvestMatch' : 'Run across all routes'}
                        </button>
                      </>
                    }
                  >
                    {b.unallocatedQuantity <= 0 && <Notice tone="success">Fully allocated — nothing left to match.</Notice>}
                    {lastRun && <div className="small muted" style={{ marginBottom: 12 }}>Last {lastRun.runType === 'RECOVERY' ? 'recovery' : 'HarvestMatch'} run {dateTime(lastRun.createdAt)} against {kg(lastRun.remainingQuantity, b.unit)} unallocated{lastRun.marketRoute ? `, within ${routeLabel(lastRun.marketRoute)}` : ', across all routes'}.</div>}
                    <MatchList matches={matches} excluded={excluded} unit={b.unit} canDecide={isFarmAdmin} onChanged={state.reload} />
                  </Card>
                </div>
              )}
              {!isFarmAdmin && (
                <Notice tone="info">Farm admins select routes, run HarvestMatch and approve allocations. You can update quantities and fulfilment details.</Notice>
              )}

              {!closed && (
                <div className="grid grid-main-side">
                  <RoutingCard batch={b} canAct={isFarmAdmin} onChanged={state.reload} />
                  {isFarmAdmin && <MarginGuardCard batch={b} />}
                </div>
              )}

              {isFarmAdmin && !closed && (
                <div id="recovery">
                  <RecoveryPanel
                    batch={b}
                    recovery={recovery}
                    lastRunAt={recoveryRun?.createdAt}
                    onRecovered={() => state.reload()}
                    onRescueCreated={() => state.reload()}
                  />
                </div>
              )}
            </div>

            {editing && (
              <HarvestFormModal
                batch={b}
                onClose={() => setEditing(false)}
                onSaved={() => {
                  setEditing(false);
                  state.reload();
                }}
              />
            )}
          </>
        );
      }}
    </AsyncBoundary>
  );
}
