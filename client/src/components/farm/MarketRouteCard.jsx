import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../services/api.js';
import { useApi } from '../../hooks/useApi.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useDialog } from '../../context/DialogContext.jsx';
import { AsyncBoundary, Badge, Card, Notice } from '../ui.jsx';
import { ScoreRing } from '../domain.jsx';
import { Icons } from '../Icons.jsx';
import { MarginChip } from './MarginGuardCard.jsx';
import RescueFormModal from './RescueFormModal.jsx';
import { dateTime, kg, label, money, routeLabel, FULFILMENT_TERMS, RESPONSIBILITY } from '../../utils/format.js';

export const FACTOR_LABELS = {
  demandFit: 'Demand fit', price: 'Price', margin: 'Margin', volume: 'Volume', fulfilment: 'Logistics', reliability: 'Reliability', urgency: 'Urgency',
};
const STATUS_TONE = { VIABLE: 'low', NO_DEMAND: 'outline', NOT_VIABLE: 'high', EXCLUDED: undefined, PAST_WINDOW: 'high' };
const STAGE_TONE = { PRIMARY: 'primary', ALTERNATIVE: 'info', RESCUE: 'medium' };

/** Stacked bar of the route plan for the remaining quantity. */
export function RoutePlan({ plan, total, unit }) {
  if (!plan?.length) return null;
  return (
    <div>
      <div className="plan-bar" role="img" aria-label={plan.map((p) => `${routeLabel(p.route)} ${p.quantity}${unit}`).join(', ')}>
        {plan.map((p) => <span key={p.route} className={`route-c-${p.route}`} style={{ width: `${(p.quantity / (total || 1)) * 100}%` }} />)}
      </div>
      <div className="legend">
        {plan.map((p, i) => (
          <span key={p.route}><i className={`route-c-${p.route}`} />{i + 1}. {routeLabel(p.route)} {kg(p.quantity, unit)}</span>
        ))}
      </div>
    </div>
  );
}

