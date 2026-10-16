import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useFarm } from '../../context/FarmContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { api } from '../../services/api.js';
import { useApi } from '../../hooks/useApi.js';
import { PageHeader, Card, AsyncBoundary, EmptyState, Field, Modal, Badge } from '../../components/ui.jsx';
import { SHOP_KINDS, pickupLabel } from '../consumer/Shop.jsx';
import { money, date } from '../../utils/format.js';

function Publish({ farmId, batches, drops, onClose, onDone }) {
  const [form,setForm] = useState({harvestBatchId:'',title:'',description:'',kind:'PREORDER',quantityPerPack:1,packPrice:5,originalValue:5,pointsCost:0,maxPacks:10,pickupDate:'',pickupStart:'10:00',pickupEnd:'12:00',communityDropId:'',packagingCost:0,marginOverrideReason:'',farmApproved:false});
  const [error,setError] = useState(''); const [busy,setBusy] = useState(false);
  const set = key => e => setForm(f=>({...f,[key]:e.target.type==='checkbox'?e.target.checked:e.target.value}));
  const dropChange = e => { const d=drops.find(d=>String(d.id)===e.target.value); setForm(f=>({...f,communityDropId:e.target.value,...(d?{pickupDate:d.dropDate,pickupStart:d.windowStart.slice(0,5),pickupEnd:d.windowEnd.slice(0,5)}:{})})); };
  const submit = async e => {e.preventDefault();setBusy(true);setError('');try {await api.post('/shop/listings',{...form,farmId,communityDropId:form.communityDropId?Number(form.communityDropId):null});onDone();onClose();}catch(err){setError(err.message);}finally{setBusy(false);}};
  return <Modal title="Publish a farm-approved offer" wide onClose={busy?undefined:onClose}><form className="form" onSubmit={submit}>
    <div className="form-grid">
      <Field label="Offer type"><select aria-label="Offer type" className="input" value={form.kind} onChange={e=>setForm(f=>({...f,kind:e.target.value,packPrice:e.target.value==='REWARD'?0:5,pointsCost:e.target.value==='REWARD'?100:0}))}>{Object.entries(SHOP_KINDS).map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></Field>
      <Field label="Harvest batch"><select aria-label="Harvest batch" className="input" value={form.harvestBatchId} onChange={set('harvestBatchId')} required><option value="">Choose a batch</option>{batches.filter(b=>b.status!=='CLOSED'&&b.unallocatedQuantity>0).map(b=><option key={b.id} value={b.id}>{b.produceName} · {b.harvestDate} · {b.unallocatedQuantity}{b.unit} free</option>)}</select></Field>
      <Field label="Offer title" full><input aria-label="Offer title" className="input" value={form.title} onChange={set('title')} maxLength={150} required /></Field>
      <Field label="Description / what may be in the bag" full><textarea aria-label="Description" className="input" value={form.description} onChange={set('description')} maxLength={1500} /></Field>
      {[['quantityPerPack','Quantity per pack (batch units)',0.01],['maxPacks','Maximum packs',1],['packPrice','Price per pack ($)',0.01],['originalValue','Original value ($)',0.01],['packagingCost','Packaging cost per pack ($)',0.01],...(form.kind==='REWARD'?[['pointsCost','Points per reward',1]]:[])].map(([k,l,step])=><Field key={k} label={l}><input aria-label={l} className="input" type="number" min={['quantityPerPack','maxPacks'].includes(k)?step:0} step={step} value={form[k]} onChange={set(k)} required readOnly={k==='packPrice'&&form.kind==='REWARD'} /></Field>)}
      <Field label="Pickup point" full><select aria-label="Pickup point" className="input" value={form.communityDropId} onChange={dropChange}><option value="">Farm pickup</option>{drops.filter(d=>d.status==='SCHEDULED').map(d=><option key={d.id} value={d.id}>{d.communityName} · {d.dropDate} · {d.orderCount}/{d.minOrders} orders</option>)}</select></Field>
      <Field label="Pickup day"><input aria-label="Pickup day" className="input" type="date" value={form.pickupDate} onChange={set('pickupDate')} required readOnly={!!form.communityDropId} /></Field>
      <Field label="Pickup opens"><input aria-label="Pickup opens" className="input" type="time" value={form.pickupStart} onChange={set('pickupStart')} required readOnly={!!form.communityDropId} /></Field>
      <Field label="Pickup closes"><input aria-label="Pickup closes" className="input" type="time" value={form.pickupEnd} onChange={set('pickupEnd')} required readOnly={!!form.communityDropId} /></Field>
      <Field label="Margin exception reason (if needed)" full hint="Required for rewards or prices below your farm’s margin floor. Includes packaging and pickup cost."><textarea aria-label="Margin exception reason" className="input" value={form.marginOverrideReason} onChange={set('marginOverrideReason')} maxLength={500}/></Field>
    </div>
    <p className="small muted">Offers draw from the selected harvest batch. A surprise bag uses one batch per listing in this pilot. Neighbourhood surprise bags require an existing delivery that has met its minimum.</p>
    <label className="row"><input type="checkbox" checked={form.farmApproved} onChange={set('farmApproved')} required /> I approve this produce for sale or reward, its price, contents and pickup arrangements.</label>
    {error&&<div className="form-error" role="alert">{error}</div>}<button className="btn btn-primary" disabled={busy}>{busy?'Publishing…':'Approve and publish'}</button>
  </form></Modal>;
}

export default function ShopManager() {
  const {farmId}=useFarm(); const toast=useToast(); const [open,setOpen]=useState(false);
  const state=useApi(()=>Promise.all([api.get('/shop/manage',{farmId}),api.get('/harvests',{farmId}),api.get('/community-drops',{farmId}),api.get('/shop/insights',{farmId})]).then(([listings,batches,drops,insights])=>({listings,batches,drops,insights})),[farmId]);
  const close=async id=>{try{await api.post(`/shop/listings/${id}/close`);state.reload();}catch(e){toast(e.message,'error');}};
  return <><PageHeader title="Tyllage Shop" description="Publish upcoming harvest, surplus bags and rewards in your farm’s own shop." actions={<><Link className="btn" to={`/shop/${farmId}`}>Preview shop</Link><button className="btn btn-primary" onClick={()=>setOpen(true)}>Publish an offer</button></>}/>
    <AsyncBoundary state={state}>{({listings,batches,drops,insights})=><div className="stack">
      <Card title="Shop offers" description="Confirmed pre-orders contribute to Demand Radar. Stock is reserved at checkout; publishing an offer does not reserve it.">
        {!listings.length?<EmptyState title="Create your first harvest offer">Choose a batch, pack size and pickup window.</EmptyState>:<div className="table-wrap"><table className="table"><thead><tr><th>Offer</th><th>Pickup</th><th>Price</th><th>Packs left</th><th>Status</th><th/></tr></thead><tbody>{listings.map(l=><tr key={l.id}><td><strong>{l.title}</strong><div className="cell-sub">{SHOP_KINDS[l.kind]}</div></td><td>{pickupLabel(l)}</td><td>{l.kind==='REWARD'?`${l.pointsCost} points`:money(l.packPrice)}</td><td>{l.availablePacks}</td><td><Badge tone={l.isActive?'low':undefined}>{l.isActive?'Published':'Closed'}</Badge></td><td>{l.isActive&&<button className="btn btn-sm" onClick={()=>close(l.id)}>Close listing</button>}</td></tr>)}</tbody></table></div>}
      </Card>
      <Card title="Pickup planning" description="Create neighbourhood pickup dates, set minimum orders and track collections in Orders."><div className="row" style={{ gap: 12 }}><Link className="btn" to="/farm/orders">Manage orders and pickup points</Link><Link className="btn" to="/farm/campaigns">Draft pickup outreach in Connect</Link></div></Card>
      <Card title="Shop performance" description="Collected orders only.">{!insights.length?<EmptyState title="No Shop orders yet"/>:<div className="table-wrap"><table className="table"><thead><tr><th>Area</th><th>Day</th><th>Crop</th><th>Collected</th><th>Revenue</th><th>Cancelled</th></tr></thead><tbody>{insights.map((r,i)=><tr key={i}><td>{r.pickupArea}</td><td>{date(r.pickupDate)}</td><td>{r.produceName}</td><td>{r.collectedOrders}</td><td>{money(r.revenue)}</td><td>{r.cancelledOrders}</td></tr>)}</tbody></table></div>}</Card>
      {open&&<Publish farmId={farmId} batches={batches} drops={drops} onClose={()=>setOpen(false)} onDone={state.reload}/>}
    </div>}</AsyncBoundary></>;
}
