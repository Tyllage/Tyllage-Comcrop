import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../services/api.js';
import { useApi } from '../../hooks/useApi.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useDialog } from '../../context/DialogContext.jsx';
import { PageHeader, Card, AsyncBoundary, EmptyState, Badge } from '../../components/ui.jsx';
import { StatusBadge } from '../../components/domain.jsx';
import { Icons } from '../../components/Icons.jsx';
import { kg, date, relativeDay, label } from '../../utils/format.js';
import { RegisterDemandModal, OPEN_DEMAND } from '../buyer/demandShared.jsx';

export default function MyInterests() {
  const toast = useToast();
  const dialog = useDialog();
  const state = useApi(() => api.get('/demand'), []);
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const cancel = async (d) => {
    if (!(await dialog.confirm({
      title: `Remove your interest in ${d.produceName}?`, tone: 'danger', icon: 'Heart',
      message: 'Farms will no longer let you know when it is ready to harvest.',
      confirmLabel: 'Remove', cancelLabel: 'Keep it',
    }))) return;
    setBusyId(d.id);
    try {
      await api.post(`/demand/${d.id}/cancel`);
      toast('Interest removed');
      state.reload();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusyId(null);
    }
  };

  const addBtn = <button className="btn btn-primary" onClick={() => setOpen(true)}><Icons.Plus width={16} /> Add interest</button>;

  return (
    <>
      <PageHeader
        title="My interests"
        description="Produce you'd like from local farms. Farms use interest to plan harvests and will confirm when they can supply."
        actions={addBtn}
      />
      <AsyncBoundary state={state}>
        {(rows) => (
          <Card tight>
            {rows.length === 0 ? (
              <EmptyState title="No interests yet" action={<Link className="btn btn-sm" to="/consumer/growing">See what&apos;s growing soon</Link>}>
                Register interest in upcoming harvests, or add any produce you would like local farms to grow.
              </EmptyState>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Produce</th>
                      <th>Farm</th>
                      <th className="num">Quantity</th>
                      <th>Wanted by</th>
                      <th>Status</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((d) => (
                      <tr key={d.id}>
                        <td>
                          <div className="cell-title">{d.produceName}</div>
                          {d.recurrence !== 'NONE' && <div className="cell-sub">Repeats {label(d.recurrence).toLowerCase()}</div>}
                        </td>
                        <td>
                          <div>{d.farmName || <span className="muted">Any farm</span>}</div>
                          {d.allowPooling && <div className="mt-8"><Badge tone="primary">FarmPool</Badge></div>}
                          {Number(d.supplyingFarms) > 1 && <div className="cell-sub">Supplied by {Number(d.supplyingFarms)} farms</div>}
                        </td>
                        <td className="num">
                          <div>{kg(d.quantity, d.unit)}</div>
                          {Number(d.fulfilledQuantity) > 0 && <div className="cell-sub">{kg(d.fulfilledQuantity, d.unit)} fulfilled</div>}
                        </td>
                        <td>
                          <div>{date(d.requiredDate)}</div>
                          <div className="cell-sub">{relativeDay(d.requiredDate)}</div>
                        </td>
                        <td><StatusBadge status={d.status} /></td>
                        <td className="num">
                          {OPEN_DEMAND.includes(d.status) && (
                            <button className="btn btn-ghost btn-sm" disabled={busyId === d.id} onClick={() => cancel(d)}>Remove</button>
                          )}
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
      {open && <RegisterDemandModal consumer onClose={() => setOpen(false)} onDone={state.reload} />}
    </>
  );
}
