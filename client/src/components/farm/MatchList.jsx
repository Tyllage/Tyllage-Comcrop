import { useState } from 'react';
import { api } from '../../services/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { Badge, EmptyState } from '../ui.jsx';
import { ScoreRing, StatusBadge } from '../domain.jsx';
import { Icons } from '../Icons.jsx';
import { kg, label, money, date, routeLabel, FULFILMENT_TERMS } from '../../utils/format.js';
import { MarginChip } from './MarginGuardCard.jsx';
import AiPanel from '../AiPanel.jsx';
import ApprovalReview from './ApprovalReview.jsx';

const FACTOR_LABELS = { produce: 'Produce', date: 'Date', price: 'Price', quantity: 'Quantity', reliability: 'Reliability', location: 'Location' };
const URGENCY_TONE = { LOW: 'ok', MEDIUM: 'warn', HIGH: 'bad', CRITICAL: 'bad' };

function MatchCard({ match, unit, canDecide, selected, onSelect, onDecided }) {
  const toast = useToast();
  const [qty, setQty] = useState(match.recommendedQuantity);
  const [busy, setBusy] = useState(false);
  const [ai, setAi] = useState(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [review, setReview] = useState(null);
  const pending = match.status === 'SUGGESTED';

  const explain = async () => {
    setAiBusy(true);
    try {
      setAi(await api.post(`/ai/matches/${match.id}/explain`));
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setAiBusy(false);
    }
  };

  const preview = async () => {
    setBusy(true);
    try {
      setReview(await api.post(`/matches/${match.id}/preview`, { quantity: Number(qty) }));
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const approve = async (marginOverrideReason) => {
    setBusy(true);
    try {
      const res = await api.post(`/matches/${match.id}/approve`, {
        quantity: review.quantity, quoteToken: review.quoteToken,
        ...(review.requiresMarginOverride ? { marginOverrideReason } : {}),
      });
      setReview(null);
      toast(`Approved ${kg(qty, unit)} for ${match.buyerName} — order #${res.orderId} created`);
      onDecided(res);
    } catch (err) {
      if (['APPROVAL_QUOTE_CHANGED', 'MARGIN_REVIEW_REQUIRED'].includes(err.code)) setReview(err.details);
      else setReview(null);
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const reject = async () => {
    const reason = window.prompt(`Reject ${match.buyerName}? Optional reason:`);
    if (reason === null) return;
    setBusy(true);
    try {
      const res = await api.post(`/matches/${match.id}/reject`, { reason });
      toast(`Rejected ${match.buyerName}`);
      onDecided(res);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`match-card ${match.status === 'APPROVED' ? 'approved' : ''} ${match.status === 'REJECTED' ? 'rejected' : ''}`}>
      <div className="match-top">
        <div className="row" style={{ alignItems: 'flex-start', gap: 12, flex: 1 }}>
          {pending && canDecide && (
            <input type="checkbox" checked={selected} onChange={(e) => onSelect(e.target.checked)} aria-label={`Select ${match.buyerName}`} style={{ marginTop: 4, accentColor: 'var(--primary)' }} />
          )}
          <div>
            <div className="row" style={{ gap: 8 }}>
              <h3 style={{ fontSize: 15 }}>{match.buyerName}</h3>
              <Badge>{label(match.buyerType)}</Badge>
              {match.marketRoute && <Badge tone="primary">{routeLabel(match.marketRoute)}</Badge>}
              {match.source === 'RECOVERY' && <Badge tone="info">Recovery</Badge>}
              {!pending && <StatusBadge status={match.status} />}
            </div>
            <div className="small muted mt-8">
              Requested {kg(match.demandQuantity, unit)} for {date(match.effectiveRequiredDate || match.requiredDate, { weekday: true })}
              {match.recurrence !== 'NONE' && ` · ${label(match.recurrence)}`} · {label(match.preferredCollectionMethod)}
            </div>
          </div>
        </div>
        <ScoreRing score={match.matchScore} />
      </div>

      <div className="row mt-12" style={{ gap: 20 }}>
        <div><div className="small muted">{match.status === 'APPROVED' ? 'Approved' : 'Recommended'}</div><div className="strong">{kg(match.approvedQuantity ?? match.recommendedQuantity, unit)}</div></div>
        <div><div className="small muted">Unit price</div><div className="strong">{money(match.unitPrice)}/{unit}</div></div>
        <div><div className="small muted">Estimated revenue</div><div className="strong">{money((match.approvedQuantity ?? qty) * match.unitPrice)}</div></div>
      </div>

      <ul className="reason-list">
        {match.reasons.map((r) => <li key={r}>{r}</li>)}
        {match.warnings.map((w) => <li key={w} className="warn">{w}</li>)}
      </ul>

      {/* Decision support (does not change the score): fulfilment terms, Margin Guard before/after fulfilment, urgency. */}
      {pending && Number(qty) !== Number(match.recommendedQuantity) && <p className="small muted">The estimates below use the recommended quantity. Review your allocation to recalculate costs and margin for {kg(qty, unit)}.</p>}
      <div className="chip-row">
        {match.fulfilment && (
          <span className="mini-chip" title="Estimated fulfilment cost for this order (farm-private)">
            {FULFILMENT_TERMS[match.fulfilment.method]} · {money(match.fulfilment.total)}
          </span>
        )}
        <MarginChip margin={match.margin} />
        {match.netMargin && match.fulfilment?.total > 0 && <MarginChip margin={match.netMargin} prefix="Net" />}
        {match.urgency && <span className={`mini-chip ${URGENCY_TONE[match.urgency]}`}>Urgency: {label(match.urgency)}</span>}
        {match.scoreBreakdown?.reliability && <span className="mini-chip" title="Rule-based order-history score; neutral when history is limited">Reliability score {match.scoreBreakdown.reliability.score}/100</span>}
        <button className="btn btn-ghost btn-sm" onClick={explain} disabled={aiBusy}><Icons.Sparkle />{aiBusy ? 'Explaining…' : 'Explain with AI'}</button>
      </div>
      {ai && <div className="mt-8"><AiPanel result={ai} title="Why this match?" onClose={() => setAi(null)} /></div>}

      {match.scoreBreakdown && (
        <div className="breakdown" title="Weighted factors — transparent rules, not AI">
          {Object.keys(FACTOR_LABELS).filter((k) => match.scoreBreakdown[k]).map((k) => [k, match.scoreBreakdown[k]]).map(([k, f]) => (
            <div key={k}>
              <b>{f.score}</b>
              <small>{FACTOR_LABELS[k]} · {f.weight}%</small>
            </div>
          ))}
        </div>
      )}

      {pending && canDecide && (
        <div className="match-actions">
          <label className="small muted" htmlFor={`qty-${match.id}`}>Quantity</label>
          <input id={`qty-${match.id}`} className="input input-sm" type="number" min="0.1" step="0.1" value={qty} onChange={(e) => setQty(e.target.value)} />
          <span className="small muted">{unit}</span>
          <div className="topbar-spacer" />
          <button className="btn btn-sm btn-danger" onClick={reject} disabled={busy}><Icons.X />Reject</button>
          <button className="btn btn-sm btn-primary" onClick={preview} disabled={busy || !(Number(qty) > 0)}><Icons.Check />Review & approve</button>
        </div>
      )}
      {match.status !== 'SUGGESTED' && match.decidedByName && (
        <div className="small muted mt-12">
          {label(match.status)} by {match.decidedByName}
          {match.orderId && ` · Order #${match.orderId}`}
          {match.decisionNote && ` · “${match.decisionNote}”`}
        </div>
      )}
      {review && <ApprovalReview key={review.quoteToken} review={review} busy={busy} onClose={() => setReview(null)} onApprove={approve} />}
    </div>
  );
}

/** HarvestMatch recommendations with approve/reject/bulk-approve and the excluded-demand explanation. */
export default function MatchList({ matches, excluded = [], unit = 'kg', canDecide, onChanged, showDecided = true }) {
  const toast = useToast();
  const [selected, setSelected] = useState({});
  const [bulkBusy, setBulkBusy] = useState(false);
  const pending = matches.filter((m) => m.status === 'SUGGESTED');
  const decided = matches.filter((m) => m.status !== 'SUGGESTED');
  const chosen = pending.filter((m) => selected[m.id]);

  const approveSelected = async () => {
    setBulkBusy(true);
    let ok = 0;
    for (const m of chosen) {
      try {
        await api.post(`/matches/${m.id}/approve`, {});
        ok += 1;
      } catch (err) {
        toast(`${m.buyerName}: ${err.code === 'MARGIN_REVIEW_REQUIRED' ? 'Use Review & approve to review the lower margin and record your reason.' : err.message}`, 'error');
      }
    }
    if (ok) toast(`Approved ${ok} match${ok > 1 ? 'es' : ''}`);
    setSelected({});
    setBulkBusy(false);
    onChanged();
  };

  return (
    <div className="stack">
      {pending.length === 0 && (
        <EmptyState title="No open recommendations">Run HarvestMatch to rank current demand against this batch.</EmptyState>
      )}
      {pending.length > 0 && canDecide && (
        <div className="row-between">
          <span className="small muted">{pending.length} recommendation{pending.length > 1 ? 's' : ''} · nothing is allocated until you approve</span>
          <button className="btn btn-primary btn-sm" disabled={!chosen.length || bulkBusy} onClick={approveSelected}>
            <Icons.Check />Approve selected ({chosen.length})
          </button>
        </div>
      )}
      {pending.map((m) => (
        <MatchCard key={m.id} match={m} unit={unit} canDecide={canDecide} selected={!!selected[m.id]}
          onSelect={(v) => setSelected((s) => ({ ...s, [m.id]: v }))} onDecided={onChanged} />
      ))}

      {excluded.length > 0 && (
        <details className="card" style={{ padding: '12px 16px' }}>
          <summary className="strong small" style={{ cursor: 'pointer' }}>Not recommended ({excluded.length}) — why</summary>
          <table className="table mt-8">
            <tbody>
              {excluded.map((e) => (
                <tr key={`${e.demandRequestId}-${e.reason}`}>
                  <td><div className="cell-title">{e.buyerName}</div><div className="cell-sub">{label(e.buyerType)} · {kg(e.quantity, unit)}</div></td>
                  <td className="small">{e.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      {showDecided && decided.length > 0 && (
        <>
          <h3 className="mt-8">Decisions</h3>
          {decided.map((m) => <MatchCard key={m.id} match={m} unit={unit} canDecide={false} onDecided={onChanged} />)}
        </>
      )}
    </div>
  );
}
