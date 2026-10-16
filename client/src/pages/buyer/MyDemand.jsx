import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../services/api.js';
import { useApi } from '../../hooks/useApi.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useDialog } from '../../context/DialogContext.jsx';
import { PageHeader, Card, AsyncBoundary, EmptyState, Badge } from '../../components/ui.jsx';
import { StatusBadge } from '../../components/domain.jsx';
import { Icons } from '../../components/Icons.jsx';
import { kg, money, date, relativeDay, label } from '../../utils/format.js';
import { RegisterDemandModal, OPEN_DEMAND } from './demandShared.jsx';

export default function MyDemand() {
  const toast = useToast();
  const dialog = useDialog();
  const state = useApi(() => api.get('/demand'), []);
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState(params.get('new') === '1');
  const [busyId, setBusyId] = useState(null);

  const close = () => {
    setOpen(false);
    if (params.has('new')) setParams({}, { replace: true });
  };

  const cancel = async (d) => {
    if (!(await dialog.confirm({
      title: `Cancel your ${d.produceName} request?`, tone: 'danger', icon: 'Demand',
      message: `Farms will stop matching harvest to your request for ${kg(d.quantity, d.unit)} ${d.produceName}.`,
      confirmLabel: 'Cancel request', cancelLabel: 'Keep request',
    }))) return;
    setBusyId(d.id);
    try {
      await api.post(`/demand/${d.id}/cancel`);
      toast('Demand cancelled');
      state.reload();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusyId(null);
    }
  };

  const registerBtn = <button className="btn btn-primary" onClick={() => setOpen(true)}><Icons.Plus width={16} /> Register demand</button>;

  return (
    <>
      <PageHeader
        title="My demand"
        description="What your business needs and when. Farms review demand through HarvestMatch and confirm what they can supply."
        actions={registerBtn}
      />
      <AsyncBoundary state={state}>
        {(rows) => (
          <Card tight>
            {rows.length === 0 ? (
              <EmptyState title="No demand registered" action={registerBtn}>
                Register recurring or one-off demand so farms can plan harvests around it.
              </EmptyState>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Produce</th>
                      <th>Farm</th>
                      <th className="num">Quantity</th>
                      <th className="num">Fulfilled / remaining</th>
                      <th>Required</th>
                      <th className="num">Max price</th>
                      <th>Recurrence</th>
                      <th>Status</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((d) => (
                      <tr key={d.id}>
                        <td>
                          <div className="cell-title">{d.produceName}</div>
                          {d.notes && <div className="cell-sub">{d.notes}</div>}
                        </td>
                        <td>
                          <div>{d.farmName || <span className="muted">Any farm</span>}</div>
                          {(d.allowPooling || Number(d.supplyingFarms) > 1) && (
                            <div className="row mt-8">
                              {d.allowPooling && <Badge tone="primary">FarmPool</Badge>}
                              {Number(d.supplyingFarms) > 1 && <span className="cell-sub">Supplied by {Number(d.supplyingFarms)} farms</span>}
                            </div>
                          )}
                        </td>
                        <td className="num">
                          <div>{kg(d.quantity, d.unit)}</div>
                          {Number(d.minQuantity) > 0 && <div className="cell-sub">Min delivery {kg(d.minQuantity, d.unit)}</div>}
                        </td>
                        <td className="num">{kg(d.fulfilledQuantity, d.unit)} / {kg(d.remainingQuantity, d.unit)}</td>
                        <td>
                          <div>{date(d.requiredDate)}</div>
                          <div className="cell-sub">{relativeDay(d.requiredDate)}</div>
                        </td>
                        <td className="num">{d.maxPrice ? money(d.maxPrice) : '—'}</td>
                        <td>{d.recurrence === 'NONE' ? 'One-off' : label(d.recurrence)}</td>
                        <td><StatusBadge status={d.status} /></td>
                        <td className="num">
                          {OPEN_DEMAND.includes(d.status) && (
                            <button className="btn btn-danger btn-sm" disabled={busyId === d.id} onClick={() => cancel(d)}>Cancel</button>
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
      {open && <RegisterDemandModal onClose={close} onDone={state.reload} />}
    </>
  );
}
