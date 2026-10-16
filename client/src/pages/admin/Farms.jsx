import { useState } from 'react';
import { api } from '../../services/api.js';
import { useApi } from '../../hooks/useApi.js';
import { useFarm } from '../../context/FarmContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { PageHeader, Card, AsyncBoundary, EmptyState, Modal, Field, Badge, Notice, fieldErrors } from '../../components/ui.jsx';
import { Icons } from '../../components/Icons.jsx';
import { dateTime, label } from '../../utils/format.js';

const REGIONS = ['CENTRAL', 'NORTH', 'NORTH_EAST', 'EAST', 'WEST'];
const METHODS = ['FARM_PICKUP', 'CENTRAL_DROP', 'COMMUNITY_DROP', 'DELIVERY'];
const slugify = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Generic modal form: posts `toPayload(form)` to `path`, then calls onDone. */
function FormModal({ title, path, initial, toPayload, success, onClose, onDone, children }) {
  const toast = useToast();
  const [form, setForm] = useState(initial);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(path, toPayload(form));
      toast(success);
      await onDone?.();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={title} onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" form="admin-form" disabled={busy}>{busy ? 'Saving…' : title}</button>
      </>
    }>
      <form id="admin-form" className="form" onSubmit={submit}>
        {error && <div className="form-error">{error.message}</div>}
        {children({ form, set, setForm, errs: fieldErrors(error) })}
      </form>
    </Modal>
  );
}

const blank = (v) => (v.trim() ? v.trim() : undefined);

