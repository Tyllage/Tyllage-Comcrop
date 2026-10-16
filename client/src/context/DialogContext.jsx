import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Icons } from '../components/Icons.jsx';

/**
 * Themed replacement for window.confirm / window.prompt.
 *   const dialog = useDialog();
 *   if (!(await dialog.confirm({ title, message, confirmLabel, tone: 'danger' }))) return;
 *   const reason = await dialog.prompt({ title, message, inputLabel, required: true }); // null when cancelled
 * tone: 'primary' (default) | 'warning' | 'danger'. icon: any key of Icons.
 */
const DialogContext = createContext(null);

const DEFAULT_ICON = { primary: 'Sprout', warning: 'Alert', danger: 'Alert' };

function Dialog({ options, onDone }) {
  const { title, message, confirmLabel = 'Confirm', cancelLabel = 'Go back', tone = 'primary', icon,
    input, inputLabel = 'Reason', placeholder = '', required = false, defaultValue = '' } = options;
  const [value, setValue] = useState(defaultValue);
  const field = useRef(null);
  const confirmBtn = useRef(null);
  const Icon = Icons[icon || DEFAULT_ICON[tone]] || Icons.Sprout;

  useEffect(() => {
    (input ? field : confirmBtn).current?.focus();
    const onKey = (e) => e.key === 'Escape' && onDone(input ? null : false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [input, onDone]);

  const submit = (e) => {
    e.preventDefault();
    if (input && required && !value.trim()) return field.current?.focus();
    onDone(input ? value.trim() : true);
  };

  return (
    <div className="modal-backdrop dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onDone(input ? null : false)}>
      <form className={`modal dialog dialog-${tone}`} role="alertdialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-message" onSubmit={submit}>
        <div className="dialog-body">
          <div className="dialog-icon" aria-hidden="true"><Icon width={22} height={22} /></div>
          <div className="dialog-text">
            <h2 id="dialog-title">{title}</h2>
            {message && <div id="dialog-message" className="dialog-message">{message}</div>}
            {input && (
              <label className="field dialog-field">
                <span>{inputLabel}{!required && <span className="muted"> (optional)</span>}</span>
                <textarea ref={field} className="input" rows={3} maxLength={500} value={value} placeholder={placeholder}
                  onChange={(e) => setValue(e.target.value)} required={required}
                  onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && submit(e)} />
              </label>
            )}
          </div>
        </div>
        <div className="dialog-footer">
          <button type="button" className="btn" onClick={() => onDone(input ? null : false)}>{cancelLabel}</button>
          <button ref={confirmBtn} type="submit" className={`btn ${tone === 'danger' ? 'btn-danger-solid' : 'btn-primary'}`}
            disabled={input && required && !value.trim()}>{confirmLabel}</button>
        </div>
      </form>
    </div>
  );
}

export function DialogProvider({ children }) {
  const [current, setCurrent] = useState(null);
  const pending = useRef(null);
  const lastFocus = useRef(null);
  const seq = useRef(0);

  const done = useCallback((result) => {
    const resolve = pending.current?.resolve;
    pending.current = null;
    setCurrent(null);
    resolve?.(result);
    lastFocus.current?.focus?.();
  }, []);

  const open = useCallback((options) => new Promise((resolve) => {
    // A newer dialog replaces an unanswered one, which counts as cancelled.
    if (pending.current) pending.current.resolve(pending.current.input ? null : false);
    pending.current = { resolve, input: Boolean(options.input) };
    lastFocus.current = document.activeElement;
    seq.current += 1;
    setCurrent({ id: seq.current, options });
  }), []);

  const api = useRef({
    confirm: (options) => open(options),
    prompt: (options) => open({ ...options, input: true }),
  }).current;

  return (
    <DialogContext.Provider value={api}>
      {children}
      {current && <Dialog key={current.id} options={current.options} onDone={done} />}
    </DialogContext.Provider>
  );
}

export const useDialog = () => useContext(DialogContext);
