import { useState } from 'react';
import { api } from '../../services/api.js';
import { useApi } from '../../hooks/useApi.js';
import { PageHeader, Card, AsyncBoundary, EmptyState, FilterChips } from '../../components/ui.jsx';
import { dateTime, label } from '../../utils/format.js';

const SECURITY_PREFIXES = ['LOGIN_', 'USER_', 'POLICY_'];
const isSecurity = (action) => SECURITY_PREFIXES.some((p) => action?.startsWith(p));
const FILTERS = {
  all: () => true,
  security: (r) => isSecurity(r.action),
  farm: (r) => !isSecurity(r.action),
};
const hasDetails = (d) => d && typeof d === 'object' && Object.keys(d).length > 0;

// camelCase / snake_case key -> "Sentence case"
const keyLabel = (k) => {
  const s = String(k).replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const isEnum = (v) => typeof v === 'string' && /^[A-Z][A-Z0-9_]*$/.test(v);

function DetailValue({ value }) {
  if (value === null || value === undefined || value === '') return <span className="muted">—</span>;
  if (typeof value === 'boolean') return <span className={`badge ${value ? 'badge-low' : 'badge-outline'}`}>{value ? 'Yes' : 'No'}</span>;
  if (isEnum(value)) return <span className="badge badge-outline">{label(value)}</span>;
  if (Array.isArray(value) && value.every((v) => typeof v !== 'object')) {
    return value.length ? value.map((v, i) => <span key={i} className="badge badge-outline">{isEnum(v) ? label(v) : String(v)}</span>) : <span className="muted">None</span>;
  }
  if (typeof value === 'object') return <pre className="audit-details-json">{JSON.stringify(value, null, 2)}</pre>;
  return <span>{String(value)}</span>;
}

function AuditDetails({ details }) {
  const entries = Object.entries(details);
  return (
    <details className="audit-details">
      <summary>
        <span className="audit-details-chevron" aria-hidden="true">›</span>
        Details <span className="audit-details-count">{entries.length}</span>
      </summary>
      <dl className="audit-details-list">
        {entries.map(([k, v]) => (
          <div key={k} className="audit-details-row">
            <dt>{keyLabel(k)}</dt>
            <dd><DetailValue value={v} /></dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

export default function AuditLog() {
  const state = useApi(() => api.get('/admin/audit-logs'), []);
  const [filter, setFilter] = useState('all');

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Platform-wide record of sign-ins, account changes, policy updates and farm activity (latest 100 events)."
        actions={<button className="btn" disabled={state.loading} onClick={state.reload}>Refresh</button>}
      />
      <AsyncBoundary state={state}>
        {(logs) => {
          const count = (k) => logs.filter(FILTERS[k]).length;
          const rows = logs.filter(FILTERS[filter]);
          return (
            <div className="stack">
              <FilterChips
                options={[
                  { value: 'all', label: `All (${count('all')})` },
                  { value: 'security', label: `Security (${count('security')})` },
                  { value: 'farm', label: `Farm activity (${count('farm')})` },
                ]}
                value={filter}
                onChange={setFilter}
              />
              <Card tight>
                {rows.length === 0 ? <EmptyState title="No events in this view" /> : (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr><th>Time</th><th>Action</th><th>User</th><th>Farm</th><th>Entity</th><th>IP</th><th>Details</th></tr>
                      </thead>
                      <tbody>
                        {rows.map((r) => (
                          <tr key={r.id}>
                            <td className="nowrap">{dateTime(r.createdAt)}</td>
                            <td><span className="mono">{r.action}</span></td>
                            <td>
                              {r.userName ? (
                                <>
                                  <div className="cell-title">{r.userName}</div>
                                  <div className="cell-sub">{r.userEmail}</div>
                                </>
                              ) : <span className="muted">System</span>}
                            </td>
                            <td>{r.farmName || <span className="muted">Platform</span>}</td>
                            <td>{r.entityType ? <>{label(r.entityType)}{r.entityId ? <span className="muted"> #{r.entityId}</span> : null}</> : <span className="muted">—</span>}</td>
                            <td><span className="mono">{r.ipAddress || '—'}</span></td>
                            <td style={{ minWidth: 220 }}>
                              {hasDetails(r.details) ? <AuditDetails details={r.details} /> : <span className="muted">—</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </div>
          );
        }}
      </AsyncBoundary>
    </>
  );
}
