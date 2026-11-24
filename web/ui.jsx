import { useEffect, useState } from 'preact/hooks';
import { colorClass, groupLabel } from '../shared/rules.js';

// ---------- avisos (toasts) y diálogo de error ----------
const toastListeners = new Set();
let toastId = 0;
export function toast(text, kind = '') {
  const t = { id: ++toastId, text, kind };
  toastListeners.forEach((fn) => fn(t));
}

let errorSetter = null;
let askSetter = null;
/** Diálogo de confirmación propio (los de window.confirm se bloquean en algunos entornos). */
export function ask(text, { input, ok = 'Aceptar' } = {}) {
  return new Promise((resolve) => {
    if (!askSetter) { resolve(input !== undefined ? input : true); return; }
    askSetter({ text, input, ok, resolve });
  });
}
export function showError(e) {
  if (e?.status === 401 && !e.details?.length) { window.dispatchEvent(new Event('vac-logout')); }
  if (errorSetter) errorSetter({ message: e?.message || String(e), details: e?.details || [] });
  else alert(e?.message || e);
}

export function Toasts() {
  const [list, setList] = useState([]);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState(null);
  const [val, setVal] = useState('');
  useEffect(() => {
    askSetter = (x) => { setVal(x.input ?? ''); setQ(x); };
    const fn = (t) => {
      setList((l) => [...l, t]);
      setTimeout(() => setList((l) => l.filter((x) => x.id !== t.id)), 3500);
    };
    toastListeners.add(fn);
    errorSetter = setErr;
    return () => { toastListeners.delete(fn); errorSetter = null; askSetter = null; };
  }, []);
  return (
    <>
      <div class="toasts">{list.map((t) => <div key={t.id} class={`toast ${t.kind}`}>{t.text}</div>)}</div>
      {q && (
        <Modal title="Confirmar" onClose={() => { q.resolve(q.input !== undefined ? null : false); setQ(null); }}
          footer={<><button class="btn" onClick={() => { q.resolve(q.input !== undefined ? null : false); setQ(null); }}>Cancelar</button>
            <button class="btn primary" onClick={() => { q.resolve(q.input !== undefined ? val : true); setQ(null); }}>{q.ok}</button></>}>
          <div>{q.text}</div>
          {q.input !== undefined && <input class="input" value={val} onInput={(e) => setVal(e.currentTarget.value)} autoFocus />}
        </Modal>
      )}
      {err && (
        <Modal title="No se ha podido completar" onClose={() => setErr(null)} footer={<button class="btn primary" onClick={() => setErr(null)}>Entendido</button>}>
          <Alert kind="bad" title={err.message} items={err.details} />
        </Modal>
      )}
    </>
  );
}

/** Ejecuta una acción mostrando el error de forma clara si falla. */
export async function run(fn, okText) {
  try {
    const r = await fn();
    if (okText) toast(okText, 'ok');
    return r ?? true;
  } catch (e) {
    showError(e);
    return null;
  }
}

// ---------- piezas de interfaz ----------
export function Modal({ title, onClose, children, footer, wide }) {
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div class="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div class={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <div class="modal-head">
          <h2>{title}</h2>
          <span class="spacer" />
          <button class="icon-btn" aria-label="Cerrar" onClick={onClose}>✕</button>
        </div>
        <div class="modal-body">{children}</div>
        {footer && <div class="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Alert({ kind = 'info', title, items = [], children }) {
  const icon = { bad: '⛔', ok: '✅', warn: '⚠️', info: 'ℹ️' }[kind];
  return (
    <div class={`alert ${kind}`}>
      <span>{icon}</span>
      <div>
        {title && <b>{title}</b>}
        {children}
        {items.length > 0 && <ul>{items.map((t, i) => <li key={i}>{t}</li>)}</ul>}
      </div>
    </div>
  );
}

export function Stat({ label, value, hint, color }) {
  return (
    <div class="stat">
      <div class="l">{label}</div>
      <div class="v" style={color ? { color } : null}>{value}</div>
      {hint && <div class="small muted">{hint}</div>}
    </div>
  );
}

export function GroupDot({ team, shift }) {
  return <span class={`dot ${colorClass(team, shift)}`} title={groupLabel(team, shift)} />;
}

export function Legend() {
  return (
    <div class="legend">
      <span><i class="dot c-cocina" /> Cocina</span>
      <span><i class="dot c-sala-m" /> Camareros mañana</span>
      <span><i class="dot c-sala-t" /> Camareros tarde</span>
      <span><i class="dot" style="background:var(--bad)" /> Falta personal</span>
      <span><i class="dot" style="background:var(--warn)" /> Al límite</span>
    </div>
  );
}

export const STATUS_LABELS = {
  pendiente: ['Pendiente de aprobar', 'warn'],
  esperando_companero: ['Esperando al compañero', 'info'],
  aprobada: ['Aprobada', 'ok'],
  rechazada: ['Rechazada', 'bad'],
  anulada: ['Anulada', ''],
};

export function StatusBadge({ status }) {
  const [t, k] = STATUS_LABELS[status] || [status, ''];
  return <span class={`badge ${k}`}>{t}</span>;
}

export function Field({ label, children }) {
  return <label class="field">{label}{children}</label>;
}

export function Progress({ parts }) {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  return (
    <div class="progress">{parts.map((p, i) => <div key={i} style={{ width: `${(p.value / Math.max(total, p.max || 0)) * 100}%`, background: p.color }} />)}</div>
  );
}

/** Campo de contraseña con botón para mostrarla u ocultarla. */
export function PasswordInput({ value, onInput, autoComplete, id }) {
  const [show, setShow] = useState(false);
  return (
    <span class="pw-wrap">
      <input class="input" id={id} type={show ? 'text' : 'password'} autoComplete={autoComplete} autoCapitalize="none" autoCorrect="off" spellcheck={false} value={value} onInput={onInput} />
      <button type="button" class="pw-eye" aria-label={show ? 'Ocultar contraseña' : 'Mostrar contraseña'} title={show ? 'Ocultar contraseña' : 'Mostrar contraseña'} onClick={() => setShow(!show)}>{show ? '🙈' : '👁'}</button>
    </span>
  );
}
