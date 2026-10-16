import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useFarm } from '../../context/FarmContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useApi } from '../../hooks/useApi.js';
import { api } from '../../services/api.js';
import { PageHeader, Card, AsyncBoundary, Field, Badge, EmptyState, Modal } from '../../components/ui.jsx';
import { date, money, label } from '../../utils/format.js';

/** One line in a relationship section: what it is on the left, the figure that matters on the right. */
function RelItem({ title, meta, value, valueSub }) {
  return <li className="rel-item"><div><div className="strong">{title}</div>{meta && <div className="cell-sub">{meta}</div>}</div><div className="rel-item-value"><div className="strong">{value}</div>{valueSub && <div className="cell-sub">{valueSub}</div>}</div></li>;
}

function RelList({ empty, children }) {
  return children?.length ? <ul className="rel-list">{children}</ul> : <div className="rel-empty">{empty}</div>;
}

function Relationship({ buyer, farmId, onClose, onDone }) {
  const [notes,setNotes]=useState(buyer.notes);const [follow,setFollow]=useState(buyer.nextFollowUp||'');const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const save=async e=>{e.preventDefault();setBusy(true);try{await api.patch(`/farms/${farmId}/buyer-growth/${buyer.id}`,{notes,nextFollowUp:follow||null});onDone();onClose();}catch(e){setError(e.message);}finally{setBusy(false);}};
  return <Modal title={buyer.organisationName} onClose={onClose}><div className="stack"><p>{buyer.contactName} · {buyer.contactEmail || 'No email recorded'} · {buyer.contactPhone || 'No phone recorded'}</p>
    <Card tight title="Purchase history">
      <RelList empty="No orders yet.">{buyer.history?.slice(0,10).map(o=><RelItem key={o.id} title={`Order #${o.id}`} meta={`${date(o.date)} · ${label(o.status)}`} value={money(o.total)}/>)}</RelList>
    </Card>
    <Card tight title="Open requirements" description="Buyer-approved requests and volume commitments."
      actions={<Link to="/farm/demand" className="btn btn-sm">Manage demand</Link>}>
      <RelList empty={<>No open requirements yet. When this buyer confirms what they need, record it in <Link to="/farm/demand">Demand</Link>.</>}>
        {buyer.requirements.map((d,i)=><RelItem key={i} title={d.produceName} meta={label(d.recurrence)} value={d.quantity} valueSub={`by ${date(d.requiredDate)}`}/>)}
      </RelList>
    </Card>
    <Card tight title="Produce to offer" description="Current stock you could offer. Nothing is sent until you review it in Connect."
      actions={<Link className="btn btn-sm btn-primary" to="/farm/campaigns">Draft an offer</Link>}>
      <RelList empty="No unallocated stock right now. New harvests will show here.">
        {buyer.availableOffers.map(o=><RelItem key={o.batchId} title={o.name} meta={`${o.available} available`} value={`${money(o.price)}/unit`}/>)}
      </RelList>
    </Card>
    <form className="form" onSubmit={save}><Field label="Relationship notes"><textarea aria-label="Relationship notes" className="input" rows={4} maxLength={3000} value={notes} onChange={e=>setNotes(e.target.value)}/></Field><Field label="Next follow-up"><input aria-label="Next follow-up" className="input" type="date" value={follow} onChange={e=>setFollow(e.target.value)}/></Field>{error&&<div className="form-error">{error}</div>}<button className="btn btn-primary" disabled={busy}>Save relationship</button></form>
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
