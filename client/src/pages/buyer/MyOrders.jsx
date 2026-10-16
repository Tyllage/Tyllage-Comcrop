import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../services/api.js';
import { useApi } from '../../hooks/useApi.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { PageHeader, Card, AsyncBoundary, EmptyState, FilterChips, Modal, Field, Badge, Notice } from '../../components/ui.jsx';
import { StatusBadge } from '../../components/domain.jsx';
import { kg, money, date, label } from '../../utils/format.js';

const GROUPS = {
  all: null,
  active: ['PENDING', 'CONFIRMED', 'READY'],
  completed: ['COMPLETED'],
  cancelled: ['CANCELLED'],
};
const CANCELLABLE = ['PENDING', 'CONFIRMED'];
const NO_DISPUTE = ['PENDING', 'CANCELLED'];
const DISPUTE_REASONS = [
  ['QUALITY', 'Quality not as expected'],
  ['QUANTITY', 'Wrong or short quantity'],
  ['LATE', 'Late delivery or collection'],
  ['NO_SHOW', 'Farm did not show'],
  ['PRICING', 'Pricing or charge issue'],
  ['OTHER', 'Something else'],
];
const DISPUTE_TONE = { OPEN: 'medium', RESOLVED: 'low', REJECTED: undefined };

function DisputeModal({ order, onClose, onDone }) {
  const toast = useToast();
  const [reason, setReason] = useState('QUALITY');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    if (description.trim().length < 5) return setError({ message: 'Describe the issue in at least 5 characters.' });
    setBusy(true);
    setError(null);
    try {
      await api.post(`/orders/${order.id}/disputes`, { reason, description: description.trim() });
      toast('Issue reported — the Tyllage team will review it with the farm');
      onDone();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`Report an issue · order #${order.id}`} onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" form="dispute-form" disabled={busy}>{busy ? 'Sending…' : 'Report issue'}</button>
      </>
    }>
      <form id="dispute-form" className="form" onSubmit={submit}>
        {error && <div className="form-error">{error.message}</div>}
        <p className="muted">{order.farmName} · {money(order.totalAmount)} · placed {date(order.createdAt)}</p>
        <Field label="What went wrong?">
          <select className="input" value={reason} onChange={(e) => setReason(e.target.value)}>
            {DISPUTE_REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
        <Field label="Details" hint="What happened, which items were affected and what outcome you expect">
          <textarea className="input" rows={4} minLength={5} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} required />
        </Field>
        <Notice>The farm is notified and a Tyllage platform admin reviews the issue and records a resolution.</Notice>
      </form>
    </Modal>
  );
}

function CancelModal({ order, onClose, onDone }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await api.patch(`/orders/${order.id}/status`, { status: 'CANCELLED', reason: reason.trim() || undefined });
      toast(`Order #${order.id} cancelled`);
      onDone();
      onClose();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`Cancel order #${order.id}`} onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>Keep order</button>
        <button className="btn btn-danger" onClick={submit} disabled={busy}>{busy ? 'Cancelling…' : 'Cancel order'}</button>
      </>
    }>
      <div className="form">
        <p className="muted">The farm will be notified and the reserved produce released for other buyers.</p>
        <Field label="Reason (optional)" hint="Helps the farm plan future harvests">
          <textarea className="input" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

