// Servidor en Supabase (Edge Function "api"). Toda la lógica es la misma que la de la app:
// el estado completo (unos pocos KB) se guarda en una fila JSON de la tabla app_state y
// cada petición lo lee bloqueado, ejecuta la acción y lo vuelve a guardar si cambió.
import postgres from 'npm:postgres@3.4.5';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { createService, ApiError } from '../shared/service.js';
import { createMemoryRepo } from '../shared/memrepo.js';

const sql = postgres(Deno.env.get('SUPABASE_DB_URL'), { prepare: false, max: 1 });
const ALLOWED = ['https://marioazurza.github.io', 'http://localhost:3912'];

function hashPassword(pw) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${scryptSync(pw, salt, 32).toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [kind, salt, hex] = String(stored || '').split(':');
  if (kind !== 'scrypt' || !salt || !hex) return false;
  const a = scryptSync(pw, salt, 32), b = Buffer.from(hex, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
const madridToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());

function cors(req) {
  const o = req.headers.get('origin') || '';
  return {
    'Access-Control-Allow-Origin': ALLOWED.includes(o) ? o : ALLOWED[0],
    'Access-Control-Allow-Headers': 'content-type, x-session, apikey, authorization, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

Deno.serve(async (req) => {
  const h = cors(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...h, 'Content-Type': 'application/json' } });
  if (req.method !== 'POST') return json({ error: 'Método no permitido.' }, 405);
  const action = new URL(req.url).pathname.split('/').filter(Boolean).pop();
  let params = {};
  try { params = await req.json(); } catch { /* sin cuerpo */ }
  const token = req.headers.get('x-session') || null;
  try {
    const result = await sql.begin(async (tx) => {
      const rows = await tx`select data from app_state where id = 1 for update`;
      let state = rows.length ? rows[0].data : null;
      const before = rows.length ? JSON.stringify(state) : '';
      const repo = createMemoryRepo({ load: () => state, save: (s) => { state = s; } });
      const service = createService({ repo, hashPassword, verifyPassword, randomToken: () => randomBytes(32).toString('hex'), today: madridToday });
      const adminPw = Deno.env.get('ADMIN_PASSWORD');
      const adminUser = (Deno.env.get('ADMIN_USERNAME') || 'ignacio').toLowerCase();
      if (!rows.length) service.seed({ adminUsername: adminUser, adminPassword: adminPw || randomBytes(18).toString('hex'), workerPassword: randomBytes(18).toString('hex') });
      // Si se cambia la contraseña del administrador en los secretos de Supabase, se aplica aquí.
      if (adminPw) for (const u of repo.all('users', { role: 'admin' })) if (!verifyPassword(adminPw, u.password_hash)) repo.update('users', u.id, { password_hash: hashPassword(adminPw) });
      // Las sesiones caducan a los 180 días.
      const limit = new Date(Date.now() - 180 * 864e5).toISOString();
      for (const s of repo.all('sessions')) if (s.created_at && s.created_at < limit) repo.remove('sessions', s.id);
      let res, err = null;
      try { res = service.call(token, action, params); } catch (e) { err = e; }
      const after = JSON.stringify(state);
      if (after !== before) await tx`insert into app_state (id, data, updated_at) values (1, ${tx.json(state)}, now()) on conflict (id) do update set data = excluded.data, updated_at = now()`;
      if (err) throw err;
      return res ?? { ok: true };
    });
    return json(result);
  } catch (e) {
    if (e instanceof ApiError) return json({ error: e.message, details: e.details || [] }, e.status || 400);
    console.error(e);
    return json({ error: 'Error del servidor. Vuelve a intentarlo.' }, 500);
  }
});
