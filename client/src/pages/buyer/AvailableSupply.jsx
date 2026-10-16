import { useState } from 'react';
import { api } from '../../services/api.js';
import { useApi } from '../../hooks/useApi.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useDialog } from '../../context/DialogContext.jsx';
import { PageHeader, Card, AsyncBoundary, EmptyState, Tabs, Notice, Field } from '../../components/ui.jsx';
import { Icons } from '../../components/Icons.jsx';
import { kg, money, date, relativeDay, label } from '../../utils/format.js';
import { RequestSupplyModal, FarmLink, OrderPlacedToast, COLLECTION_METHODS, defaultOrderQty, orderQtyError } from './demandShared.jsx';

/** Bulk order cart: lines from a single farm, placed as one PENDING order (POST /orders). */
function CartPanel({ cart, setCart, onPlaced }) {
  const { user } = useAuth();
  const toast = useToast();
  const [collectionMethod, setCollectionMethod] = useState('FARM_PICKUP');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const total = cart.reduce((s, l) => s + l.quantity * l.item.price, 0);

  const place = async () => {
    setBusy(true);
    try {
      const order = await api.post('/orders', {
        items: cart.map((l) => ({ harvestBatchId: l.item.id, quantity: l.quantity })),
        collectionMethod,
        notes: notes.trim() || undefined,
      });
      toast(<OrderPlacedToast order={order} role={user?.role} />);
      setCart([]);
      setNotes('');
      onPlaced();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Bulk order"
      description={cart.length ? <>From <FarmLink id={cart[0].item.farmId} name={cart[0].item.farmName} /></> : 'Add produce from one farm to build an order.'}
      actions={cart.length > 0 && <button className="btn btn-ghost btn-sm" onClick={() => setCart([])} disabled={busy}>Clear</button>}
    >
      {cart.length === 0 ? (
        <EmptyState title="Your order is empty">Set a quantity and choose &quot;Add&quot; on any supply line. One order can contain produce from one farm.</EmptyState>
      ) : (
        <div className="stack">
          <div>
            {cart.map((l) => (
              <div key={l.item.id} className="stat-line">
                <div>
                  <div className="strong">{l.item.produceName}</div>
                  <div className="small muted">{kg(l.quantity, l.item.unit)} × {money(l.item.price)} · harvest {date(l.item.harvestDate)}</div>
                </div>
                <div className="row">
                  <b>{money(l.quantity * l.item.price)}</b>
                  <button className="btn btn-ghost btn-sm" aria-label={`Remove ${l.item.produceName}`} disabled={busy}
                    onClick={() => setCart((c) => c.filter((x) => x.item.id !== l.item.id))}>
                    <Icons.X width={14} />
                  </button>
                </div>
              </div>
            ))}
            <div className="stat-line">
              <span className="strong">Estimated total</span>
              <b>{money(total)}</b>
            </div>
          </div>
          <Field label="Collection method">
            <select className="input" value={collectionMethod} onChange={(e) => setCollectionMethod(e.target.value)}>
              {COLLECTION_METHODS.map((m) => <option key={m} value={m}>{label(m)}</option>)}
            </select>
          </Field>
          <Field label="Notes for the farm (optional)">
            <textarea className="input" rows={2} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          <button className="btn btn-primary btn-block" onClick={place} disabled={busy}>
            {busy ? 'Placing order…' : `Place order · ${money(total)}`}
          </button>
          <p className="small muted">The order is sent to the farm as pending and the produce is held for you until the farm confirms it.</p>
        </div>
      )}
    </Card>
  );
}

export default function AvailableSupply() {
  const toast = useToast();
  const dialog = useDialog();
  const state = useApi(() => api.get('/marketplace/supply'), []);
  const [tab, setTab] = useState('availableNow');
  const [requesting, setRequesting] = useState(null);
  const [qtys, setQtys] = useState({});
  const [cart, setCart] = useState([]);

  const qtyFor = (b) => qtys[b.id] ?? String(defaultOrderQty(b));

  const addToCart = async (b) => {
    const quantity = Number(qtyFor(b));
    const msg = orderQtyError(b, quantity);
    if (msg) return toast(msg, 'error');
    if (cart.length && cart[0].item.farmId !== b.farmId) {
      const replace = await dialog.confirm({
        title: `Start a new order from ${b.farmName}?`, tone: 'warning', icon: 'Farm',
        message: `Your order already has produce from ${cart[0].item.farmName}. One order can only come from one farm, so this clears your current order.`,
        confirmLabel: 'Clear and start new order', cancelLabel: `Keep ${cart[0].item.farmName} order`,
      });
      if (!replace) return toast(`Not added — place or clear your ${cart[0].item.farmName} order first.`, 'error');
      setCart([{ item: b, quantity }]);
    } else {
      setCart((c) => [...c.filter((l) => l.item.id !== b.id), { item: b, quantity }]);
    }
    toast(`${kg(quantity, b.unit)} ${b.produceName} added to your order`);
  };

  return (
    <>
      <PageHeader
        title="Available supply"
        description="Live harvest supply from Tyllage partner farms. Place a bulk order directly, or request supply and the farm reviews it through HarvestMatch."
      />
      <AsyncBoundary state={state}>
        {(data) => {
          const rows = data[tab];
          return (
            <div className="grid grid-main-side">
              <div>
                <Tabs
                  tabs={[
                    { value: 'availableNow', label: 'Available now', count: data.availableNow.length },
                    { value: 'growingSoon', label: 'Growing soon', count: data.growingSoon.length },
                  ]}
                  value={tab}
                  onChange={setTab}
                />
                <Card tight>
                  {rows.length === 0 ? (
                    <EmptyState title={tab === 'availableNow' ? 'Nothing available right now' : 'No upcoming harvests listed'}>
                      Check back soon — farms publish new harvests regularly.
                    </EmptyState>
                  ) : (
                    <div className="table-wrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>Produce</th>
                            <th>Farm</th>
                            <th>Harvest date</th>
                            <th className="num">Available</th>
                            <th className="num">Price / unit</th>
                            <th>Grade</th>
                            <th className="num">Order quantity</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((b) => {
                            const inCart = cart.find((l) => l.item.id === b.id);
                            return (
                              <tr key={b.id}>
                                <td>
                                  <div className="cell-title">{b.produceName}</div>
                                  {b.category && <div className="cell-sub">{label(b.category)}</div>}
                                </td>
                                <td><FarmLink id={b.farmId} name={b.farmName} /></td>
                                <td>
                                  <div>{date(b.harvestDate, { weekday: true })}</div>
                                  <div className="cell-sub">{relativeDay(b.harvestDate)}</div>
                                </td>
                                <td className="num">
                                  <div>{kg(b.availableQuantity, b.unit)}</div>
                                  {b.minOrderQuantity > 0 && <div className="cell-sub">Min order {kg(b.minOrderQuantity, b.unit)}</div>}
                                </td>
                                <td className="num">{money(b.price)}</td>
                                <td>{b.grade ? label(b.grade) : '—'}</td>
                                <td className="num">
                                  <div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                                    <input
                                      className="input input-sm"
                                      type="number"
                                      aria-label={`Quantity of ${b.produceName}`}
                                      min={b.minOrderQuantity || 0.5}
                                      max={b.availableQuantity}
                                      step="any"
                                      value={qtyFor(b)}
                                      onChange={(e) => setQtys((q) => ({ ...q, [b.id]: e.target.value }))}
                                    />
                                    <button className="btn btn-primary btn-sm" onClick={() => addToCart(b)}>
                                      {inCart ? 'Update' : <><Icons.Plus width={14} /> Add to order</>}
                                    </button>
                                  </div>
                                </td>
                                <td className="num">
                                  <button className="btn btn-sm" onClick={() => setRequesting(b)}>Request supply</button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Card>
                <div className="mt-16">
                  <Notice>
                    Bulk orders are placed at the farm&apos;s listed price and confirmed by the farm. Use &quot;Request supply&quot; for recurring or
                    negotiated volumes — the farm reviews requests through HarvestMatch and confirms quantity and price.
                  </Notice>
                </div>
              </div>
              <CartPanel cart={cart} setCart={setCart} onPlaced={state.reload} />
            </div>
          );
        }}
      </AsyncBoundary>
      {requesting && <RequestSupplyModal item={requesting} onClose={() => setRequesting(null)} onDone={state.reload} />}
    </>
  );
}
