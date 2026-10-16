import { useState } from 'react';
import { api } from '../../services/api.js';
import { useApi } from '../../hooks/useApi.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useDialog } from '../../context/DialogContext.jsx';
import { PageHeader, Card, AsyncBoundary, EmptyState, FilterChips, Badge } from '../../components/ui.jsx';
import { dateTime, label } from '../../utils/format.js';

const ROLE_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'farm', label: 'Farm side' },
  { value: 'business_buyer', label: 'Business buyers' },
  { value: 'consumer', label: 'Consumers' },
];
const FARM_ROLES = ['platform_admin', 'farm_admin', 'farm_staff'];

export default function Users() {
  const { user: me } = useAuth();
  const toast = useToast();
  const dialog = useDialog();
  const state = useApi(() => api.get('/users'), []);
  const [filter, setFilter] = useState('all');
  const [busyId, setBusyId] = useState(null);

  const toggle = async (u) => {
    const next = !u.isActive;
    if (!next && !(await dialog.confirm({
      title: `Deactivate ${u.fullName}?`, tone: 'danger', icon: 'User',
      message: 'They will no longer be able to sign in. You can reactivate the account at any time.',
      confirmLabel: 'Deactivate', cancelLabel: 'Keep active',
    }))) return;
    setBusyId(u.id);
    try {
      await api.patch(`/users/${u.id}/active`, { isActive: next });
      state.setData((list) => list.map((x) => (x.id === u.id ? { ...x, isActive: next } : x)));
      toast(`${u.fullName} ${next ? 'activated' : 'deactivated'}`);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusyId(null);
    }
  };

  const matches = (u) => filter === 'all' || (filter === 'farm' ? FARM_ROLES.includes(u.role) : u.role === filter);

  return (
    <>
      <PageHeader title="Users" description="All accounts on the platform. Deactivated users cannot sign in; their history is kept." />
      <AsyncBoundary state={state}>
        {(users) => {
          const rows = users.filter(matches);
          return (
            <div className="stack">
              <FilterChips options={ROLE_FILTERS} value={filter} onChange={setFilter} />
              <Card tight>
                {rows.length === 0 ? <EmptyState title="No users in this view" /> : (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr><th>User</th><th>Role</th><th>Farms / organisation</th><th>Status</th><th>Last login</th><th /></tr>
                      </thead>
                      <tbody>
                        {rows.map((u) => (
                          <tr key={u.id}>
                            <td>
                              <div className="cell-title">{u.fullName}{u.id === me?.id && <span className="muted"> (you)</span>}</div>
                              <div className="cell-sub">{u.email}</div>
                            </td>
                            <td>{label(u.role)}</td>
                            <td>
                              {u.farms?.length > 0 && <div>{u.farms.join(', ')}</div>}
                              {u.organisationName && <div className={u.farms?.length ? 'cell-sub' : ''}>{u.organisationName}{u.buyerType && <span className="muted"> · {label(u.buyerType)}</span>}</div>}
                              {!u.farms?.length && !u.organisationName && <span className="muted">—</span>}
                            </td>
                            <td>{u.isActive ? <Badge tone="low">Active</Badge> : <Badge>Inactive</Badge>}</td>
                            <td>{u.lastLoginAt ? dateTime(u.lastLoginAt) : <span className="muted">Never</span>}</td>
                            <td className="num">
                              <button className={`btn btn-sm ${u.isActive ? 'btn-danger' : ''}`} disabled={busyId === u.id} onClick={() => toggle(u)}>
                                {u.isActive ? 'Deactivate' : 'Activate'}
                              </button>
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
