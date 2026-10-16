import { useState } from 'react';
import { api } from '../../services/api.js';
import { useApi } from '../../hooks/useApi.js';
import { useFarm } from '../../context/FarmContext.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useDialog } from '../../context/DialogContext.jsx';
import { AsyncBoundary, Badge, Card, EmptyState, Field, FilterChips, Modal, PageHeader, Tabs, fieldErrors } from '../../components/ui.jsx';
import { StatusBadge } from '../../components/domain.jsx';
import { Icons } from '../../components/Icons.jsx';
import { addDaysISO, date, kg, label, money, todayISO } from '../../utils/format.js';

const STATUS_FILTERS = [
  { value: 'OPEN,PARTIALLY_FULFILLED', label: 'Open' },
  { value: 'FULFILLED', label: 'Fulfilled' },
  { value: '', label: 'All' },
];
const BUYER_TYPES = ['RESTAURANT', 'CAFE', 'HOTEL', 'CATERER', 'RETAILER', 'WET_MARKET', 'WHOLESALER', 'COMMUNITY', 'CONSUMER'];
const REGIONS = ['CENTRAL', 'NORTH', 'NORTH_EAST', 'EAST', 'WEST'];

function RecordDemandModal({ farmId, buyers, onClose, onSaved }) {
  const toast = useToast();
  const produce = useApi(() => api.get('/produce', { farmId, active: true }), [farmId]);
  const [form, setForm] = useState({ buyerId: '', produceId: '', quantity: '', requiredDate: addDaysISO(todayISO(), 2), maxPrice: '', recurrence: 'NONE', notes: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const errs = fieldErrors(error);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/demand', {
        farmId, buyerId: Number(form.buyerId), produceId: Number(form.produceId), quantity: Number(form.quantity),
        requiredDate: form.requiredDate, maxPrice: form.maxPrice ? Number(form.maxPrice) : null, recurrence: form.recurrence, notes: form.notes || null,
      });
      toast('Demand recorded');
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Record buyer demand" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="demand-form" disabled={busy}>Save demand</button></>}>
      <form id="demand-form" className="form" onSubmit={submit}>
        {error && <div className="form-error">{error.message}</div>}
        <p className="small muted">For orders that arrive by phone or WhatsApp. Buyers can also submit demand themselves.</p>
        <div className="form-grid">
          <Field label="Buyer" full>
            <select className="input" value={form.buyerId} onChange={set('buyerId')} required>
              <option value="" disabled>Select buyer…</option>
              {buyers.filter((b) => b.isActive).map((b) => <option key={b.id} value={b.id}>{b.organisationName} ({label(b.buyerType)})</option>)}
            </select>
          </Field>
          <Field label="Produce">
            <select className="input" value={form.produceId} onChange={set('produceId')} required>
              <option value="" disabled>Select…</option>
              {produce.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Quantity (kg)" error={errs.quantity}><input className="input" type="number" min="0.1" step="0.1" value={form.quantity} onChange={set('quantity')} required /></Field>
          <Field label="Required date" error={errs.requiredDate}><input className="input" type="date" min={todayISO()} value={form.requiredDate} onChange={set('requiredDate')} required /></Field>
          <Field label="Max price ($/kg)" hint="Optional"><input className="input" type="number" min="0.01" step="0.01" value={form.maxPrice} onChange={set('maxPrice')} /></Field>
          <Field label="Recurring">
            <select className="input" value={form.recurrence} onChange={set('recurrence')}>
              {['NONE', 'WEEKLY', 'BIWEEKLY', 'MONTHLY'].map((r) => <option key={r} value={r}>{r === 'NONE' ? 'One-off' : label(r)}</option>)}
            </select>
          </Field>
          <Field label="Notes"><input className="input" value={form.notes} onChange={set('notes')} /></Field>
        </div>
      </form>
    </Modal>
  );
}

