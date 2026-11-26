// Versión publicada con datos compartidos: la lógica corre en el servidor de Supabase
// (Edge Function "api") y todos ven el mismo calendario.
import { setTransport } from './api.js';
import { start } from './main.jsx';

const URL_API = __CLOUD_API__;
const KEY = __CLOUD_KEY__;
const TOKEN = 'vacaciones-bar-sesion';
const store = {
  get() { try { return localStorage.getItem(TOKEN); } catch { return null; } },
  set(v) { try { localStorage.setItem(TOKEN, v); } catch { /* */ } },
  del() { try { localStorage.removeItem(TOKEN); } catch { /* */ } },
};

setTransport(async (action, params) => {
  const tok = store.get();
  if (action === 'me' && !tok) { const e = new Error('Sin sesión'); e.status = 401; throw e; }
  let res;
  try {
    res = await fetch(`${URL_API}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: KEY, ...(tok ? { 'x-session': tok } : {}) },
      body: JSON.stringify(params || {}),
    });
  } catch {
    throw new Error('No hay conexión con el servidor. Revisa internet y vuelve a intentarlo.');
  }
  const json = await res.json().catch(() => ({ error: 'El servidor no responde correctamente.' }));
  if (!res.ok) {
    if (res.status === 401 && action !== 'login') { store.del(); if (action !== 'me') window.dispatchEvent(new Event('vac-logout')); }
    const e = new Error(json.error || 'Error'); e.status = res.status; e.details = json.details || []; throw e;
  }
  if (action === 'login') { store.set(json.token); return { user: json.user }; }
  if (action === 'logout') store.del();
  return json;
}, { emailLogin: true, noDownloads: false });

start();
