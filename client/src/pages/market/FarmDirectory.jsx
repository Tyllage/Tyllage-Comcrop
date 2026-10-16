import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../services/api.js';
import { useApi } from '../../hooks/useApi.js';
import { PageHeader, Card, AsyncBoundary, EmptyState, FilterChips, Badge } from '../../components/ui.jsx';
import { Icons } from '../../components/Icons.jsx';
import { label } from '../../utils/format.js';

export default function FarmDirectory() {
  const state = useApi(() => api.get('/marketplace/farms'), []);
  const [region, setRegion] = useState('all');

  return (
    <>
      <PageHeader
        title="Partner farms"
        description="Local farms selling through Tyllage. Open a farm to see what it grows, current supply, Rescue offers and upcoming Community Drops."
      />
      <AsyncBoundary state={state}>
        {(farms) => {
          const regions = [...new Set(farms.map((f) => f.region).filter(Boolean))].sort();
          const rows = region === 'all' ? farms : farms.filter((f) => f.region === region);
          return (
            <div className="stack">
              {regions.length > 1 && (
                <FilterChips
                  options={[{ value: 'all', label: `All regions (${farms.length})` }, ...regions.map((r) => ({ value: r, label: label(r) }))]}
                  value={region}
                  onChange={setRegion}
                />
              )}
              {rows.length === 0 ? (
                <Card><EmptyState title="No farms listed yet">Partner farms appear here once they join Tyllage.</EmptyState></Card>
              ) : (
                <div className="product-grid">
                  {rows.map((f) => (
                    <div key={f.id} className="product-card">
                      <div className="row-between">
                        <h3><Link to={`/market/farms/${f.id}`}>{f.name}</Link></h3>
                        {f.region && <Badge tone="outline"><Icons.Pin width={12} /> {label(f.region)}</Badge>}
                      </div>
                      <p className="small muted">{f.description || 'No description yet.'}</p>
                      {f.produce.length > 0 ? (
                        <div className="chip-row">
                          {f.produce.slice(0, 8).map((p) => <span key={p.id} className="mini-chip">{p.name}</span>)}
                          {f.produce.length > 8 && <span className="mini-chip">+{f.produce.length - 8} more</span>}
                        </div>
                      ) : (
                        <div className="small muted">No produce listed</div>
                      )}
                      <div className="foot">
                        <span className="small muted">{f.produce.length} produce item{f.produce.length === 1 ? '' : 's'}</span>
                        <Link className="btn btn-sm" to={`/market/farms/${f.id}`}>View farm <Icons.Arrow width={14} /></Link>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        }}
      </AsyncBoundary>
    </>
  );
}