function AddBuyerModal({ farmId, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({ organisationName: '', buyerType: 'RESTAURANT', contactName: '', contactPhone: '', region: '', preferredCollectionMethod: 'FARM_PICKUP', whatsappOptIn: false });
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const submit = async (e) => {
    e.preventDefault();
    try {
      await api.post(`/farms/${farmId}/buyers`, { ...form, region: form.region || null, contactPhone: form.contactPhone || null, contactName: form.contactName || null });
      toast('Buyer added');
      onSaved();
    } catch (err) {
      setError(err);
    }
  };
  return (
    <Modal title="Add buyer" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="buyer-form">Add buyer</button></>}>
      <form id="buyer-form" className="form" onSubmit={submit}>
        {error && <div className="form-error">{error.message}</div>}
        <div className="form-grid">
          <Field label="Organisation / name" full><input className="input" value={form.organisationName} onChange={set('organisationName')} required /></Field>
          <Field label="Buyer type"><select className="input" value={form.buyerType} onChange={set('buyerType')}>{BUYER_TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</select></Field>
          <Field label="Region"><select className="input" value={form.region} onChange={set('region')}><option value="">Unknown</option>{REGIONS.map((r) => <option key={r} value={r}>{label(r)}</option>)}</select></Field>
          <Field label="Contact name"><input className="input" value={form.contactName} onChange={set('contactName')} /></Field>
          <Field label="Phone"><input className="input" value={form.contactPhone} onChange={set('contactPhone')} /></Field>
          <Field label="Preferred collection" full>
            <select className="input" value={form.preferredCollectionMethod} onChange={set('preferredCollectionMethod')}>
              {['FARM_PICKUP', 'CENTRAL_DROP', 'COMMUNITY_DROP', 'DELIVERY'].map((m) => <option key={m} value={m}>{label(m)}</option>)}
            </select>
          </Field>
        </div>
        <label className="checkbox"><input type="checkbox" checked={form.whatsappOptIn} onChange={set('whatsappOptIn')} />Buyer has agreed to receive WhatsApp updates</label>
      </form>
    </Modal>
  );
}

export default function Demand() {
  const dialog = useDialog();
  const { farmId } = useFarm();
  const { isFarmAdmin } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState('demand');
  const [status, setStatus] = useState(STATUS_FILTERS[0].value);
  const [modal, setModal] = useState(null);
  const demand = useApi(() => api.get('/demand', { farmId, status }), [farmId, status], { enabled: Boolean(farmId) });
  const buyers = useApi(() => api.get(`/farms/${farmId}/buyers`), [farmId], { enabled: Boolean(farmId) });

  const cancel = async (d) => {
    if (!(await dialog.confirm({
      title: `Cancel ${d.buyerName}’s ${d.produceName} demand?`, tone: 'danger', icon: 'Demand',
      message: 'It will no longer count towards demand coverage or be matched to your harvests.',
      confirmLabel: 'Cancel demand', cancelLabel: 'Keep demand',
    }))) return;
    try {
      await api.post(`/demand/${d.id}/cancel`);
      toast('Demand cancelled');
      demand.reload();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  return (
    <>
      <PageHeader
        title="Demand"
        description="Real buyer demand — requests directed to your farm plus open-market demand any farm can serve."
        actions={
          <>
            {isFarmAdmin && <button className="btn" onClick={() => setModal('buyer')}><Icons.Plus />Add buyer</button>}
            <button className="btn btn-primary" onClick={() => setModal('demand')} disabled={!buyers.data}><Icons.Plus />Record demand</button>
          </>
        }
      />
      <Tabs tabs={[{ value: 'demand', label: 'Demand requests' }, { value: 'buyers', label: 'Buyers', count: buyers.data?.length }]} value={tab} onChange={setTab} />

      {tab === 'demand' && (
        <Card tight title="Demand requests" actions={<FilterChips options={STATUS_FILTERS} value={status} onChange={setStatus} />}>
          <AsyncBoundary state={demand}>
            {(rows) =>
              rows.length === 0 ? <EmptyState title="No demand in this view" /> : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr><th>Buyer</th><th>Buyer type</th><th>Produce</th><th className="num">Quantity</th><th className="num">Remaining</th><th>Required</th><th className="num">Max price</th><th>Recurring</th><th>Status</th><th /></tr>
                    </thead>
                    <tbody>
                      {rows.map((d) => (
                        <tr key={d.id}>
                          <td className="cell-title">
                            {d.buyerName}
                            {d.farmId === null && <div className="cell-sub">Open-market demand</div>}
                            {d.allowPooling && <Badge tone="info">FarmPool · {d.supplyingFarms} farm{d.supplyingFarms === 1 ? '' : 's'}</Badge>}
                          </td>
                          <td>{label(d.buyerType)}</td>
                          <td>{d.produceName}</td>
                          <td className="num">{kg(d.quantity, d.unit)}{d.minQuantity && <div className="cell-sub">min {kg(d.minQuantity, d.unit)}</div>}</td>
                          <td className="num">{kg(d.remainingQuantity, d.unit)}</td>
                          <td className="nowrap">{date(d.requiredDate, { weekday: true })}</td>
                          <td className="num">{d.maxPrice ? money(d.maxPrice) : <span className="muted">Not set</span>}</td>
                          <td>{d.recurrence === 'NONE' ? <span className="muted">One-off</span> : <Badge tone="info">{label(d.recurrence)}</Badge>}</td>
                          <td><StatusBadge status={d.status} /></td>
                          <td>{d.farmId === farmId && ['OPEN', 'PARTIALLY_FULFILLED'].includes(d.status) && <button className="btn btn-sm btn-ghost" onClick={() => cancel(d)}>Cancel</button>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            }
          </AsyncBoundary>
        </Card>
      )}

      {tab === 'buyers' && (
        <Card tight title="Buyers" description="Buyers you manage, buyers with demand you can serve, and buyers who have ordered from you.">
          <AsyncBoundary state={buyers}>
            {(rows) =>
              rows.length === 0 ? <EmptyState title="No buyers yet" /> : (
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>Buyer</th><th>Type</th><th>Region</th><th>Collection</th><th>WhatsApp</th><th className="num">Orders</th><th className="num">Revenue</th></tr></thead>
                    <tbody>
                      {rows.map((b) => (
                        <tr key={b.id}>
                          <td className="cell-title">{b.organisationName}{b.managedByFarm && <div className="cell-sub">Managed by your farm</div>}</td>
                          <td>{label(b.buyerType)}</td>
                          <td>{label(b.region)}</td>
                          <td>{label(b.preferredCollectionMethod)}</td>
                          <td>{b.whatsappOptIn ? <Badge tone="low">Opted in</Badge> : <span className="muted">No</span>}</td>
                          <td className="num">{b.orderCount}</td>
                          <td className="num">{money(b.revenue)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            }
          </AsyncBoundary>
        </Card>
      )}

      {modal === 'demand' && <RecordDemandModal farmId={farmId} buyers={buyers.data || []} onClose={() => setModal(null)} onSaved={() => { setModal(null); demand.reload(); }} />}
      {modal === 'buyer' && <AddBuyerModal farmId={farmId} onClose={() => setModal(null)} onSaved={() => { setModal(null); buyers.reload(); }} />}
    </>
  );
}