function RouteRow({ route: r, unit, recommended, canAct, busy, onSelect, onOutreach }) {
  const dialog = useDialog();
  const [open, setOpen] = useState(false);
  const muted = ['EXCLUDED', 'PAST_WINDOW'].includes(r.status);
  const isRescue = r.key === 'RESCUE';
  return (
    <div className={`route-row ${recommended ? 'recommended' : ''} ${muted ? 'muted-row' : ''}`}>
      <div className="route-head">
        <div className="row" style={{ gap: 12, flexWrap: 'nowrap' }}>
          <ScoreRing score={r.score} />
          <div>
            <div className="row" style={{ gap: 6 }}>
              <h3>{r.label}</h3>
              {recommended && <Badge tone="primary">Recommended</Badge>}
            </div>
            <div className="row mt-8" style={{ gap: 6 }}>
              <Badge tone={STATUS_TONE[r.status]}>{label(r.status)}</Badge>
              {r.buyers?.length > 0 && <span className="small muted">{r.buyers.join(', ')}</span>}
            </div>
          </div>
        </div>
        <div className="route-stat">
          <span className="small muted">{isRescue ? 'Could list' : 'Can cover'}</span>
          <b>{kg(r.coverableQuantity, unit)}</b>
          {!isRescue && r.requests > 0 && <span className="small muted">{r.requests} request(s)</span>}
        </div>
        <div className="route-stat">
          <span className="small muted">{r.live ? 'Avg price' : 'Est. price'}</span>
          <b>{money(r.averagePrice)}/{unit}</b>
        </div>
        <div className="route-stat">
          <span className="small muted">{FULFILMENT_TERMS[r.fulfilment.method]}</span>
          <b>{money(r.fulfilment.perKg)}/{unit}</b>
          <span className="small muted">{RESPONSIBILITY[r.fulfilment.responsibility]}</span>
        </div>
        <div className="route-stat">
          <span className="small muted">After fulfilment</span>
          <MarginChip margin={r.margin} prefix="Net" />
        </div>
        <div className="route-action row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{open ? 'Hide' : 'Why'}</button>
          {canAct && r.action === 'RUN_HARVESTMATCH' && (
            <button className={`btn btn-sm ${recommended ? 'btn-primary' : ''}`} disabled={busy} onClick={() => onSelect(r)}><Icons.Match />Select &amp; match</button>
          )}
          {canAct && r.action === 'MOVE_TO_RESCUE' && (
            <button className={`btn btn-sm ${recommended ? 'btn-primary' : ''}`} disabled={busy} onClick={() => onSelect(r)}><Icons.Rescue />Use Rescue</button>
          )}
          {canAct && r.action === 'OUTREACH' && (
            <button className="btn btn-sm" disabled={busy} onClick={() => onOutreach(r)}><Icons.Campaign />Draft outreach</button>
          )}
          {canAct && r.action === 'REVIEW_PRICE' && (
            <button className="btn btn-sm btn-ghost" disabled={busy}
              onClick={async () => (await dialog.confirm({
                title: `Select ${r.label} below your margin?`, tone: 'warning', icon: 'Analytics',
                message: `Margin Guard: ${r.margin.message}. You can still choose this route, but it may not cover your costs.`,
                confirmLabel: 'Select anyway', cancelLabel: 'Keep reviewing',
              })) && onSelect(r)}>Select anyway</button>
          )}
        </div>
      </div>
      {open && (
        <div className="route-details">
          <ul className="reason-list" style={{ marginTop: 0 }}>
            {r.reasons.map((x) => <li key={x}>{x}</li>)}
            {r.warnings.map((w) => <li key={w} className="warn">{w}</li>)}
          </ul>
          <div className="breakdown seven" title="Commercial Route Score — transparent weighted rules, not AI">
            {Object.entries(FACTOR_LABELS).filter(([k]) => r.breakdown[k]).map(([k, l]) => (
              <div key={k}><b>{r.breakdown[k].score}</b><small>{l} · {r.breakdown[k].weight}%</small></div>
            ))}
          </div>
          {r.excluded?.length > 0 && (
            <div className="small muted mt-12">
              <span className="strong">Not eligible in this route: </span>
              {r.excluded.map((e) => `${e.buyerName} (${e.reason})`).join(' · ')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * MarketRoute for one batch (proposal v3 §8.2): compare commercial routes, then select one.
 * Selecting a buyer route runs HarvestMatch within it; selecting Rescue opens a listing form.
 */
export default function MarketRouteCard({ batch, canAct, version, onSelected }) {
  const toast = useToast();
  const navigate = useNavigate();
  const state = useApi(() => api.get(`/harvests/${batch.id}/routes`), [batch.id, version]);
  const [busy, setBusy] = useState(false);
  const [rescueQty, setRescueQty] = useState(null);

  const select = async (r) => {
    setBusy(true);
    try {
      const res = await api.post(`/harvests/${batch.id}/routes/select`, { route: r.key });
      const stage = label(res.stage).toLowerCase();
      if (r.key === 'RESCUE') {
        toast(`Rescue recorded as the ${stage} route — create the listing`);
        setRescueQty(Math.min(r.coverableQuantity, batch.unallocatedQuantity));
      } else {
        const n = res.matching?.matches.filter((m) => m.status === 'SUGGESTED').length || 0;
        toast(`${r.label} selected as the ${stage} route — HarvestMatch found ${n} buyer${n === 1 ? '' : 's'}`);
        document.getElementById('harvestmatch')?.scrollIntoView({ behavior: 'smooth' });
      }
      await state.reload();
      onSelected?.(res);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const outreach = async (r) => {
    setBusy(true);
    try {
      const c = await api.post('/campaigns/generate', {
        farmId: batch.farmId,
        campaignType: r.key === 'COMMUNITY_D2C' ? 'HARVEST_ANNOUNCEMENT' : 'B2B_AVAILABILITY',
        harvestBatchId: batch.id,
        targetRoute: r.key,
      });
      toast(`Outreach to ${r.label} drafted — review before approving`);
      navigate(`/farm/campaigns?open=${c.id}`);
    } catch (err) {
      toast(err.message, 'error');
      setBusy(false);
    }
  };

  return (
    <Card
      title="MarketRoute — compare commercial routes"
      description="Which route gives the remaining quantity the strongest viable outcome? Rule-based Commercial Route Score; you choose the route."
    >
      <AsyncBoundary state={state} loadingLabel="Comparing routes…">
        {(a) => {
          if (!a.routes.length) return <Notice tone="success">{a.recommendation}</Notice>;
          const weights = Object.entries(FACTOR_LABELS).map(([k, l]) => `${l.toLowerCase()} ${a.weights[k]}`).join(' · ');
          return (
            <div className="stack" style={{ gap: 14 }}>
              <div className="row-between">
                <div>
                  <div className="strong">{a.recommendation}</div>
                  <div className="small muted">
                    {kg(a.remainingQuantity, a.unit)} unallocated · {a.sellWindowDays} sell day(s) left
                    {a.primaryRoute && <> · Primary route: <b>{routeLabel(a.primaryRoute)}</b></>}
                    {a.allowedRoutes && <> · Limited to {a.allowedRoutes.map(routeLabel).join(', ')}</>}
                  </div>
                </div>
              </div>
              {a.plan.length > 0 && (
                <div>
                  <div className="small muted strong" style={{ marginBottom: 6 }}>Suggested route plan for the remaining {kg(a.remainingQuantity, a.unit)}</div>
                  <RoutePlan plan={a.plan} total={a.remainingQuantity} unit={a.unit} />
                </div>
              )}
              <div className="route-list">
                {a.routes.map((r) => (
                  <RouteRow key={r.key} route={r} unit={a.unit} recommended={r.key === a.recommendedRoute} canAct={canAct} busy={busy} onSelect={select} onOutreach={outreach} />
                ))}
              </div>
              <div className="small muted">Weights: {weights}. Margin is after estimated fulfilment cost (Settings → Fulfilment costs).</div>
              {a.selections?.length > 0 && (
                <details>
                  <summary className="small strong" style={{ cursor: 'pointer' }}>Route decisions ({a.selections.length})</summary>
                  <div className="table-wrap mt-8">
                  <table className="table">
                    <tbody>
                      {a.selections.map((s) => (
                        <tr key={s.id}>
                          <td className="nowrap">{dateTime(s.createdAt)}</td>
                          <td><Badge tone={STAGE_TONE[s.stage]}>{label(s.stage)}</Badge></td>
                          <td className="strong">{routeLabel(s.route)}</td>
                          <td className="small muted">{s.recommendedRoute && s.recommendedRoute !== s.route ? `Recommended: ${routeLabel(s.recommendedRoute)}` : 'Recommended route'}</td>
                          <td className="small muted">{s.createdByName || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                </details>
              )}
            </div>
          );
        }}
      </AsyncBoundary>
      {rescueQty !== null && (
        <RescueFormModal
          batches={[batch]}
          defaultBatchId={batch.id}
          defaultQuantity={rescueQty}
          onClose={() => setRescueQty(null)}
          onCreated={() => {
            setRescueQty(null);
            toast('Rescue listing created');
            state.reload();
            onSelected?.();
          }}
        />
      )}
    </Card>
  );
}
