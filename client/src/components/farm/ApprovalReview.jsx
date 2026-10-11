import { useState } from 'react';
import { Modal } from '../ui.jsx';
import { date, kg, money, FULFILMENT_TERMS } from '../../utils/format.js';

/** The server calculates this estimate for the quantity the farmer is about to approve. */
export default function ApprovalReview({ review, busy, onClose, onApprove }) {
  const [reason, setReason] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const margin = review.netMargin;
  const canApprove = !review.requiresMarginOverride || (acknowledged && reason.trim().length >= 10);
  return (
    <Modal title="Review allocation" onClose={busy ? undefined : onClose}
      footer={<>
        <button className="btn" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !canApprove} onClick={() => onApprove(reason.trim())}>
          {busy ? 'Approving…' : 'Approve allocation'}
        </button>
      </>}>
      <div className="stack">
        <p><strong>{review.buyerName}</strong><br />{kg(review.quantity, review.unit)} of {review.produceName} for {date(review.scheduledDate)}</p>
        <dl className="approval-estimate">
          <div><dt>Selling price</dt><dd>{money(review.unitPrice)}/{review.unit}</dd></div>
          <div><dt>Gross revenue</dt><dd>{money(review.revenue)}</dd></div>
          <div><dt>Estimated fulfilment</dt><dd>{money(review.fulfilment.total)}</dd></div>
          <div><dt>Fulfilment method</dt><dd>{FULFILMENT_TERMS[review.fulfilment.method]}</dd></div>
          <div className="approval-total"><dt>Estimated net contribution</dt><dd>{margin.known ? money(margin.total) : 'Cost not recorded'}</dd></div>
        </dl>
        <p className="small muted">Net contribution deducts recorded production cost and estimated fulfilment cost from revenue. It is an estimate for this allocation.</p>
        {review.warnings.length > 0 && <ul className="reason-list">{review.warnings.map((w) => <li key={w} className="warn">{w}</li>)}</ul>}
        {review.requiresMarginOverride && <div className="notice notice-warning approval-warning">
          <strong>Below your farm's margin target</strong>
          <p>{margin.message}</p>
          <label className="field" htmlFor="margin-override-reason">Reason for accepting this margin
            <textarea id="margin-override-reason" className="input" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example, recovering value from surplus stock" />
            <span className="hint">At least 10 characters. This reason is recorded in the farm audit log.</span>
          </label>
          <label className="approval-acknowledgement"><input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
            I have reviewed this estimate and accept the lower margin.
          </label>
        </div>}
      </div>
    </Modal>
  );
}
