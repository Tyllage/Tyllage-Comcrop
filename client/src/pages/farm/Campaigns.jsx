import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../services/api.js';
import { useApi } from '../../hooks/useApi.js';
import { useFarm } from '../../context/FarmContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useDialog } from '../../context/DialogContext.jsx';
import { AsyncBoundary, Badge, Card, EmptyState, Field, Modal, Notice, PageHeader, Tabs } from '../../components/ui.jsx';
import { StatusBadge } from '../../components/domain.jsx';
import { Icons } from '../../components/Icons.jsx';
import { dateTime, kg, label, routeLabel, ROUTES } from '../../utils/format.js';
import AiPanel from '../../components/AiPanel.jsx';

const TYPES = ['RESCUE_ALERT', 'B2B_AVAILABILITY', 'HARVEST_ANNOUNCEMENT', 'DEMAND_RECOVERY', 'COMMUNITY_DROP', 'CUSTOMER_RECOMMENDATION'];
const AUDIENCES = ['ALL_BUYERS', 'BUSINESS_BUYERS', 'CONSUMERS', 'COMMUNITY'];
const NEEDS = { RESCUE_ALERT: 'rescue', COMMUNITY_DROP: 'drop', CUSTOMER_RECOMMENDATION: null };

function GenerateModal({ farmId, onClose, onCreated }) {
  const toast = useToast();
  const [type, setType] = useState('B2B_AVAILABILITY');
  const [ref, setRef] = useState('');
  const [audience, setAudience] = useState('');
  const [targetRoute, setTargetRoute] = useState('');
  const [busy, setBusy] = useState(false);
  const need = type in NEEDS ? NEEDS[type] : 'batch';
  const batches = useApi(() => api.get('/harvests', { farmId }), [farmId]);
  const rescue = useApi(() => api.get('/rescue', { farmId }), [farmId]);
  const drops = useApi(() => api.get('/community-drops', { farmId }), [farmId]);

  const options =
    need === 'batch' ? (batches.data || []).filter((b) => b.unallocatedQuantity > 0).map((b) => [b.id, `${b.produceName} · ${b.harvestDate} · ${kg(b.unallocatedQuantity)} unallocated`])
      : need === 'rescue' ? (rescue.data || []).filter((l) => l.status === 'ACTIVE').map((l) => [l.id, `${l.produceName} · ${kg(l.availableQuantity)} available`])
        : need === 'drop' ? (drops.data || []).filter((d) => d.status === 'SCHEDULED').map((d) => [d.id, `${d.communityName} · ${d.dropDate}`]) : [];

  useEffect(() => setRef(''), [type]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    const body = { farmId, campaignType: type, audience: audience || undefined };
    if (need === 'batch') {
      body.harvestBatchId = Number(ref);
      if (targetRoute) body.targetRoute = targetRoute;
    }
    if (need === 'rescue') body.rescueListingId = Number(ref);
    if (need === 'drop') body.communityDropId = Number(ref);
    try {
      const c = await api.post('/campaigns/generate', body);
      toast(c.generationMode === 'OPENAI' ? 'Draft written with OpenAI' : 'Draft created (template mode)');
      onCreated(c);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Generate outreach with Tyllage Connect" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="gen-form" disabled={busy || (need && !ref)}><Icons.Sparkle />{busy ? 'Generating…' : 'Generate draft'}</button></>}>
      <form id="gen-form" className="form" onSubmit={submit}>
        <Notice tone="info">AI writes copy only, from facts in your farm's records. It cannot change prices, stock, allocations or choose recipients — and nothing is sent until you approve.</Notice>
        <Field label="Campaign type">
          <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
            {TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}
          </select>
        </Field>
        {need && (
          <Field label={need === 'batch' ? 'Harvest batch' : need === 'rescue' ? 'Rescue listing' : 'Community Drop'} hint={!options.length ? 'Nothing eligible right now' : undefined}>
            <select className="input" value={ref} onChange={(e) => setRef(e.target.value)} required>
              <option value="" disabled>Select…</option>
              {options.map(([id, text]) => <option key={id} value={id}>{text}</option>)}
            </select>
          </Field>
        )}
        {need === 'batch' && (
          <Field label="Target route (MarketRoute)" hint="Address only buyers in one route. Overrides the audience below.">
            <select className="input" value={targetRoute} onChange={(e) => setTargetRoute(e.target.value)}>
              <option value="">Any route</option>
              {ROUTES.filter(([k]) => k !== 'RESCUE').map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Field>
        )}
        <Field label="Audience" hint="Default depends on the campaign type. Recipients are always filtered by the server (opted-in buyers only).">
          <select className="input" value={audience} onChange={(e) => setAudience(e.target.value)} disabled={need === 'batch' && Boolean(targetRoute)}>
            <option value="">Default for this type</option>
            {AUDIENCES.map((a) => <option key={a} value={a}>{label(a)}</option>)}
          </select>
        </Field>
      </form>
    </Modal>
  );
}

function CampaignEditor({ id, onClose, onChanged }) {
  const toast = useToast();
  const dialog = useDialog();
  const state = useApi(() => api.get(`/campaigns/${id}`), [id]);
  const [content, setContent] = useState(null);
  const [busy, setBusy] = useState(false);
  const c = state.data;
  const text = content ?? c?.finalContent ?? '';
  const dirty = c && content !== null && content !== c.finalContent;

  const call = async (fn, message) => {
    setBusy(true);
    try {
      const res = await fn();
      toast(message(res));
      setContent(null);
      await state.reload();
      onChanged();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const save = () => call(() => api.patch(`/campaigns/${id}`, { finalContent: text }), () => 'Changes saved');
  const approve = () => call(async () => { if (dirty) await api.patch(`/campaigns/${id}`, { finalContent: text }); return api.post(`/campaigns/${id}/approve`); }, () => 'Campaign approved');
  const send = async () => (await dialog.confirm({
    title: 'Send this campaign on WhatsApp?', icon: 'Send',
    message: `It goes to ${c.recipientsPreview} opted-in recipient(s) straight away and cannot be unsent.`,
    confirmLabel: 'Send now', cancelLabel: 'Not yet',
  })) &&
    call(() => api.post(`/campaigns/${id}/send`), (r) => `Sent: ${Object.entries(r.delivery).map(([k, v]) => `${v} ${label(k).toLowerCase()}`).join(', ') || 'no recipients'}`);
  const cancel = async () => (await dialog.confirm({
    title: 'Cancel this campaign?', tone: 'danger', icon: 'Campaign',
    message: 'It will not be sent. You can draft a new campaign at any time.',
    confirmLabel: 'Cancel campaign', cancelLabel: 'Keep campaign',
  })) && call(() => api.post(`/campaigns/${id}/cancel`), () => 'Campaign cancelled');
  const [variations, setVariations] = useState(null);
  const loadVariations = async () => {
    setBusy(true);
    try {
      setVariations(await api.post(`/campaigns/${id}/variations`));
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={c ? c.title : 'Campaign'} onClose={onClose} wide
      footer={c && (
        <>
          {['DRAFT', 'APPROVED'].includes(c.status) && <button className="btn btn-ghost" onClick={cancel} disabled={busy}>Cancel campaign</button>}
          <div className="topbar-spacer" />
          {c.status === 'DRAFT' && <button className="btn" onClick={save} disabled={busy || !dirty}>Save edits</button>}
          {c.status === 'DRAFT' && <button className="btn btn-primary" onClick={approve} disabled={busy}><Icons.Check />Approve</button>}
          {c.status === 'APPROVED' && <button className="btn btn-primary" onClick={send} disabled={busy}><Icons.Send />Send via WhatsApp</button>}
        </>
      )}>
      <AsyncBoundary state={state}>
        {(c) => (
          <div className="stack">
            <div className="row">
              <StatusBadge status={c.status} />
              <Badge>{label(c.campaignType)}</Badge>
              <Badge tone={c.generationMode === 'OPENAI' ? 'info' : 'outline'}>{label(c.generationMode)}</Badge>
              <Badge tone="outline">{label(c.audience)} · {c.recipientsPreview} opted-in recipient{c.recipientsPreview === 1 ? '' : 's'}</Badge>
            </div>
            {c.warnings?.map((w) => <Notice key={w} tone="warning">{w}</Notice>)}
            <Field label={c.status === 'DRAFT' ? 'Message (review and edit before approving)' : 'Message'}>
              <textarea className="input" rows={9} value={text} onChange={(e) => setContent(e.target.value)} disabled={c.status !== 'DRAFT'} />
            </Field>
            {c.status === 'DRAFT' && (
              <div>
                <button className="btn btn-sm" onClick={loadVariations} disabled={busy}><Icons.Sparkle />Generate variations</button>
                {variations && (
                  <div className="stack mt-8">
                    <AiPanel result={{ ...variations, output: `${variations.variations.length} variations generated — pick one to use as the draft.` }} title="Campaign variations" onClose={() => setVariations(null)} />
                    <div className="grid grid-3">
                      {variations.variations.map((v) => (
                        <div key={v.tone} className="card" style={{ padding: 12 }}>
                          <div className="row-between"><span className="strong small">{v.tone}</span>
                            <button className="btn btn-sm" onClick={() => setContent(v.text)}>Use this</button></div>
                          <div className="small mt-8" style={{ whiteSpace: 'pre-wrap' }}>{v.text}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
            <details>
              <summary className="small muted" style={{ cursor: 'pointer' }}>Approved business context sent to the copywriter</summary>
              <pre className="mono" style={{ background: 'var(--surface-2)', padding: 12, borderRadius: 6, overflowX: 'auto' }}>{JSON.stringify(c.context, null, 2)}</pre>
            </details>
            {c.approvedAt && <div className="small muted">Approved by {c.approvedByName} · {dateTime(c.approvedAt)}{c.sentAt && ` · Sent ${dateTime(c.sentAt)} to ${c.recipientsCount}`}</div>}
          </div>
        )}
      </AsyncBoundary>
    </Modal>
  );
}

export default function Campaigns() {
  const { farmId } = useFarm();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState('campaigns');
  const [generating, setGenerating] = useState(false);
  const openId = Number(params.get('open')) || null;
  const campaigns = useApi(() => api.get('/campaigns', { farmId }), [farmId], { enabled: Boolean(farmId) });
  const log = useApi(() => api.get(`/farms/${farmId}/whatsapp-log`), [farmId, tab], { enabled: Boolean(farmId) && tab === 'log' });
  const health = useApi(() => api.get('/health'), []);
  const open = (id) => setParams(id ? { open: String(id) } : {});

  return (
    <>
      <PageHeader
        title="Tyllage Connect"
        description="Approved outreach to business buyers, existing customers and community audiences. AI drafts copy from your farm's records; the backend controls stock, prices and recipients, and nothing is sent until you approve."
        actions={<button className="btn btn-primary" onClick={() => setGenerating(true)}><Icons.Sparkle />Generate outreach</button>}
      />
      {health.data && (
        <div className="row small muted" style={{ marginBottom: 12 }}>
          <span>Copywriting: <b>{health.data.integrations.openai === 'configured' ? 'OpenAI' : 'template (mock) mode'}</b></span>
          <span>· WhatsApp: <b>{health.data.integrations.whatsapp === 'configured' ? 'Cloud API' : 'mock mode — messages are logged, not delivered'}</b></span>
        </div>
      )}
      <Tabs tabs={[{ value: 'campaigns', label: 'Outreach' }, { value: 'log', label: 'WhatsApp message log' }]} value={tab} onChange={setTab} />
      {tab === 'campaigns' && (
        <Card tight>
          <AsyncBoundary state={campaigns}>
            {(rows) =>
              rows.length === 0 ? <EmptyState title="No campaigns yet" action={<button className="btn btn-primary" onClick={() => setGenerating(true)}>Generate the first one</button>} /> : (
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>Campaign</th><th>Type</th><th>Audience / route</th><th>Mode</th><th>Status</th><th>Updated</th><th /></tr></thead>
                    <tbody>
                      {rows.map((c) => (
                        <tr key={c.id} className="clickable" onClick={() => open(c.id)}>
                          <td className="cell-title">{c.title}<div className="cell-sub" style={{ maxWidth: 420, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.finalContent}</div></td>
                          <td>{label(c.campaignType)}</td>
                          <td>{c.context?.targetRoute ? routeLabel(c.context.targetRoute) : label(c.audience)}</td>
                          <td>{label(c.generationMode)}</td>
                          <td><StatusBadge status={c.status} /></td>
                          <td className="nowrap">{dateTime(c.updatedAt)}</td>
                          <td><button className="btn btn-sm">{c.status === 'DRAFT' ? 'Review' : 'View'}</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            }
          </AsyncBoundary>
        </Card>
      )}
      {tab === 'log' && (
        <Card tight>
          <AsyncBoundary state={log}>
            {(rows) =>
              rows.length === 0 ? <EmptyState title="No WhatsApp messages yet" /> : (
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>Sent</th><th>Recipient</th><th>Type</th><th>Message</th><th>Status</th><th>Provider ID</th></tr></thead>
                    <tbody>
                      {rows.map((n) => (
                        <tr key={n.id}>
                          <td className="nowrap">{dateTime(n.sentAt || n.createdAt)}</td>
                          <td>{n.buyerName}</td>
                          <td>{label(n.notificationType)}</td>
                          <td className="small" style={{ maxWidth: 360 }}>{n.body.slice(0, 120)}{n.body.length > 120 && '…'}</td>
                          <td><StatusBadge status={n.status} />{n.error && <div className="cell-sub">{n.error}</div>}</td>
                          <td className="mono small">{n.providerMessageId || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            }
          </AsyncBoundary>
        </Card>
      )}
      {generating && <GenerateModal farmId={farmId} onClose={() => setGenerating(false)} onCreated={(c) => { setGenerating(false); campaigns.reload(); open(c.id); }} />}
      {openId && <CampaignEditor id={openId} onClose={() => open(null)} onChanged={campaigns.reload} />}
    </>
  );
}
