import { useState } from 'react';
import { api } from '../../services/api.js';
import { useApi } from '../../hooks/useApi.js';
import { useToast } from '../../context/ToastContext.jsx';
import { PageHeader, Card, AsyncBoundary, EmptyState, FilterChips, Badge, Modal, Field } from '../../components/ui.jsx';
import { StatusBadge } from '../../components/domain.jsx';
import { money, dateTime, label } from '../../utils/format.js';

const STATUS_FILTERS = [
  { value: 'OPEN', label: 'Open' },
  { value: 'RESOLVED', label: 'Resolved' },
  { value: 'REJECTED', label: 'Rejected' },
];
const DISPUTE_TONE = { OPEN: 'medium', RESOLVED: 'low', REJECTED: undefined };

function ResolveModal({ dispute, onClose, onDone }) {
  const toast = useToast();
  const [status, setStatus] = useState('RESOLVED');
  const [resolution, setResolution] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (resolution.trim().length < 3) return setError({ message: 'Explain the decision in at least 3 characters.' });
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/disputes/${dispute.id}`, { status, resolution: resolution.trim() });
      toast(`Dispute on order #${dispute.orderId} ${status.toLowerCase()} — buyer and farm notified`);
      onDone();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Resolve dispute · order #${dispute.orderId}`} onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" form="resolve-form" disabled={busy}>{busy ? 'Saving…' : 'Record decision'}</button>
      </>
    }>
      <form id="resolve-form" className="form" onSubmit={submit}>
        {error && <div className="form-error">{error.message}</div>}
        <div>
          <div className="strong">{label(dispute.reason)} · raised by {dispute.raisedByParty === 'BUYER' ? dispute.buyerName : dispute.farmName}</div>
          <p className="small muted mt-8">{dispute.description}</p>
        </div>
        <Field label="Decision">
          <div className="filters">
            {[['RESOLVED', 'Resolve (issue upheld)'], ['REJECTED', 'Reject']].map(([v, l]) => (
              <button type="button" key={v} className={`chip ${status === v ? 'active' : ''}`} onClick={() => setStatus(v)}>{l}</button>
            ))}
          </div>
        </Field>
        <Field label="Resolution" hint="Shared with the buyer and the farm">
          <textarea className="input" rows={4} minLength={3} maxLength={2000} value={resolution} onChange={(e) => setResolution(e.target.value)} required />
        </Field>
      </form>
    </Modal>
  );
}

export default function Disputes() {
  const [status, setStatus] = useState('OPEN');
  const state = useApi(() => api.get('/disputes', { status }), [status]);
  const [resolving, setResolving] = useState(null);

  return (
    <>
      <PageHeader
        title="Disputes"
        description="Issues raised on orders by buyers or farms. Review each case and record a decision; both parties are notified."
      />
      <div className="stack">
        <FilterChips options={STATUS_FILTERS} value={status} onChange={setStatus} />
        <AsyncBoundary state={state}>
          {(rows) => (
            <Card tight>
              {rows.length === 0 ? (
                <EmptyState title={status === 'OPEN' ? 'No open disputes' : `No ${status.toLowerCase()} disputes`}>
                  {status === 'OPEN' ? 'Issues raised on orders will appear here for review.' : 'Closed disputes will appear here.'}
                </EmptyState>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Raised</th>
                        <th>Order</th>
                        <th>Order status</th>
                        <th>Farm</th>
                        <th>Buyer</th>
                        <th>Raised by</th>
                        <th>Issue</th>
                        <th>Issue status</th>
                        <th>Resolution</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((d) => (
                        <tr key={d.id}>
                          <td className="nowrap">{dateTime(d.createdAt)}</td>
                          <td>
                            <div className="cell-title">#{d.orderId}</div>
                            <div className="cell-sub">{money(d.totalAmount)}</div>
                          </td>
                          <td>{d.orderStatus ? <StatusBadge status={d.orderStatus} /> : <span className="muted">—</span>}</td>
                          <td>{d.farmName}</td>
                          <td>{d.buyerName}</td>
                          <td>
                            <div>{label(d.raisedByParty)}</div>
                            {d.raisedByName && <div className="cell-sub">{d.raisedByName}</div>}
                          </td>
                          <td style={{ maxWidth: 280 }}>
                            <div className="strong">{label(d.reason)}</div>
                            <div className="cell-sub">{d.description}</div>
                          </td>
                          <td><Badge tone={DISPUTE_TONE[d.status]}>{label(d.status)}</Badge></td>
                          <td style={{ maxWidth: 240 }}>
                            {d.resolution ? (
                              <>
                                <div className="small">{d.resolution}</div>
                                <div className="cell-sub">{d.resolvedByName ? `${d.resolvedByName} · ` : ''}{dateTime(d.resolvedAt)}</div>
                              </>
                            ) : <span className="muted">—</span>}
                          </td>
                          <td className="num">
                            {d.status === 'OPEN' && <button className="btn btn-primary btn-sm" onClick={() => setResolving(d)}>Resolve</button>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          )}
        </AsyncBoundary>
      </div>
      {resolving && <ResolveModal dispute={resolving} onClose={() => setResolving(null)} onDone={state.reload} />}
    </>
  );
}
