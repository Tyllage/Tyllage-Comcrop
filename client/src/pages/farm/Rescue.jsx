import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../services/api.js';
import { useApi } from '../../hooks/useApi.js';
import { useFarm } from '../../context/FarmContext.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useDialog } from '../../context/DialogContext.jsx';
import { AsyncBoundary, Card, EmptyState, Notice, PageHeader } from '../../components/ui.jsx';
import { StatusBadge } from '../../components/domain.jsx';
import { Icons } from '../../components/Icons.jsx';
import RescueFormModal from '../../components/farm/RescueFormModal.jsx';
import { dateTime, kg, label, money } from '../../utils/format.js';

export default function Rescue() {
  const { farmId } = useFarm();
  const { isFarmAdmin } = useAuth();
  const toast = useToast();
  const dialog = useDialog();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const listings = useApi(() => api.get('/rescue', { farmId }), [farmId], { enabled: Boolean(farmId) });
  const batches = useApi(() => api.get('/harvests', { farmId }), [farmId], { enabled: Boolean(farmId) && isFarmAdmin });
  const eligible = (batches.data || []).filter((b) => b.unallocatedQuantity > 0);

  const cancel = async (l) => {
    if (!(await dialog.confirm({
      title: 'Cancel this Rescue listing?', tone: 'danger', icon: 'Rescue',
      message: 'Unsold produce returns to the harvest batch. Reservations already made are kept.',
      confirmLabel: 'Cancel listing', cancelLabel: 'Keep listing',
    }))) return;
    try {
      await api.post(`/rescue/${l.id}/cancel`);
      toast('Rescue listing cancelled');
      listings.reload();
      batches.reload();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const campaign = async (l) => {
    try {
      const c = await api.post('/campaigns/generate', { farmId, campaignType: 'RESCUE_ALERT', rescueListingId: l.id });
      navigate(`/farm/campaigns?open=${c.id}`);
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  return (
    <>
      <PageHeader
        title="Tyllage Rescue"
        description="An alternative channel for surplus, short-dated or imperfect produce your farm has judged suitable for sale."
        actions={isFarmAdmin && <button className="btn btn-primary" onClick={() => setCreating(true)} disabled={!eligible.length}><Icons.Plus />Create listing</button>}
      />
      <Notice tone="warning">
        The farm is responsible for deciding whether produce is suitable for sale. Tyllage never declares damaged or imperfect produce safe to eat.
      </Notice>
      <Card tight title="Rescue listings" className="mt-16">
        <AsyncBoundary state={listings}>
          {(rows) =>
            rows.length === 0 ? <EmptyState title="No Rescue listings">Use Demand Recovery to find produce that should move to Rescue.</EmptyState> : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Produce</th><th>Reason</th><th className="num">Listed</th><th className="num">Reserved</th><th className="num">Available</th><th className="num">Original → Rescue</th><th>Collect before</th><th>Status</th><th /></tr></thead>
                  <tbody>
                    {rows.map((l) => (
                      <tr key={l.id}>
                        <td className="cell-title">{l.produceName}<div className="cell-sub">Batch #{l.harvestBatchId}</div></td>
                        <td>{label(l.reason)}{l.reasonDetails && <div className="cell-sub">{l.reasonDetails}</div>}</td>
                        <td className="num">{kg(l.quantity, l.unit)}</td>
                        <td className="num">{kg(l.soldQuantity, l.unit)}</td>
                        <td className="num strong">{kg(l.availableQuantity, l.unit)}</td>
                        <td className="num nowrap"><span className="muted">{money(l.originalPrice)}</span> → {money(l.rescuePrice)}</td>
                        <td className="nowrap">{dateTime(l.collectionDeadline)}</td>
                        <td><StatusBadge status={l.status} /></td>
                        <td className="nowrap">
                          {isFarmAdmin && l.status === 'ACTIVE' && (
                            <>
                              <button className="btn btn-sm" onClick={() => campaign(l)}><Icons.Sparkle />Campaign</button>{' '}
                              <button className="btn btn-sm btn-ghost" onClick={() => cancel(l)}>Cancel</button>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
        </AsyncBoundary>
      </Card>
      {creating && (
        <RescueFormModal
          batches={eligible}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            listings.reload();
            batches.reload();
          }}
        />
      )}
    </>
  );
}
