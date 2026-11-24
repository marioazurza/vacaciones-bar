// Comunicación con el servidor. La versión de demostración cambia el "transporte" para
// ejecutar la misma lógica dentro del navegador.

let transport = async (action, params) => {
  const res = await fetch(`/api/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(params || {}),
  });
  const json = await res.json().catch(() => ({ error: 'El servidor no responde correctamente.' }));
  if (!res.ok) {
    const e = new Error(json.error || 'Error');
    e.status = res.status;
    e.details = json.details || [];
    throw e;
  }
  return json;
};

export const runtime = { demo: false, demoUsers: [] };

export function setTransport(fn, opts = {}) {
  transport = fn;
  Object.assign(runtime, opts);
}

const listeners = new Set();
export function onSaved(fn) { listeners.add(fn); return () => listeners.delete(fn); }

const READ_ONLY = new Set(['getYear', 'listYears', 'me', 'listNotifications', 'listHistory', 'generate']);

export async function api(action, params) {
  const r = await transport(action, params);
  if (!READ_ONLY.has(action) && action !== 'login' && action !== 'logout') listeners.forEach((fn) => fn(new Date()));
  return r;
}
