import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../services/api.js';
import { useApi } from '../../hooks/useApi.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { PageHeader, Card, AsyncBoundary, EmptyState, Badge, Field, Modal, Tabs } from '../../components/ui.jsx';
import { date, money, kg } from '../../utils/format.js';

export const SHOP_KINDS = { PREORDER: 'Harvest pre-order', SURPRISE_BAG: 'Surprise bag', REWARD: 'Harvest reward' };
export const pickupLabel = l => `${l.collectionPoint || 'Farm pickup'} · ${date(l.pickupDate)} · ${l.pickupStart.slice(0,5)}–${l.pickupEnd.slice(0,5)}`;

function Checkout({ listing, balance, onClose, onDone }) {
  const [packs, setPacks] = useState(1);
  const [points, setPoints] = useState(0);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [accepted,setAccepted] = useState(false);
  const toast = useToast();
  const reward = listing.kind === 'REWARD';
  const total = Math.max(0, Number(packs) * listing.packPrice - Number(points)/100);
  const submit = async e => {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const order = await api.post(`/shop/listings/${listing.id}/checkout`, { packs:Number(packs), redeemPoints:Number(points), acceptDemoPayment:accepted });
      toast(`Order #${order.id} confirmed`); onDone(); onClose();
    } catch(err) { setError(err.message); } finally { setBusy(false); }
  };
  return <Modal title={listing.title} onClose={busy ? undefined : onClose}>
    <form className="form" onSubmit={submit}>
      <p>{pickupLabel(listing)}</p>
      {listing.communityDropId && listing.pickupOrders < listing.minOrders && <div className="notice">This pickup needs {listing.minOrders} orders to run. If it stays below minimum, cancel before preparation and choose another scheduled offer or farm pickup.</div>}
      <Field label="Number of packs"><input aria-label="Number of packs" className="input" type="number" min="1" max={Math.min(100,listing.availablePacks)} step="1" required value={packs} onChange={e=>setPacks(e.target.value)} /></Field>
      <p className="small muted">{kg(listing.quantityPerPack,listing.unit)} per pack · {balance} points available</p>
      {!reward && <Field label="Redeem points" hint="100 points = $1 off. Discounts must meet the farm’s minimum margin."><input aria-label="Redeem points" className="input" type="number" min="0" max={Math.min(balance,Math.floor(packs*listing.packPrice)*100)} step="100" value={points} onChange={e=>setPoints(e.target.value)} /></Field>}
      <div className="stat-line"><strong>Total</strong><strong>{reward ? `${listing.pointsCost*packs} points` : money(total)}</strong></div>
      <p className="small muted">Earn 1 point per whole dollar after collection. Points are specific to this farm. A standard discount is always available on eligible purchases.</p>
      {listing.kind === 'SURPRISE_BAG' && <p className="small">Contents vary within the farm’s description. Uncollected bags are not refunded after the pickup window. Contact the farm for any collection issue.</p>}
      <label className="row"><input type="checkbox" required checked={accepted} onChange={e=>setAccepted(e.target.checked)} /> I agree to the farm’s pickup and refund terms.</label>
      {error && <div className="form-error" role="alert">{error}</div>}
      <button className="btn btn-primary" disabled={busy || !accepted}>{busy ? 'Confirming…' : 'Place order'}</button>
    </form>
  </Modal>;
}

