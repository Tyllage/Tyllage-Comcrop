import { useState } from 'react';
import { api } from '../../services/api.js';
import { useApi } from '../../hooks/useApi.js';
import { useFarm } from '../../context/FarmContext.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useDialog } from '../../context/DialogContext.jsx';
import { AsyncBoundary, Card, EmptyState, Field, FilterChips, Modal, PageHeader, Tabs } from '../../components/ui.jsx';
import { StatusBadge } from '../../components/domain.jsx';
import { Icons } from '../../components/Icons.jsx';
import { addDaysISO, date, dateTime, kg, label, money, todayISO } from '../../utils/format.js';

const FILTERS = [
  { value: 'PENDING,CONFIRMED,READY', label: 'Active' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'CANCELLED', label: 'Cancelled' },
  { value: '', label: 'All' },
];
const NEXT = { PENDING: ['CONFIRMED', 'Confirm'], CONFIRMED: ['READY', 'Mark ready'], READY: ['COMPLETED', 'Complete'] };

function OrdersTable({ farmId }) {
  const dialog = useDialog();
  const { isFarmAdmin } = useAuth();
  const toast = useToast();
  const [status, setStatus] = useState(FILTERS[0].value);
  const [reporting, setReporting] = useState(null);
  const state = useApi(() => api.get('/orders', { farmId, status }), [farmId, status], { enabled: Boolean(farmId) });

  const update = async (order, next) => {
    let reason;
    if (next === 'CANCELLED') {
      reason = await dialog.prompt({
        title: `Cancel order #${order.id} for ${order.buyerName}?`, tone: 'danger', icon: 'Orders',
        message: 'The stock returns to the harvest batch so Demand Recovery can offer it to other buyers.',
        inputLabel: 'Reason for the buyer', placeholder: 'e.g. Harvest came in short this week', required: true,
        confirmLabel: 'Cancel order', cancelLabel: 'Keep order',
      });
      if (!reason) return;
    }
    try {
      await api.patch(`/orders/${order.id}/status`, { status: next, reason });
      toast(next === 'CANCELLED' ? `Order #${order.id} cancelled — stock released for Demand Recovery` : `Order #${order.id} ${label(next).toLowerCase()}`);
      state.reload();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  return (
    <Card tight title="Orders" actions={<FilterChips options={FILTERS} value={status} onChange={setStatus} />}>
      <AsyncBoundary state={state}>
        {(rows) =>
          rows.length === 0 ? <EmptyState title="No orders in this view" /> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Order</th><th>Buyer</th><th>Items</th><th className="num">Total</th><th>Source</th><th>Collection</th><th>Scheduled</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {rows.map((o) => (
                    <tr key={o.id}>
                      <td className="cell-title">#{o.id}<div className="cell-sub">{dateTime(o.createdAt)}</div></td>
                      <td>{o.buyerName}<div className="cell-sub">{label(o.buyerType)}</div></td>
                      <td>{o.items.map((i) => <div key={i.id} className="nowrap">{kg(i.quantity, i.unit)} {i.produceName} <span className="muted">@ {money(i.unitPrice)}</span></div>)}</td>
                      <td className="num strong">{money(o.totalAmount)}</td>
                      <td>{label(o.source)}</td>
                      <td>{label(o.collectionMethod)}{o.communityName && <div className="cell-sub">{o.communityName}</div>}</td>
                      <td className="nowrap">{date(o.scheduledDate)}</td>
                      <td><StatusBadge status={o.status} />{o.cancelledReason && <div className="cell-sub">{o.cancelledReason}</div>}</td>
                      <td className="nowrap">
                        {NEXT[o.status] && <button className="btn btn-sm" onClick={() => update(o, NEXT[o.status][0])}>{NEXT[o.status][1]}</button>}{' '}
                        {isFarmAdmin && NEXT[o.status] && <button className="btn btn-sm btn-ghost" onClick={() => update(o, 'CANCELLED')}>Cancel</button>}{' '}
                        {o.status !== 'PENDING' && <button className="btn btn-sm btn-ghost" onClick={() => setReporting(o)}>Report issue</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </AsyncBoundary>
      {reporting && <DisputeModal order={reporting} onClose={() => setReporting(null)} />}
    </Card>
  );
}

const DISPUTE_REASONS = ['QUALITY', 'QUANTITY', 'LATE', 'NO_SHOW', 'PRICING', 'OTHER'];

function DisputeModal({ order, onClose }) {
  const toast = useToast();
  const [form, setForm] = useState({ reason: 'NO_SHOW', description: '' });
  const submit = async (e) => {
    e.preventDefault();
    try {
      await api.post(`/orders/${order.id}/disputes`, form);
      toast('Issue reported — a Tyllage platform admin will review it');
      onClose();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  return (
    <Modal title={`Report an issue on order #${order.id}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="dispute-form">Submit</button></>}>
      <form id="dispute-form" className="form" onSubmit={submit}>
        <Field label="Reason">
          <select className="input" value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}>
            {DISPUTE_REASONS.map((r) => <option key={r} value={r}>{label(r)}</option>)}
          </select>
        </Field>
        <Field label="What happened?"><textarea className="input" rows={3} minLength={5} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} required /></Field>
      </form>
    </Modal>
  );
}

function Disputes() {
  const state = useApi(() => api.get('/disputes'), []);
  return (
    <Card tight title="Disputes" description="Issues raised by buyers or your farm. Platform admins resolve them.">
      <AsyncBoundary state={state}>
        {(rows) => rows.length === 0 ? <EmptyState title="No disputes" /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Raised</th><th>Order</th><th>Buyer</th><th>By</th><th>Reason</th><th>Details</th><th>Status</th><th>Resolution</th></tr></thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.id}>
                    <td className="nowrap">{dateTime(d.createdAt)}</td>
                    <td>#{d.orderId}</td>
                    <td>{d.buyerName}</td>
                    <td>{label(d.raisedByParty)}</td>
                    <td>{label(d.reason)}</td>
                    <td className="small" style={{ maxWidth: 280 }}>{d.description}</td>
                    <td><StatusBadge status={d.status} /></td>
                    <td className="small">{d.resolution || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AsyncBoundary>
    </Card>
  );
}

function DropModal({ farmId, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({ communityName: '', collectionPoint: '', region: '', dropDate: addDaysISO(todayISO(), 5), windowStart: '10:00', windowEnd: '11:30', notes: '', minOrders: 1 });
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const submit = async (e) => {
    e.preventDefault();
    try {
      await api.post('/community-drops', { ...form, farmId, region: form.region || null, notes: form.notes || null });
      toast('Community Drop scheduled');
      onSaved();
    } catch (err) {
      setError(err);
    }
  };
  return (
    <Modal title="Schedule a Community Drop" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="drop-form">Schedule</button></>}>
      <form id="drop-form" className="form" onSubmit={submit}>
        {error && <div className="form-error">{error.message}</div>}
        <div className="form-grid">
          <Field label="Community" full><input className="input" value={form.communityName} onChange={set('communityName')} placeholder="e.g. Tampines Neighbours" required /></Field>
          <Field label="Collection point" full><input className="input" value={form.collectionPoint} onChange={set('collectionPoint')} required /></Field>
          <Field label="Region"><select className="input" value={form.region} onChange={set('region')}><option value="">—</option>{['CENTRAL', 'NORTH', 'NORTH_EAST', 'EAST', 'WEST'].map((r) => <option key={r} value={r}>{label(r)}</option>)}</select></Field>
          <Field label="Date"><input className="input" type="date" min={todayISO()} value={form.dropDate} onChange={set('dropDate')} required /></Field>
          <Field label="Window start"><input className="input" type="time" value={form.windowStart} onChange={set('windowStart')} required /></Field>
          <Field label="Window end"><input className="input" type="time" value={form.windowEnd} onChange={set('windowEnd')} required /></Field>
          <Field label="Minimum orders to run"><input aria-label="Minimum orders to run" className="input" type="number" min="1" max="1000" value={form.minOrders} onChange={set('minOrders')} required /></Field>
        </div>
      </form>
    </Modal>
  );
}

function CommunityDrops({ farmId }) {
  const dialog = useDialog();
  const { isFarmAdmin } = useAuth();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const state = useApi(() => api.get('/community-drops', { farmId }), [farmId], { enabled: Boolean(farmId) });
  const setStatus = async (d, status) => {
    try {
      await api.patch(`/community-drops/${d.id}/status`, { status });
      toast(`Drop ${label(status).toLowerCase()}`);
      state.reload();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  return (
    <Card tight title="Community Drops" description="One collection point and time window for many consumer orders. No route optimisation in this version."
      actions={isFarmAdmin && <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}><Icons.Plus />Schedule drop</button>}>
      <AsyncBoundary state={state}>
        {(rows) =>
          rows.length === 0 ? <EmptyState title="No Community Drops yet" /> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Community</th><th>Collection point</th><th>Date</th><th>Window</th><th className="num">Orders</th><th className="num">Total produce</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {rows.map((d) => (
                    <tr key={d.id}>
                      <td className="cell-title">{d.communityName}<div className="cell-sub">{d.orderCount}/{d.minOrders} orders to run</div></td>
                      <td>{d.collectionPoint}{d.region && <div className="cell-sub">{label(d.region)}</div>}</td>
                      <td className="nowrap">{date(d.dropDate, { weekday: true })}</td>
                      <td className="nowrap">{d.windowStart.slice(0, 5)}–{d.windowEnd.slice(0, 5)}</td>
                      <td className="num">{d.orderCount}</td>
                      <td className="num">{kg(d.totalQuantity)}</td>
                      <td><StatusBadge status={d.status} /></td>
                      <td className="nowrap">
                        {isFarmAdmin && d.status === 'SCHEDULED' && (
                          <>
                            <button className="btn btn-sm" onClick={() => setStatus(d, 'COMPLETED')}>Complete</button>{' '}
                            <button className="btn btn-sm btn-ghost" onClick={async () => (await dialog.confirm({
                              title: `Cancel the ${d.communityName} pickup?`, tone: 'danger', icon: 'Pin',
                              message: 'Customers will need another pickup date or farm pickup for their orders.',
                              confirmLabel: 'Cancel pickup', cancelLabel: 'Keep pickup',
                            })) && setStatus(d, 'CANCELLED')}>Cancel</button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </AsyncBoundary>
      {creating && <DropModal farmId={farmId} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); state.reload(); }} />}
    </Card>
  );
}

export default function Orders() {
  const { farmId } = useFarm();
  const [tab, setTab] = useState('orders');
  return (
    <>
      <PageHeader title="Orders" description="Orders come from approved matches, recovery and Rescue reservations. Cancelling releases stock back to the batch." />
      <Tabs tabs={[{ value: 'orders', label: 'Orders' }, { value: 'drops', label: 'Community Drops' }, { value: 'disputes', label: 'Disputes' }]} value={tab} onChange={setTab} />
      {tab === 'orders' && <OrdersTable farmId={farmId} />}
      {tab === 'drops' && <CommunityDrops farmId={farmId} />}
      {tab === 'disputes' && <Disputes />}
    </>
  );
}
