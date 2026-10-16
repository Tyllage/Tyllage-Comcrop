import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../services/api.js';
import { useApi } from '../../hooks/useApi.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { PageHeader, Card, AsyncBoundary, EmptyState, Badge } from '../../components/ui.jsx';
import { DemoTag } from '../../components/domain.jsx';
import { Icons } from '../../components/Icons.jsx';
import { kg, money, date, dateTime, relativeDay, label } from '../../utils/format.js';
import { BuyModal, COLLECTION_METHODS, CONSUMER_COLLECTION } from '../buyer/demandShared.jsx';

const hhmm = (t) => (t ? t.slice(0, 5) : '—');
// Collection methods the farm actually offers (falls back to farm pickup).
const offered = (methods, farmMethods = []) => {
  const list = methods.filter((m) => farmMethods.includes(m));
  return list.length ? list : ['FARM_PICKUP'];
};

export default function FarmProfile() {
  const { id } = useParams();
  const { user } = useAuth();
  const isConsumer = user?.role === 'consumer';
  const state = useApi(() => api.get(`/marketplace/farms/${id}`), [id]);
  const [buying, setBuying] = useState(null);
  const supplyPath = isConsumer ? '/consumer/available' : '/buyer/supply';

  return (
    <AsyncBoundary state={state}>
      {(farm) => (
        <>
          <PageHeader
            title={farm.name}
            description={farm.region ? `${label(farm.region)} region · local partner farm on Tyllage` : 'Local partner farm on Tyllage'}
            actions={<>{isConsumer && <Link className="btn btn-primary" to={`/consumer/shop/${id}`}>Visit farm shop</Link>}<Link className="btn" to="/market/farms">All farms</Link></>}
          />
          <div className="stack">
            <div className="grid grid-main-side">
              <Card title="About" actions={farm.isDemo && <DemoTag />}>
                <div className="stack">
                  <p>{farm.description || 'This farm has not added a description yet.'}</p>
                  <div>
                    <div className="small muted">Fulfilment options</div>
                    <div className="chip-row" style={{ marginTop: 6 }}>
                      {(farm.fulfilmentMethods || []).map((m) => <Badge key={m} tone="primary">{label(m)}</Badge>)}
                    </div>
                  </div>
                </div>
              </Card>
              <Card title="What we grow" description={`${farm.produce.length} produce item${farm.produce.length === 1 ? '' : 's'}`}>
                {farm.produce.length === 0 ? <EmptyState title="No produce listed" /> : (
                  <div>
                    {farm.produce.map((p) => (
                      <div key={p.id} className="stat-line">
                        <span>
                          {p.name}
                          {p.category && <span className="small muted"> · {label(p.category)}</span>}
                        </span>
                        <span className="small muted">
                          {p.defaultPrice ? `${money(p.defaultPrice)}/${p.unit}` : p.unit}
                          {Number(p.minOrderQuantity) > 0 && ` · min ${kg(p.minOrderQuantity, p.unit)}`}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </div>

            <Card
              title="Available & upcoming supply"
              description="Live harvest batches with stock remaining. Orders are confirmed by the farm."
              actions={<Link className="btn btn-sm" to={supplyPath}>Browse all supply <Icons.Arrow width={14} /></Link>}
              tight
            >
              {farm.supply.length === 0 ? (
                <EmptyState title="No supply listed right now">This farm publishes new harvests regularly — check back soon.</EmptyState>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Produce</th>
                        <th>Harvest</th>
                        <th>Grade</th>
                        <th className="num">Available</th>
                        <th className="num">Price / unit</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {farm.supply.map((b) => (
                        <tr key={b.id}>
                          <td className="cell-title">{b.produceName}</td>
                          <td>
                            <div>{date(b.harvestDate, { weekday: true })}</div>
                            <div className="cell-sub">{relativeDay(b.harvestDate)}</div>
                          </td>
                          <td>{b.grade ? label(b.grade) : '—'}</td>
                          <td className="num">
                            <div>{kg(b.availableQuantity, b.unit)}</div>
                            {b.minOrderQuantity > 0 && <div className="cell-sub">Min order {kg(b.minOrderQuantity, b.unit)}</div>}
                          </td>
                          <td className="num">{money(b.price)}</td>
                          <td className="num">
                            <button className="btn btn-primary btn-sm" onClick={() => setBuying({ ...b, farmName: b.farmName || farm.name })}>Buy</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            <div className="grid grid-2">
              <Card
                title="Rescue offers"
                description="Surplus or imperfect produce at a reduced price, before it goes to waste."
                actions={isConsumer && farm.rescue.length > 0 && <Link className="btn btn-sm" to="/consumer/rescue">Reserve in Rescue market</Link>}
              >
                {farm.rescue.length === 0 ? <EmptyState title="No Rescue offers right now" /> : (
                  <div>
                    {farm.rescue.map((r) => (
                      <div key={r.id} className="stat-line">
                        <div>
                          <div className="strong">{r.produceName}</div>
                          <div className="small muted">{label(r.reason)} · {kg(r.availableQuantity, r.unit)} left · collect before {dateTime(r.collectionDeadline)}</div>
                        </div>
                        <div className="num">
                          <b>{money(r.rescuePrice)}</b>
                          <span className="small muted" style={{ textDecoration: 'line-through', marginLeft: 6 }}>{money(r.originalPrice)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
              <Card
                title="Community Drops"
                description="Scheduled group deliveries to a neighbourhood collection point."
                actions={isConsumer && farm.communityDrops.length > 0 && <Link className="btn btn-sm" to="/consumer/drops">View drops</Link>}
              >
                {farm.communityDrops.length === 0 ? <EmptyState title="No Community Drops scheduled" /> : (
                  <div>
                    {farm.communityDrops.map((d) => (
                      <div key={d.id} className="stat-line">
                        <div>
                          <div className="strong">{d.communityName}</div>
                          <div className="small muted"><Icons.Pin width={12} /> {d.collectionPoint}</div>
                        </div>
                        <div className="small" style={{ textAlign: 'right' }}>
                          <div className="strong">{date(d.dropDate, { weekday: true })}</div>
                          <div className="muted">{hhmm(d.windowStart)}–{hhmm(d.windowEnd)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </div>
          </div>
          {buying && (
            <BuyModal
              item={buying}
              methods={offered(isConsumer ? CONSUMER_COLLECTION : COLLECTION_METHODS, farm.fulfilmentMethods)}
              onClose={() => setBuying(null)}
              onDone={state.reload}
            />
          )}
        </>
      )}
    </AsyncBoundary>
  );
}
