import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../services/api.js';
import { useApi } from '../../hooks/useApi.js';
import { useToast } from '../../context/ToastContext.jsx';
import { PageHeader, AsyncBoundary, EmptyState, Card, Modal, Notice, Badge } from '../../components/ui.jsx';
import { Icons } from '../../components/Icons.jsx';
import { kg, money, date, relativeDay, label } from '../../utils/format.js';

const OPEN_ORDERS = ['PENDING', 'CONFIRMED', 'READY'];
const hhmm = (t) => (t ? t.slice(0, 5) : '—');

function JoinModal({ drop, orders, onClose, onDone }) {
  const toast = useToast();
  const eligible = orders.filter((o) => OPEN_ORDERS.includes(o.status) && o.farmId === drop.farmId && !o.communityDropId);
  const [orderId, setOrderId] = useState(eligible[0]?.id ?? null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await api.post(`/community-drops/${drop.id}/join`, { orderId });
      toast(`Order #${orderId} added to ${drop.communityName}`);
      onDone();
      onClose();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Join ${drop.communityName}`} onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>Close</button>
        {eligible.length > 0 && <button className="btn btn-primary" onClick={submit} disabled={busy || !orderId}>{busy ? 'Joining…' : 'Join drop'}</button>}
      </>
    }>
      <div className="form">
        <div className="small muted">{drop.collectionPoint} · {date(drop.dropDate, { weekday: true })}, {hhmm(drop.windowStart)}–{hhmm(drop.windowEnd)}</div>
        {eligible.length === 0 ? (
          <Notice tone="warning">
            <div>
              You need an open order from {drop.farmName} to join this drop. Reserve Rescue produce from this farm first, then come back to join.
              <div className="mt-8"><Link className="btn btn-sm" to="/consumer/rescue">Browse Rescue produce</Link></div>
            </div>
          </Notice>
        ) : (
          <>
            <p className="small">Choose which order to collect at this drop. Its collection method will change to Community Drop.</p>
            {eligible.map((o) => (
              <label key={o.id} className="checkbox">
                <input type="radio" name="order" checked={orderId === o.id} onChange={() => setOrderId(o.id)} />
                <span>
                  <span className="strong">Order #{o.id}</span> · {o.items.map((i) => `${i.produceName} ${kg(i.quantity, i.unit)}`).join(', ')} · {money(o.totalAmount)}
                  <span className="muted"> ({label(o.status)})</span>
                </span>
              </label>
            ))}
          </>
        )}
      </div>
    </Modal>
  );
}

export default function CommunityDrops() {
  const state = useApi(
    () => Promise.all([api.get('/community-drops/upcoming'), api.get('/orders')]).then(([drops, orders]) => ({ drops, orders })),
    []
  );
  const [joining, setJoining] = useState(null);

  return (
    <>
      <PageHeader
        title="Community Drops"
        description="Neighbours collect their orders together from one scheduled point — fewer trips for the farm, a convenient pickup for you."
      />
      <AsyncBoundary state={state}>
        {({ drops, orders }) =>
          drops.length === 0 ? (
            <Card><EmptyState title="No Community Drops scheduled">Farms schedule drops as orders in an area build up.</EmptyState></Card>
          ) : (
            <div className="product-grid">
              {drops.map((d) => {
                const joined = orders.some((o) => o.communityDropId === d.id && o.status !== 'CANCELLED');
                return (
                  <div key={d.id} className="product-card">
                    <div className="row-between">
                      <h3>{d.communityName}</h3>
                      {d.region && <Badge tone="outline">{label(d.region)}</Badge>}
                    </div>
                    <div className="small row"><Icons.Pin width={14} /> {d.collectionPoint}</div>
                    <div className="small muted">{d.orderCount}/{d.minOrders} orders · {d.orderCount >= d.minOrders ? 'Pickup minimum reached' : 'Minimum not yet reached — consider another listed date or point'}</div>
                    <div className="small">
                      <span className="strong">{date(d.dropDate, { weekday: true })}</span> · {hhmm(d.windowStart)}–{hhmm(d.windowEnd)}
                      <span className="muted"> · {relativeDay(d.dropDate)}</span>
                    </div>
                    <div className="small muted">{d.farmName} · {d.orderCount} order{d.orderCount === 1 ? '' : 's'} · {kg(d.totalQuantity)} total</div>
                    {d.notes && <div className="small muted">{d.notes}</div>}
                    <div className="foot">
                      {joined && <Badge tone="low">You&apos;re in</Badge>}
                      <button className="btn btn-primary btn-sm" onClick={() => setJoining(d)}>Join with an order</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )
        }
      </AsyncBoundary>
      {joining && <JoinModal drop={joining} orders={state.data.orders} onClose={() => setJoining(null)} onDone={state.reload} />}
    </>
  );
}