export default function MyOrders() {
  const toast = useToast();
  const [reorder,setReorder] = useState(null);
  const [reordering,setReordering] = useState(false);
  const quoteOrder = async o => {try{setReorder({orderId:o.id,...await api.get(`/orders/${o.id}/reorder`)});}catch(e){toast(e.message,'error');}};
  const confirmReorder = async () => {setReordering(true);try{const o=await api.post(`/orders/${reorder.orderId}/reorder`,{expectedTotal:reorder.total});toast(`Order #${o.id} created for farm confirmation`);setReorder(null);state.reload();}catch(e){toast(e.message,'error');}finally{setReordering(false);}};
  const { user } = useAuth();
  const isConsumer = user?.role === 'consumer';
  const state = useApi(
    () => Promise.all([api.get('/orders'), api.get('/disputes').catch(() => [])]).then(([orders, disputes]) => ({ orders, disputes })),
    []
  );
  const [filter, setFilter] = useState('all');
  const [cancelling, setCancelling] = useState(null);
  const [disputing, setDisputing] = useState(null);

  return (
    <>
      <PageHeader
        title="My orders"
        description={isConsumer ? 'Rescue reservations and orders from local farms, with collection details.' : 'Orders created from approved HarvestMatch results, Demand Recovery offers and direct sales.'}
      />
      <AsyncBoundary state={state}>
        {({ orders, disputes }) => {
          // Disputes arrive newest first: keep the latest per order.
          const disputeFor = {};
          for (const d of disputes) if (!disputeFor[d.orderId]) disputeFor[d.orderId] = d;
          const count = (k) => (GROUPS[k] ? orders.filter((o) => GROUPS[k].includes(o.status)).length : orders.length);
          const rows = GROUPS[filter] ? orders.filter((o) => GROUPS[filter].includes(o.status)) : orders;
          return (
            <div className="stack">
              <FilterChips
                options={Object.keys(GROUPS).map((k) => ({ value: k, label: `${k.charAt(0).toUpperCase()}${k.slice(1)} (${count(k)})` }))}
                value={filter}
                onChange={setFilter}
              />
              <Card tight>
                {rows.length === 0 ? (
                  <EmptyState
                    title={orders.length ? 'No orders in this view' : 'No orders yet'}
                    action={!orders.length && <Link className="btn btn-sm" to={isConsumer ? '/consumer/rescue' : '/buyer/supply'}>{isConsumer ? 'Browse Rescue produce' : 'Browse supply'}</Link>}
                  >
                    {orders.length ? 'Try another filter.' : 'Your orders and their collection details will appear here.'}
                  </EmptyState>
                ) : (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Order</th>
                          <th>Items</th>
                          <th className="num">Total</th>
                          <th>Status</th>
                          <th>Collection</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((o) => {
                          const dispute = disputeFor[o.id];
                          return (
                            <tr key={o.id}>
                              <td>
                                <div className="cell-title">#{o.id} · {o.farmName}</div>
                                <div className="cell-sub">{label(o.source)} · placed {date(o.createdAt)}</div>
                                {o.paymentStatus && <div className="cell-sub">{o.paymentStatus==='DEMO_PAID'?'Paid':o.paymentStatus==='DEMO_REFUNDED'?'Refunded':'Reward · no payment'}</div>}
                              </td>
                              <td>
                                {o.items.map((i) => (
                                  <div key={i.id} className="small">
                                    <span className="strong">{i.produceName}</span> {kg(i.quantity, i.unit)} @ {money(i.unitPrice)}
                                  </div>
                                ))}
                              </td>
                              <td className="num strong">{money(o.totalAmount)}</td>
                              <td>
                                <StatusBadge status={o.status} />
                                {o.cancelledReason && <div className="cell-sub mt-8">{o.cancelledReason}</div>}
                                {dispute && (
                                  <div className="mt-8">
                                    <Badge tone={DISPUTE_TONE[dispute.status]}>Issue {dispute.status.toLowerCase()}</Badge>
                                    <div className="cell-sub">{label(dispute.reason)}{dispute.resolution ? ` — ${dispute.resolution}` : ''}</div>
                                  </div>
                                )}
                              </td>
                              <td>
                                <div>{label(o.collectionMethod)}</div>
                                <div className="cell-sub">{o.scheduledDate ? date(o.scheduledDate, { weekday: true }) : 'Date to be confirmed'}</div>
                                {o.communityName && <Badge tone="primary">{o.communityName}</Badge>}
                              </td>
                              <td className="num">
                                <div className="row" style={{ justifyContent: 'flex-end' }}>
                                  {o.status==='COMPLETED' && !o.shopListingId && o.source!=='RESCUE' && <button className="btn btn-sm" onClick={()=>quoteOrder(o)}>Buy again</button>}
                                  {o.shopListingId && <Link className="btn btn-sm" to={`/consumer/shop/${o.farmId}`}>Shop again</Link>}
                                  {!NO_DISPUTE.includes(o.status) && (
                                    <button className="btn btn-sm" disabled={dispute?.status === 'OPEN'} title={dispute?.status === 'OPEN' ? 'An issue is already open for this order' : undefined}
                                      onClick={() => setDisputing(o)}>
                                      Report an issue
                                    </button>
                                  )}
                                  {CANCELLABLE.includes(o.status) && (
                                    <button className="btn btn-danger btn-sm" onClick={() => setCancelling(o)}>Cancel</button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </div>
          );
        }}
      </AsyncBoundary>
      {cancelling && <CancelModal order={cancelling} onClose={() => setCancelling(null)} onDone={state.reload} />}
      {disputing && <DisputeModal order={disputing} onClose={() => setDisputing(null)} onDone={state.reload} />}
      {reorder && <Modal title="Review your reorder" onClose={()=>setReorder(null)}><div className="stack"><p>Current harvest and prices. The farm confirms the new order.</p>{reorder.items.map(i=><div key={i.harvestBatchId} className="stat-line"><span>{i.produceName} · {kg(i.quantity,i.unit)}</span><strong>{money(i.price)}/{i.unit}</strong></div>)}<p>{label(reorder.collectionMethod)} · Total {money(reorder.total)}</p><button className="btn btn-primary" disabled={reordering} onClick={confirmReorder}>Place reorder</button></div></Modal>}
    </>
  );
}
