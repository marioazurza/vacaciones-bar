// Versión de demostración: toda la lógica del servidor se ejecuta en el navegador y los
// datos se guardan en este navegador (localStorage). Sirve para probar la aplicación sin
// instalar nada. Las reglas y el generador son exactamente los mismos que en el servidor.
import { setTransport } from './api.js';
import { createService, ApiError } from '../shared/service.js';
import { createMemoryRepo } from '../shared/memrepo.js';
import { start } from './main.jsx';

const KEY = 'vacaciones-bar-demo-v10';
const TOKEN = 'vacaciones-bar-demo-token-v4';
// Si el navegador no deja guardar (ventana privada, visor incrustado...), se usa memoria:
// todo funciona igual, pero los datos se pierden al cerrar la página.
const mem = new Map();
const store = {
  get(k) { try { const v = localStorage.getItem(k); if (v != null) return v; } catch { /* */ } return mem.has(k) ? mem.get(k) : null; },
  set(k, v) { mem.set(k, v); try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
  del(k) { mem.delete(k); try { localStorage.removeItem(k); } catch { /* */ } },
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
// Administrador de la versión de prueba.
// Se fijan al compilar: DEMO_ADMIN_USER y DEMO_ADMIN_PASSWORD (por defecto admin / admin).
const ADMIN = { username: __DEMO_ADMIN_USER__, password: __DEMO_ADMIN_PASSWORD__ };
service.seed({ adminUsername: ADMIN.username, adminPassword: ADMIN.password, workerPassword: '1234' });
// Datos de prueba creados antes con el usuario "admin": se renombra sin perder nada.
repo.tx(() => {
  for (const u of repo.all('users', { role: 'admin' })) {
    if (u.username === 'admin' && ADMIN.username !== 'admin') {
      repo.update('users', u.id, { username: ADMIN.username, password_hash: `demo:${ADMIN.password}` });
      repo.removeWhere('sessions', { user_id: u.id });
    }
  }
});

const demoUsers = [];
for (const u of repo.all('users', { role: 'worker' })) {
  const w = repo.get('workers', u.worker_id);
  demoUsers.push({ username: u.username, password: '1234', label: w ? w.first_name : u.username });
}

setTransport(async (action, params) => {
  await new Promise((r) => setTimeout(r, 0));
  try {
    // Sin pantalla de acceso (de momento): se entra directamente como administrador.
    if (!service.userFromToken(store.get(TOKEN))) store.set(TOKEN, service.call(null, 'login', ADMIN).token);
    const token = store.get(TOKEN);
    if (action === 'logout') return { ok: true };
    const res = service.call(token, action, params ? JSON.parse(JSON.stringify(params)) : {});
    if (action === 'login') { store.set(TOKEN, res.token); return { user: res.user }; }
    if (action === 'logout') store.del(TOKEN);
    return JSON.parse(JSON.stringify(res ?? { ok: true }));
  } catch (e) {
    if (e instanceof ApiError) { const x = new Error(e.message); x.status = e.status; x.details = e.details; throw x; }
    throw e;
  }
}, { demo: true, noLogin: true, demoUsers, noDownloads: window.self !== window.top });

window.resetDemo = () => { store.del(KEY); store.del(TOKEN); location.reload(); };
start();