function FarmShop({ farmId }) {
  const { user } = useAuth();
  const [kind,setKind] = useState('ALL');
  const [buying,setBuying] = useState(null);
  const state = useApi(()=>Promise.all([api.get(`/marketplace/farms/${farmId}`),api.get(`/shop/farms/${farmId}`),
    user?.role === 'consumer' ? api.get(`/shop/rewards/${farmId}`) : Promise.resolve({points:0,ledger:[]})]).then(([farm,listings,rewards])=>({farm,listings,rewards})),[farmId,user?.id]);
  return <AsyncBoundary state={state}>{({farm,listings,rewards})=><>
    <div className="shop-hero"><div><div className="eyebrow">DIRECT FROM THE FARM · POWERED BY TYLLAGE</div><h1>{farm.name} Shop</h1><p>{farm.description || 'Harvested close to home. Picked for your next meal.'}</p><div className="chip-row"><Badge tone="low">Fresh harvest</Badge><Badge tone="low">Neighbourhood pickup</Badge><Badge tone="low">Harvest rewards</Badge></div></div><div className="shop-rewards"><span>Your harvest rewards</span><strong>{rewards.points}</strong><span>points · 100 points = $1</span></div></div>
    <div className="row mt-16"><Link className="btn btn-sm" to="/consumer/shop">All farm shops</Link>{user?.role==='consumer' && <Link className="btn btn-sm" to="/consumer/orders">My orders</Link>}</div>
    <p className="muted mt-16">Pre-order the next harvest, discover surplus bags or redeem a farm-approved reward. Choose an offer with your preferred pickup point and day.</p>
    <Tabs value={kind} onChange={setKind} tabs={[{value:'ALL',label:'All offers'},...Object.entries(SHOP_KINDS).map(([value,label])=>({value,label}))]} />
    <div className="shop-grid">{listings.filter(l=>kind==='ALL'||l.kind===kind).map(l=><Card key={l.id} className="shop-product">
      <div className={`shop-product-art shop-art-${l.kind.toLowerCase()}`} aria-hidden="true">{l.kind==='SURPRISE_BAG'?'✦':l.kind==='REWARD'?'✿':'❋'}</div>
      <Badge tone="primary">{SHOP_KINDS[l.kind]}</Badge><h2 className="mt-16">{l.title}</h2><p className="muted mt-8">{l.description || l.produceName}</p>
      <div className="small muted mt-16">Harvest {date(l.harvestDate)} · {kg(l.quantityPerPack,l.unit)} per pack</div>
      <p className="small mt-8">{pickupLabel(l)}</p>
      {l.communityDropId && <p className="small mt-8">{l.pickupOrders}/{l.minOrders} orders · {l.pickupOrders >= l.minOrders ? 'Pickup minimum reached' : 'Waiting for the neighbourhood minimum'}</p>}
      <div className="stat-line mt-16"><strong>{l.kind==='REWARD'?`${l.pointsCost} points`:money(l.packPrice)}</strong>{l.originalValue>l.packPrice && <span className="muted">Value {money(l.originalValue)}</span>}</div>
      <div className="small muted">{l.availablePacks} packs available</div>
      {user?.role==='consumer' ? <button className="btn btn-primary btn-block mt-16" disabled={l.availablePacks<1 || (l.kind==='SURPRISE_BAG' && l.pickupOrders<l.minOrders && !!l.communityDropId)} onClick={()=>setBuying(l)}>{l.kind==='REWARD'?'Redeem reward':'Choose this pickup'}</button> : <Link className="btn btn-primary btn-block mt-16" to="/login">Sign in to order</Link>}
    </Card>)}</div>
    {!listings.some(l=>kind==='ALL'||l.kind===kind) && <EmptyState title="New harvest offers are on their way">The farm will publish approved offers here. Try another category or farm.</EmptyState>}
    {rewards.ledger.length>0 && <Card title="Points activity" className="mt-24">{rewards.ledger.slice(0,10).map((r,i)=><div className="stat-line" key={i}><span>Order #{r.orderId} · {r.kind.toLowerCase()}</span><strong>{r.points>0?'+':''}{r.points} points</strong></div>)}</Card>}
    {buying && <Checkout listing={buying} balance={rewards.points} onClose={()=>setBuying(null)} onDone={state.reload} />}
  </>}</AsyncBoundary>;
}

export default function Shop() {
  const { farmId } = useParams();
  const farms = useApi(()=>api.get('/marketplace/farms'),[]);
  if (farmId) return <FarmShop key={farmId} farmId={farmId} />;
  return <><PageHeader title="Tyllage Shop" description="Buy the next harvest directly from local farms. Pre-order, collect nearby and earn harvest rewards." /><AsyncBoundary state={farms}>{items=><div className="shop-grid">{items.map(f=><Card key={f.id} className="shop-farm-card" title={f.name} description={f.region}><p>{f.description}</p><Link className="btn btn-primary" to={`/consumer/shop/${f.id}`}>Visit farm shop</Link></Card>)}{!items.length && <EmptyState title="No farm shops yet" />}</div>}</AsyncBoundary></>;
}
