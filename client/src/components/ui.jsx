import { useEffect } from 'react';
import { Icons } from './Icons.jsx';
import StatusPage from './StatusPage.jsx';

export function PageHeader({ title, description, actions }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function Card({ title, description, actions, children, tight, className = '' }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-header">
          <div>
            {title && <h2>{title}</h2>}
            {description && <p>{description}</p>}
          </div>
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      <div className={`card-body ${tight ? 'tight' : ''}`}>{children}</div>
    </section>
  );
}

export function KpiCard({ label, value, sub, tone = 'neutral', icon }) {
  return (
    <div className={`card kpi tone-${tone}`}>
      <div className="kpi-label">
        {icon}
        {label}
      </div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

export function Badge({ children, tone, dot, className }) {
  return <span className={`badge ${tone ? `badge-${tone}` : ''} ${dot ? 'badge-dot' : ''} ${className || ''}`}>{children}</span>;
}

export function Loading({ label = 'Loading…' }) {
  return (
    <div className="loading">
      <div className="spinner" />
      {label}
    </div>
  );
}

export function ErrorState({ error, onRetry }) {
  return (
    <div className="notice notice-danger">
      <Icons.Alert width={18} />
      <div>
        <div className="strong">Something went wrong</div>
        <div>{error?.message || 'Unable to load data.'}</div>
        {onRetry && (
          <button className="btn btn-sm mt-8" onClick={onRetry}>
            Try again
          </button>
        )}
      </div>
    </div>
  );
}

export function EmptyState({ title, children, action }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

/** Wraps async page data: loading → error (as an HTTP status page) → content. */
export function AsyncBoundary({ state, children, loadingLabel }) {
  if (state.loading && !state.data) return <Loading label={loadingLabel} />;
  if (state.error && !state.data) {
    // status 0 = network failure: present it as 503 (service unreachable).
    const code = state.error.status >= 400 ? state.error.status : 503;
    return <StatusPage inline code={code} detail={state.error.message} onRetry={state.reload} />;
  }
  if (!state.data) return null;
  return children(state.data);
}

export function Modal({ title, onClose, children, footer, wide }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
            <Icons.X />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, hint, error, children, full }) {
  return (
    <div className={`field ${full ? 'full' : ''}`}>
      {label && <label>{label}</label>}
      {children}
      {hint && !error && <span className="hint">{hint}</span>}
      {error && <span className="error">{error}</span>}
    </div>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={value === t.value} className={`tab ${value === t.value ? 'active' : ''}`} onClick={() => onChange(t.value)}>
          {t.label}
          {t.count !== undefined && <span className="badge" style={{ marginLeft: 6 }}>{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function FilterChips({ options, value, onChange }) {
  return (
    <div className="filters">
      {options.map((o) => (
        <button key={o.value} className={`chip ${value === o.value ? 'active' : ''}`} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Notice({ tone = 'info', children }) {
  return <div className={`notice notice-${tone}`}>{children}</div>;
}

/** Returns field-level errors from an ApiError (VALIDATION_ERROR details) keyed by field. */
export function fieldErrors(err) {
  if (!err?.details) return {};
  return Object.fromEntries(err.details.map((d) => [d.field, d.message]));
}
