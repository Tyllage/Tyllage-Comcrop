import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useFarm } from '../../context/FarmContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useApi } from '../../hooks/useApi.js';
import { api } from '../../services/api.js';
import { PageHeader, Card, AsyncBoundary, Field, Badge, EmptyState, Modal } from '../../components/ui.jsx';
import { date, money, label } from '../../utils/format.js';

function Relationship({ buyer, farmId, onClose, onDone }) {
  const [notes,setNotes]=useState(buyer.notes);const [follow,setFollow]=useState(buyer.nextFollowUp||'');const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const save=async e=>{e.preventDefault();setBusy(true);try{await api.patch(`/farms/${farmId}/buyer-growth/${buyer.id}`,{notes,nextFollowUp:follow||null});onDone();onClose();}catch(e){setError(e.message);}finally{setBusy(false);}};
  return <Modal title={buyer.organisationName} onClose={onClose}><div className="stack"><p>{buyer.contactName} · {buyer.contactEmail || 'No email recorded'} · {buyer.contactPhone || 'No phone recorded'}</p>
    <Card title="Purchase history">{buyer.history?.length?buyer.history.slice(0,10).map(o=><div className="stat-line" key={o.id}><span>#{o.id} · {date(o.date)} · {label(o.status)}</span><strong>{money(o.total)}</strong></div>):<p className="muted">No orders yet.</p>}</Card>
    <Card title="Requirements and volume commitments">{buyer.requirements.length?buyer.requirements.map((d,i)=><div key={i} className="stat-line"><span>{d.produceName} · {d.quantity} · {label(d.recurrence)}</span><span>{date(d.requiredDate)}</span></div>):<p className="muted">No open requirements. Record a buyer-approved request in Demand.</p>}<Link to="/farm/demand" className="btn btn-sm mt-8">Manage demand</Link></Card>
    <form className="form" onSubmit={save}><Field label="Relationship notes"><textarea aria-label="Relationship notes" className="input" rows={4} maxLength={3000} value={notes} onChange={e=>setNotes(e.target.value)}/></Field><Field label="Next follow-up"><input aria-label="Next follow-up" className="input" type="date" value={follow} onChange={e=>setFollow(e.target.value)}/></Field>{error&&<div className="form-error">{error}</div>}<button className="btn btn-primary" disabled={busy}>Save relationship</button></form>
    <Card title="Available produce to discuss" description="Current stock for a farmer-reviewed offer. No message is sent automatically.">{buyer.availableOffers.map(o=><div key={o.batchId} className="stat-line"><span>{o.name} · {o.available} available</span><strong>{money(o.price)}/unit</strong></div>)}<Link className="btn btn-sm mt-16" to="/farm/campaigns">Draft an offer in Connect</Link></Card>
  </div></Modal>;
}

export default function BuyerGrowth(){
  const {farmId}=useFarm(); const [search,setSearch]=useState(''); const [segment,setSegment]=useState('ALL'); const [selected,setSelected]=useState(null);
  const state=useApi(()=>api.get(`/farms/${farmId}/buyer-growth`),[farmId]);
  return <><PageHeader title="Buyer Growth" description="Keep buyer relationships, repeat demand and follow-ups together. Reactivation means no completed purchase in 30 days."/>
    <div className="row mb-16"><input aria-label="Search buyers" className="input" placeholder="Search buyers…" value={search} onChange={e=>setSearch(e.target.value)}/><select aria-label="Buyer segment" className="input" value={segment} onChange={e=>setSegment(e.target.value)}>{['ALL','NEW','ACTIVE','REPEAT','REACTIVATE'].map(s=><option key={s}>{s}</option>)}</select></div>
    <AsyncBoundary state={state}>{buyers=>{const filtered=buyers.filter(b=>b.organisationName.toLowerCase().includes(search.toLowerCase())&&(segment==='ALL'||b.segment===segment));return <Card title="Buyer relationships" tight>{!filtered.length?<EmptyState title="No buyers in this view"/>:<div className="table-wrap"><table className="table"><thead><tr><th>Buyer</th><th>Relationship</th><th>Last purchase</th><th>Collected revenue</th><th>Follow-up</th><th/></tr></thead><tbody>{filtered.map(b=><tr key={b.id}><td><strong>{b.organisationName}</strong><div className="cell-sub">{label(b.buyerType)} · {b.completedOrders||0} completed orders</div></td><td><Badge tone={b.segment==='REACTIVATE'?'medium':'low'}>{label(b.segment)}</Badge></td><td>{b.lastPurchase?date(b.lastPurchase):'No purchase yet'}</td><td>{money(b.collectedRevenue||0)}</td><td>{b.nextFollowUp?date(b.nextFollowUp):'Not scheduled'}</td><td><button className="btn btn-sm" onClick={()=>setSelected(b)}>View relationship</button></td></tr>)}</tbody></table></div>}</Card>;}}</AsyncBoundary>
    {selected&&<Relationship key={selected.id} buyer={selected} farmId={farmId} onClose={()=>setSelected(null)} onDone={state.reload}/>}
  </>;
}