function TeamModal({ farm, onClose }) {
  const state = useApi(() => api.get(`/farms/${farm.id}/team`), [farm.id]);
  return (
    <Modal title={`${farm.name} — team`} wide onClose={onClose}>
      <AsyncBoundary state={state}>
        {(team) => team.length === 0 ? <EmptyState title="No farm users yet">Use Add farm user to invite the first admin.</EmptyState> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Last login</th></tr></thead>
              <tbody>
                {team.map((u) => (
                  <tr key={u.id}>
                    <td><div className="cell-title">{u.fullName}</div><div className="cell-sub">{u.email}</div></td>
                    <td>{label(u.role)}{u.staffRole && <div className="cell-sub">{label(u.staffRole)}</div>}</td>
                    <td>{u.isActive ? <Badge tone="low">Active</Badge> : <Badge>Inactive</Badge>}</td>
                    <td>{u.lastLoginAt ? dateTime(u.lastLoginAt) : <span className="muted">Never</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AsyncBoundary>
    </Modal>
  );
}

export default function Farms() {
  const { refreshFarms } = useFarm();
  const state = useApi(() => api.get('/farms'), []);
  const [modal, setModal] = useState(null); // { type: 'farm' | 'team' | 'user', farm? }
  const close = () => setModal(null);
  const afterFarm = () => Promise.all([state.reload(), refreshFarms()]);

  return (
    <>
      <PageHeader
        title="Farms"
        description="Platform administration: onboard farms and their teams."
        actions={<button className="btn btn-primary" onClick={() => setModal({ type: 'farm' })}><Icons.Plus width={16} /> Add farm</button>}
      />
      <div className="stack">
        <Notice>Tyllage is multi-farm ready. Onboard additional farms (Farm B, Farm C…) here, then add their admins and staff — each farm only sees its own harvests, demand and orders.</Notice>
        <AsyncBoundary state={state}>
          {(farms) => (
            <Card tight>
              {farms.length === 0 ? <EmptyState title="No farms yet">Add the first farm to get started.</EmptyState> : (
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>Farm</th><th>Slug</th><th>Region</th><th>Status</th><th /></tr></thead>
                    <tbody>
                      {farms.map((f) => (
                        <tr key={f.id}>
                          <td><div className="cell-title">{f.name}</div>{f.contactEmail && <div className="cell-sub">{f.contactEmail}</div>}</td>
                          <td className="muted">{f.slug}</td>
                          <td>{f.region ? label(f.region) : '—'}</td>
                          <td>
                            <div className="row">
                              {f.isActive ? <Badge tone="low">Active</Badge> : <Badge>Inactive</Badge>}
                            </div>
                          </td>
                          <td className="num">
                            <div className="row" style={{ justifyContent: 'flex-end' }}>
                              <button className="btn btn-sm" onClick={() => setModal({ type: 'team', farm: f })}><Icons.Users width={14} /> Team</button>
                              <button className="btn btn-sm" onClick={() => setModal({ type: 'user', farm: f })}><Icons.Plus width={14} /> Add farm user</button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          )}
        </AsyncBoundary>
      </div>

      {modal?.type === 'team' && <TeamModal farm={modal.farm} onClose={close} />}

      {modal?.type === 'farm' && (
        <FormModal
          title="Add farm" path="/farms" success="Farm created" onClose={close} onDone={afterFarm}
          initial={{ name: '', slug: '', description: '', region: '', address: '', contactEmail: '', fulfilmentMethods: ['FARM_PICKUP'] }}
          toPayload={(f) => ({
            name: f.name.trim(), slug: f.slug, description: blank(f.description), region: f.region || undefined,
            address: blank(f.address), contactEmail: blank(f.contactEmail), fulfilmentMethods: f.fulfilmentMethods,
          })}
        >
          {({ form, set, setForm, errs }) => (
            <div className="form-grid">
              <Field label="Farm name" error={errs.name}>
                <input className="input" value={form.name} required minLength={2}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value, slug: f.slug === slugify(f.name) ? slugify(e.target.value) : f.slug }))} />
              </Field>
              <Field label="Slug" hint="Lowercase letters, numbers and dashes" error={errs.slug}>
                <input className="input" value={form.slug} onChange={(e) => setForm((f) => ({ ...f, slug: slugify(e.target.value) }))} required pattern="[a-z0-9-]{3,80}" />
              </Field>
              <Field label="Region" error={errs.region}>
                <select className="input" value={form.region} onChange={set('region')}>
                  <option value="">Not specified</option>
                  {REGIONS.map((r) => <option key={r} value={r}>{label(r)}</option>)}
                </select>
              </Field>
              <Field label="Contact email" error={errs.contactEmail}><input className="input" type="email" value={form.contactEmail} onChange={set('contactEmail')} /></Field>
              <Field label="Address" full error={errs.address}><input className="input" value={form.address} onChange={set('address')} /></Field>
              <Field label="Description" full error={errs.description}><textarea className="input" rows={3} value={form.description} onChange={set('description')} /></Field>
              <Field label="Fulfilment methods" full error={errs.fulfilmentMethods}>
                <div className="row">
                  {METHODS.map((m) => (
                    <label key={m} className="checkbox">
                      <input type="checkbox" checked={form.fulfilmentMethods.includes(m)}
                        onChange={(e) => setForm((f) => ({ ...f, fulfilmentMethods: e.target.checked ? [...f.fulfilmentMethods, m] : f.fulfilmentMethods.filter((x) => x !== m) }))} />
                      <span>{label(m)}</span>
                    </label>
                  ))}
                </div>
              </Field>
            </div>
          )}
        </FormModal>
      )}

      {modal?.type === 'user' && (
        <FormModal
          title="Add farm user" path={`/farms/${modal.farm.id}/users`} success="Farm user created" onClose={close}
          initial={{ fullName: '', email: '', password: '', role: 'farm_staff', phone: '' }}
          toPayload={(f) => ({ fullName: f.fullName.trim(), email: f.email.trim(), password: f.password, role: f.role, phone: blank(f.phone) })}
        >
          {({ form, set, errs }) => (
            <>
              <p className="small muted">Creates a login for <span className="strong">{modal.farm.name}</span>. Share the temporary password securely.</p>
              <div className="form-grid">
                <Field label="Full name" error={errs.fullName}><input className="input" value={form.fullName} onChange={set('fullName')} required minLength={2} /></Field>
                <Field label="Email" error={errs.email}><input className="input" type="email" value={form.email} onChange={set('email')} required /></Field>
                <Field label="Temporary password" hint="At least 8 characters" error={errs.password}>
                  <input className="input" type="password" autoComplete="new-password" value={form.password} onChange={set('password')} required minLength={8} />
                </Field>
                <Field label="Role" error={errs.role}>
                  <select className="input" value={form.role} onChange={set('role')}>
                    <option value="farm_admin">{label('farm_admin')}</option>
                    <option value="farm_staff">{label('farm_staff')}</option>
                  </select>
                </Field>
                <Field label="Phone (optional)" error={errs.phone}><input className="input" value={form.phone} onChange={set('phone')} /></Field>
              </div>
            </>
          )}
        </FormModal>
      )}
    </>
  );
}
