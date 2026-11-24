// Versión de demostración: toda la lógica del servidor se ejecuta en el navegador y los
// datos se guardan en este navegador (localStorage). Sirve para probar la aplicación sin
// instalar nada. Las reglas y el generador son exactamente los mismos que en el servidor.
import { setTransport } from './api.js';
import { createService, ApiError } from '../shared/service.js';
import { createMemoryRepo } from '../shared/memrepo.js';
import { start } from './main.jsx';

const KEY = 'vacaciones-bar-demo-v1';
const TOKEN = 'vacaciones-bar-demo-token';
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento: los datos duran hasta cerrar */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* */ } },
};

const repo = createMemoryRepo({
  load: () => { const s = store.get(KEY); return s ? JSON.parse(s) : null; },
  save: (state) => store.set(KEY, JSON.stringify(state)),
});
const service = createService({
  repo,
  hashPassword: (p) => `demo:${p}`,
  verifyPassword: (p, h) => h === `demo:${p}`,
  randomToken: () => Math.random().toString(36).slice(2) + Date.now().toString(36),
});
service.seed({ adminPassword: 'admin', workerPassword: '1234' });

const demoUsers = [{ username: 'admin', password: 'admin', label: 'Administrador' }];
for (const u of repo.all('users', { role: 'worker' })) {
  const w = repo.get('workers', u.worker_id);
  demoUsers.push({ username: u.username, password: '1234', label: w ? w.first_name : u.username });
}

setTransport(async (action, params) => {
  await new Promise((r) => setTimeout(r, 0));
  try {
    const token = store.get(TOKEN);
    const res = service.call(token, action, params ? JSON.parse(JSON.stringify(params)) : {});
    if (action === 'login') { store.set(TOKEN, res.token); return { user: res.user }; }
    if (action === 'logout') store.del(TOKEN);
    return JSON.parse(JSON.stringify(res ?? { ok: true }));
  } catch (e) {
    if (e instanceof ApiError) { const x = new Error(e.message); x.status = e.status; x.details = e.details; throw x; }
    throw e;
  }
}, { demo: true, demoUsers });

window.resetDemo = () => { store.del(KEY); store.del(TOKEN); location.reload(); };
start();
