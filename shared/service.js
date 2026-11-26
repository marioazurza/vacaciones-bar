// Lógica de negocio de la aplicación. No depende del servidor ni del navegador: recibe un
// "repo" (acceso a datos) y expone call(token, acción, parámetros). El servidor la usa con
// SQLite; la versión de demostración la usa con un almacén en el navegador.
//
// Regla de oro: cualquier cambio que deje a algún turno por debajo del mínimo se rechaza,
// también si lo hace el administrador.

import {
  DEFAULT_MINIMUMS, DEFAULT_ANNUAL_DAYS, DEFAULT_MAX_OFF_PER_SHIFT, NO_MINIMUMS, TEAMS, SHIFTS, analyze, newIssues, describeIssue,
  checkPeriodShape, normalizeMinimums, groupLabel,
} from './rules.js';
import { generateProposal, generateRotation, DEFAULT_GENERATOR_SETTINGS } from './generator.js';
import { formatRange, overlaps, periodLength, todayISO, isISODate, addDays } from './dates.js';

export const DEFAULT_PERIOD_RULES = { periodLength: 15, maxOffPerShift: DEFAULT_MAX_OFF_PER_SHIFT, wholeTeam: ['sala', 'cocina'], maxOffPerShiftAll: 1 };

export class ApiError extends Error {
  constructor(status, message, details = []) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// Trabajadores de ejemplo (los usan las pruebas).
export const EXAMPLE_WORKERS = [
  ['Lucía', 'Martín Ortega', 'cocina', 'M'],
  ['Javier', 'Ruiz Delgado', 'cocina', 'M'],
  ['Carmen', 'Navarro Gil', 'cocina', 'T'],
  ['Andrés', 'Molina Vega', 'cocina', 'T'],
  ['Marta', 'Sánchez Romero', 'sala', 'M'],
  ['Pablo', 'García Torres', 'sala', 'M'],
  ['Elena', 'Fernández Cano', 'sala', 'M'],
  ['Sergio', 'López Prieto', 'sala', 'M'],
  ['Laura', 'Jiménez Serrano', 'sala', 'T'],
  ['Diego', 'Moreno Castillo', 'sala', 'T'],
  ['Nuria', 'Álvarez Rubio', 'sala', 'T'],
  ['Raúl', 'Iglesias Peña', 'sala', 'T'],
];

// Vacaciones ya pedidas para el año que se planifica (mes-día).
const BAR_REQUESTED = [
  ['Naima', '03-01', '03-15', 'Pedido por Naima: marzo'],
  ['Naima', '03-16', '03-30', 'Pedido por Naima: marzo'],
  ['Josué', '01-01', '01-15', 'Pedido por Josué: primera quincena de enero'],
];

// Plantilla real del bar.
export const BAR_WORKERS = [
  ['Naima', 'Rija', 'cocina', 'M'],
  ['Marco Antonio', 'Vega García', 'cocina', 'M'],
  ['Diego', 'Céspedes Rodríguez', 'cocina', 'T'],
  ['Josué', 'Castillo Ramírez', 'cocina', 'T'],
  ['Amaia', 'Huegun Brocal', 'sala', 'M'],
  ['Tania', 'Halyuk', 'sala', 'M'],
  ['Gemma', 'Martínez Uria', 'sala', 'M'],
  ['Lasha', 'Kabzinadze', 'sala', 'M'], // mixto: mañanas de miércoles y jueves, tarde del martes
  ['Edar', 'Centeno González', 'sala', 'T'],
  ['Gerardo', 'Intriago Mero', 'sala', 'T'],
  ['Ayman', 'Rija', 'sala', 'T'],
];

const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');

export function createService({ repo, hashPassword, verifyPassword, randomToken, now = () => new Date().toISOString(), today = todayISO }) {
  // ---------- utilidades de datos ----------
  const setting = (key, fallback) => {
    const row = repo.all('settings', { key })[0];
    return row ? row.value : fallback;
  };
  const setSetting = (key, value) => {
    const row = repo.all('settings', { key })[0];
    if (row) repo.update('settings', row.id, { value }); else repo.insert('settings', { key, value });
  };
  const minimums = () => normalizeMinimums(setting('minimums', DEFAULT_MINIMUMS));
  const generatorSettings = () => ({ ...DEFAULT_GENERATOR_SETTINGS, ...setting('generator', {}) });
  // Duración fija de cada periodo de vacaciones (0 = libre).
  const periodRules = () => ({ ...DEFAULT_PERIOD_RULES, ...setting('periods', {}) });

  const workerName = (w) => (w ? `${w.first_name} ${w.last_name}`.trim() : 'Trabajador eliminado');
  const workersById = () => new Map(repo.all('workers').map((w) => [w.id, w]));
  const nameOfFn = () => { const m = workersById(); return (id) => workerName(m.get(id)); };

  const yearRow = (year) => repo.all('years', { year })[0];
  const requireYear = (year) => {
    const y = yearRow(Number(year));
    if (!y) throw new ApiError(404, `El año ${year} no existe todavía.`);
    return y;
  };

  function ctxFor(year, over = {}) {
    const wmap = workersById();
    const staff = (over.staff ?? repo.all('staff', { year })).map((s) => ({ ...s, name: workerName(wmap.get(s.worker_id)) }));
    return {
      year,
      staff,
      vacations: over.vacations ?? repo.all('vacations', { year }),
      minimums: over.minimums ?? minimums(),
      reinforcements: over.reinforcements ?? repo.all('reinforcements'),
      blocked: over.blocked ?? repo.all('blocked', { year }),
      maxOffPerShift: over.maxOffPerShift !== undefined ? over.maxOffPerShift : periodRules().maxOffPerShift,
      wholeTeam: over.wholeTeam ?? periodRules().wholeTeam ?? [],
      maxOffPerShiftAll: over.maxOffPerShiftAll !== undefined ? over.maxOffPerShiftAll : periodRules().maxOffPerShiftAll ?? null,
    };
  }

  /** Lanza un error explicativo si el cambio provoca conflictos nuevos. */
  function guard(year, over, intro = 'No se puede guardar el cambio porque') {
    const before = analyze(ctxFor(year)).issues;
    const after = analyze(ctxFor(year, over)).issues;
    const bad = newIssues(before, after);
    if (bad.length) {
      const nameOf = nameOfFn();
      const coverage = bad.some((i) => i.type === 'coverage');
      const shiftmax = bad.some((i) => i.type === 'shiftmax' || i.type === 'shiftall');
      const msg = `${intro} ${coverage ? 'dejaría al bar por debajo de la cobertura mínima' : shiftmax ? 'habría demasiadas personas de vacaciones a la vez' : 'incumple las reglas'}${bad.length > 1 ? ` (${bad.length} conflictos)` : ''}.`;
      throw new ApiError(409, msg, bad.slice(0, 12).map((i) => describeIssue(i, nameOf)).concat(bad.length > 12 ? [`… y ${bad.length - 12} más.`] : []));
    }
  }

  /** Años que se deben vigilar al cambiar reglas generales (el actual y los futuros). */
  const activeYears = () => repo.all('years').map((y) => y.year).filter((y) => y >= Number(today().slice(0, 4)));

  function log(user, year, action, detail) {
    repo.insert('history', { year: year ?? null, user_name: user ? user.display : 'Sistema', action, detail, created_at: now() });
  }

  function notify(userIds, text, link = '') {
    for (const id of new Set(userIds)) repo.insert('notifications', { user_id: id, text, link, read: 0, created_at: now() });
  }
  const adminIds = () => repo.all('users', { role: 'admin' }).map((u) => u.id);
  const userOfWorker = (wid) => repo.all('users', { worker_id: wid })[0];

  function checkPeriod(start, end, year) {
    const err = checkPeriodShape(start, end, year);
    if (err) throw new ApiError(400, err);
  }

  /** Periodos de vacaciones: además deben tener la duración fija configurada. */
  function checkVacationPeriod(start, end, year) {
    checkPeriod(start, end, year);
    const L = periodRules().periodLength;
    if (L > 0 && periodLength(start, end) !== L) {
      throw new ApiError(400, `Cada periodo de vacaciones debe ser de ${L} días seguidos (este tiene ${periodLength(start, end)}).`);
    }
  }

  // ---------- semilla inicial ----------
  function seed({ adminUsername = 'admin', adminPassword = 'admin', workerPassword = '1234', withDemoPlan = true, workers = BAR_WORKERS } = {}) {
    if (repo.all('users').length) return false;
    repo.tx(() => {
      const thisYear = Number(today().slice(0, 4));
      const planYear = thisYear + 1;
      repo.insert('users', { username: String(adminUsername).trim().toLowerCase(), password_hash: hashPassword(adminPassword), role: 'admin', worker_id: null, created_at: now() });
      setSetting('minimums', NO_MINIMUMS);
      setSetting('generator', DEFAULT_GENERATOR_SETTINGS);
      setSetting('periods', DEFAULT_PERIOD_RULES);
      repo.insert('years', { year: thisYear, status: 'publicado', published_at: now() });
      repo.insert('years', { year: planYear, status: 'borrador', published_at: null });
      for (const y of [thisYear, planYear]) repo.insert('blocked', { year: y, start: `${y}-06-01`, end: `${y}-09-09`, reason: 'Temporada alta: no se cogen vacaciones' });
      for (const [first, last, team, shift] of workers) {
        const w = repo.insert('workers', { first_name: first, last_name: last, created_at: now() });
        for (const year of [thisYear, planYear]) repo.insert('staff', { year, worker_id: w.id, team, shift, days: DEFAULT_ANNUAL_DAYS });
        repo.insert('users', { username: slug(first.split(' ')[0]), password_hash: hashPassword(workerPassword), role: 'worker', worker_id: w.id, created_at: now() });
      }
      if (withDemoPlan) {
        // Los dos años ya configurados con la rotación por turnos: 15 días seguidos por
        // persona, uno detrás de otro, nunca dos del mismo turno a la vez.
        for (const year of [thisYear, planYear]) {
          // Fechas ya pedidas por los trabajadores para el año que se planifica.
          if (year === planYear && workers === BAR_WORKERS) {
            for (const [first, a, b, note] of BAR_REQUESTED) {
              const w = repo.all('workers').find((x) => x.first_name === first);
              if (w) repo.insert('vacations', { year, worker_id: w.id, start: `${year}-${a}`, end: `${year}-${b}`, note, created_at: now() });
            }
          }
          const fixed = repo.all('vacations', { year });
          const prop = generateRotation(ctxFor(year), { periodLength: DEFAULT_PERIOD_RULES.periodLength, fixed, aroundBlocked: true });
          if (prop.issues.length) continue;
          for (const v of prop.vacations) repo.insert('vacations', { ...v, year, note: 'Rotación por turnos', created_at: now() });
        }
      }
      log(null, null, 'Inicio', 'Se crearon los trabajadores del bar y las vacaciones en rotación (15 días seguidos; en sala como máximo 1 camarero a la vez y en cocina 1 por turno).');
    });
    return true;
  }

  // ---------- sesiones ----------
  function userFromToken(token) {
    if (!token) return null;
    const s = repo.all('sessions', { token })[0];
    if (!s) return null;
    const u = repo.get('users', s.user_id);
    if (!u) return null;
    const w = u.worker_id ? repo.get('workers', u.worker_id) : null;
    return { id: u.id, username: u.username, role: u.role, worker_id: u.worker_id, display: u.role === 'admin' ? u.username.charAt(0).toUpperCase() + u.username.slice(1) : workerName(w) };
  }

  const PUBLIC = new Set(['login']);
  const ADMIN = new Set([
    'createYear', 'publishYear', 'unpublishYear', 'saveWorker', 'removeWorker', 'saveVacation', 'deleteVacation',
    'generate', 'applyProposal', 'saveMinimums', 'saveGeneratorSettings', 'saveBlocked', 'deleteBlocked',
    'saveReinforcement', 'deleteReinforcement', 'savePeriodRules', 'resolveRequest', 'listHistory', 'clearVacations',
  ]);

  function call(token, action, params = {}) {
    const handler = actions[action];
    if (!handler) throw new ApiError(404, 'Acción desconocida.');
    let user = null;
    if (!PUBLIC.has(action)) {
      user = userFromToken(token);
      if (!user) throw new ApiError(401, 'Tu sesión ha caducado. Vuelve a entrar.');
      if (ADMIN.has(action) && user.role !== 'admin') throw new ApiError(403, 'Solo el administrador puede hacer esto.');
    }
    let result;
    repo.tx(() => { result = handler(params || {}, user); });
    return result;
  }

  // ---------- acciones ----------
  const actions = {
    login({ username, password }) {
      const u = repo.all('users', { username: String(username || '').trim().toLowerCase() })[0];
      const pw = String(password || '');
      if (!u || !(verifyPassword(pw, u.password_hash) || (pw !== pw.trim() && verifyPassword(pw.trim(), u.password_hash)))) throw new ApiError(401, 'Usuario o contraseña incorrectos.');
      const token = randomToken();
      repo.insert('sessions', { token, user_id: u.id, created_at: now() });
      return { token, user: userFromToken(token) };
    },

    logout(_, user) {
      repo.removeWhere('sessions', { user_id: user.id });
      return { ok: true };
    },

    me(_, user) {
      return { user };
    },

    changePassword({ current, next }, user) {
      const u = repo.get('users', user.id);
      if (!verifyPassword(String(current || ''), u.password_hash)) throw new ApiError(400, 'La contraseña actual no es correcta.');
      if (!next || String(next).length < 4) throw new ApiError(400, 'La nueva contraseña debe tener al menos 4 caracteres.');
      repo.update('users', u.id, { password_hash: hashPassword(String(next)) });
      return { ok: true };
    },

    listYears(_, user) {
      const ys = repo.all('years').sort((a, b) => a.year - b.year);
      return user.role === 'admin' ? ys : ys.map((y) => ({ year: y.year, status: y.status }));
    },

    getYear({ year }, user) {
      year = Number(year);
      const ys = repo.all('years').sort((a, b) => a.year - b.year);
      const y = ys.find((r) => r.year === year);
      const isAdmin = user.role === 'admin';
      const wmap = workersById();
      const visible = y && (isAdmin || y.status === 'publicado');
      const staff = y ? repo.all('staff', { year }).map((s) => ({ ...s, name: workerName(wmap.get(s.worker_id)), first_name: wmap.get(s.worker_id)?.first_name, last_name: wmap.get(s.worker_id)?.last_name })) : [];
      const users = repo.all('users');
      if (isAdmin) for (const s of staff) s.username = users.find((u) => u.worker_id === s.worker_id)?.username || '';
      const reqs = repo.all('requests', { year }).filter((r) => isAdmin || r.requester_id === user.worker_id || r.target_id === user.worker_id);
      return {
        year,
        exists: !!y,
        status: y?.status ?? null,
        published_at: y?.published_at ?? null,
        years: ys.map((r) => ({ year: r.year, status: r.status })),
        staff: staff.sort((a, b) => (a.team === b.team ? (a.shift === b.shift ? a.name.localeCompare(b.name) : a.shift < b.shift ? -1 : 1) : a.team === 'cocina' ? -1 : 1)),
        vacations: visible ? repo.all('vacations', { year }) : [],
        minimums: minimums(),
        blocked: y ? repo.all('blocked', { year }) : [],
        reinforcements: repo.all('reinforcements').filter((r) => r.start <= `${year}-12-31` && r.end >= `${year}-01-01`),
        preferences: repo.all('preferences', { year }).filter((p) => isAdmin || p.worker_id === user.worker_id),
        requests: reqs.sort((a, b) => (a.created_at < b.created_at ? 1 : -1)),
        generator: isAdmin ? generatorSettings() : null,
        periodRules: periodRules(),
        unread: repo.all('notifications', { user_id: user.id }).filter((n) => !n.read).length,
        pendingRequests: isAdmin ? repo.all('requests', { status: 'pendiente' }).length : 0,
        today: today(),
        user,
      };
    },

    createYear({ year, copyFrom }, user) {
      year = Number(year);
      if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new ApiError(400, 'Año no válido.');
      if (yearRow(year)) throw new ApiError(400, `El año ${year} ya existe.`);
      repo.insert('years', { year, status: 'borrador', published_at: null });
      const from = Number(copyFrom) || Math.max(0, ...repo.all('years').map((y) => y.year).filter((y) => y < year));
      const src = from ? repo.all('staff', { year: from }) : [];
      for (const s of src) repo.insert('staff', { year, worker_id: s.worker_id, team: s.team, shift: s.shift, days: s.days });
      // Las fechas bloqueadas (p. ej. temporada alta) se repiten cada año.
      if (from) for (const b of repo.all('blocked', { year: from })) {
        const mv = (d) => `${year}${d.slice(4)}`;
        if (b.start.slice(5) === '02-29' || b.end.slice(5) === '02-29') continue;
        repo.insert('blocked', { year, start: mv(b.start), end: mv(b.end), reason: b.reason });
      }
      log(user, year, 'Año creado', src.length ? `Se copió la plantilla de ${from} (${src.length} trabajadores).` : 'Año vacío.');
      return { ok: true, copied: src.length };
    },

    publishYear({ year }, user) {
      const y = requireYear(year);
      const issues = analyze(ctxFor(y.year)).issues;
      if (issues.length) {
        const nameOf = nameOfFn();
        throw new ApiError(409, 'No se puede publicar: el calendario tiene conflictos.', issues.slice(0, 10).map((i) => describeIssue(i, nameOf)));
      }
      repo.update('years', y.id, { status: 'publicado', published_at: now() });
      notify(repo.all('users', { role: 'worker' }).map((u) => u.id), `Ya está publicado el calendario de vacaciones de ${y.year}.`, `year:${y.year}`);
      log(user, y.year, 'Calendario publicado', `Calendario ${y.year} visible para todo el equipo.`);
      return { ok: true };
    },

    unpublishYear({ year }, user) {
      const y = requireYear(year);
      repo.update('years', y.id, { status: 'borrador' });
      log(user, y.year, 'Calendario retirado', `El calendario ${y.year} vuelve a borrador.`);
      return { ok: true };
    },

    saveWorker(p, user) {
      const year = Number(p.year);
      requireYear(year);
      const first = String(p.first_name || '').trim();
      const last = String(p.last_name || '').trim();
      if (!first) throw new ApiError(400, 'El nombre es obligatorio.');
      if (!TEAMS[p.team] || !SHIFTS[p.shift]) throw new ApiError(400, 'Puesto o turno no válido.');
      const days = Math.floor(Number(p.days ?? DEFAULT_ANNUAL_DAYS));
      if (!(days >= 0 && days <= 60)) throw new ApiError(400, 'Los días de vacaciones deben estar entre 0 y 60.');
      const username = String(p.username || slug(first)).trim().toLowerCase();
      if (!/^[a-z0-9._-]{2,30}$/.test(username)) throw new ApiError(400, 'El usuario solo puede tener letras sin acentos, números, punto o guion.');
      const clash = repo.all('users', { username })[0];

      let workerId = p.id ? Number(p.id) : null;
      if (workerId) {
        const w = repo.get('workers', workerId);
        if (!w) throw new ApiError(404, 'Trabajador no encontrado.');
        const u = userOfWorker(workerId);
        if (clash && clash.id !== u?.id) throw new ApiError(400, `El usuario "${username}" ya existe.`);
        const st = repo.all('staff', { year, worker_id: workerId })[0];
        if (st && (st.team !== p.team || st.shift !== p.shift || st.days !== days)) {
          const staff = repo.all('staff', { year }).map((s) => (s.id === st.id ? { ...s, team: p.team, shift: p.shift, days } : s));
          guard(year, { staff }, `No se puede cambiar el puesto o los días de ${workerName(w)} porque`);
          repo.update('staff', st.id, { team: p.team, shift: p.shift, days });
        } else if (!st) {
          repo.insert('staff', { year, worker_id: workerId, team: p.team, shift: p.shift, days });
        }
        repo.update('workers', workerId, { first_name: first, last_name: last });
        if (u) {
          const patch = { username };
          if (p.password) patch.password_hash = hashPassword(String(p.password));
          repo.update('users', u.id, patch);
        }
        log(user, year, 'Trabajador editado', `${first} ${last} · ${groupLabel(p.team, p.shift)} · ${days} días.`);
      } else {
        if (clash) throw new ApiError(400, `El usuario "${username}" ya existe.`);
        const w = repo.insert('workers', { first_name: first, last_name: last, created_at: now() });
        workerId = w.id;
        repo.insert('staff', { year, worker_id: workerId, team: p.team, shift: p.shift, days });
        repo.insert('users', { username, password_hash: hashPassword(String(p.password || '1234')), role: 'worker', worker_id: workerId, created_at: now() });
        log(user, year, 'Trabajador creado', `${first} ${last} · ${groupLabel(p.team, p.shift)} · usuario ${username}.`);
      }
      return { ok: true, id: workerId };
    },

    removeWorker({ id, year }, user) {
      year = Number(year); id = Number(id);
      const st = repo.all('staff', { year, worker_id: id })[0];
      if (!st) throw new ApiError(404, 'Ese trabajador no está en la plantilla de este año.');
      const staff = repo.all('staff', { year }).filter((s) => s.id !== st.id);
      const vacations = repo.all('vacations', { year }).filter((v) => v.worker_id !== id);
      guard(year, { staff, vacations }, 'No se puede quitar a este trabajador porque');
      const w = repo.get('workers', id);
      repo.remove('staff', st.id);
      repo.removeWhere('vacations', { year, worker_id: id });
      repo.removeWhere('preferences', { year, worker_id: id });
      if (!repo.all('staff', { worker_id: id }).length) {
        const u = userOfWorker(id);
        if (u) { repo.removeWhere('sessions', { user_id: u.id }); repo.remove('users', u.id); }
      }
      log(user, year, 'Trabajador eliminado', `${workerName(w)} sale de la plantilla de ${year}.`);
      return { ok: true };
    },

    saveVacation({ id, year, worker_id, start, end, note }, user) {
      year = Number(year); worker_id = Number(worker_id);
      requireYear(year);
      checkVacationPeriod(start, end, year);
      if (!repo.all('staff', { year, worker_id }).length) throw new ApiError(400, 'El trabajador no está en la plantilla de este año.');
      let vacations = repo.all('vacations', { year });
      const prev = id ? vacations.find((v) => v.id === Number(id)) : null;
      if (id && !prev) throw new ApiError(404, 'Periodo no encontrado.');
      vacations = prev
        ? vacations.map((v) => (v.id === prev.id ? { ...v, worker_id, start, end } : v))
        : [...vacations, { id: -1, year, worker_id, start, end }];
      guard(year, { vacations });
      const name = nameOfFn()(worker_id);
      if (prev) {
        repo.update('vacations', prev.id, { worker_id, start, end, note: note ?? prev.note });
        log(user, year, 'Vacaciones modificadas', `${name}: ${formatRange(prev.start, prev.end)} → ${formatRange(start, end)}.`);
      } else {
        repo.insert('vacations', { year, worker_id, start, end, note: note || '', created_at: now() });
        log(user, year, 'Vacaciones añadidas', `${name}: ${formatRange(start, end)} (${periodLength(start, end)} días).`);
      }
      const y = yearRow(year);
      if (y.status === 'publicado') {
        const u = userOfWorker(worker_id);
        if (u) notify([u.id], `El administrador ha ${prev ? 'modificado' : 'añadido'} tus vacaciones: ${formatRange(start, end)}.`, `year:${year}`);
      }
      return { ok: true };
    },

    deleteVacation({ id }, user) {
      const v = repo.get('vacations', Number(id));
      if (!v) throw new ApiError(404, 'Periodo no encontrado.');
      repo.remove('vacations', v.id);
      log(user, v.year, 'Vacaciones eliminadas', `${nameOfFn()(v.worker_id)}: ${formatRange(v.start, v.end)}.`);
      return { ok: true };
    },

    clearVacations({ year }, user) {
      year = Number(year);
      const n = repo.all('vacations', { year }).length;
      repo.removeWhere('vacations', { year });
      log(user, year, 'Calendario vaciado', `Se borraron ${n} periodos de vacaciones.`);
      return { ok: true };
    },

    generate({ year, settings, keepExisting = true }) {
      year = Number(year);
      requireYear(year);
      const ctx = ctxFor(year);
      const gs = { ...generatorSettings(), ...(settings || {}) };
      const notBefore = today() > `${year}-01-01` ? today() : null;
      if (gs.strategy === 'rotacion') {
        const nb = notBefore && notBefore > `${year}-12-31` ? `${year + 1}-01-01` : notBefore;
        // Las vacaciones pedidas por un trabajador (nota "Pedido…") se respetan tal cual.
        const fixed = ctx.vacations.filter((v) => String(v.note || '').startsWith('Pedido'));
        const prop = generateRotation({ ...ctx, vacations: [] }, { ...gs.rotation, periodLength: periodRules().periodLength || 15, notBefore: nb ? addDays(nb, 1) : null, fixed });
        return { ...prop, vacations: [...fixed.map((v) => ({ worker_id: v.worker_id, start: v.start, end: v.end, note: v.note })), ...prop.vacations], replaceOnly: true };
      }
      const prop = generateProposal(ctx, {
        ...gs,
        ...periodRules(),
        keepExisting,
        notBefore: notBefore && notBefore > `${year}-12-31` ? `${year + 1}-01-01` : notBefore,
        preferences: repo.all('preferences', { year }),
        seed: Math.floor(Math.random() * 1e9),
      });
      return prop;
    },

    applyProposal({ year, vacations, reinforcements = [], replace }, user) {
      year = Number(year);
      requireYear(year);
      const clean = (vacations || []).map((v) => {
        checkVacationPeriod(v.start, v.end, year);
        return { year, worker_id: Number(v.worker_id), start: v.start, end: v.end, note: String(v.note || '').startsWith('Pedido') ? String(v.note).slice(0, 200) : '' };
      });
      const reins = (reinforcements || []).map((r) => {
        checkPeriod(r.start, r.end);
        if (!TEAMS[r.team] || !SHIFTS[r.shift]) throw new ApiError(400, 'Suplente no válido.');
        return { team: r.team, shift: r.shift, start: r.start, end: r.end, count: Math.max(1, Number(r.count) || 1), note: String(r.note || 'Suplente') };
      });
      const existing = replace ? [] : repo.all('vacations', { year });
      guard(year, {
        vacations: [...existing, ...clean.map((v, i) => ({ ...v, id: -1 - i }))],
        reinforcements: [...repo.all('reinforcements'), ...reins],
      }, 'No se puede aplicar la propuesta porque');
      if (replace) repo.removeWhere('vacations', { year });
      for (const r of reins) repo.insert('reinforcements', r);
      for (const v of clean) repo.insert('vacations', { ...v, note: v.note || 'Propuesta automática', created_at: now() });
      log(user, year, 'Propuesta aplicada', `${clean.length} periodos${reins.length ? ` y ${reins.length} suplentes de cocina` : ''}${replace ? ' (sustituyendo el calendario anterior)' : ''}.`);
      return { ok: true };
    },

    saveMinimums({ minimums: m }, user) {
      const norm = normalizeMinimums(m);
      for (const year of activeYears()) guard(year, { minimums: norm }, `No se pueden aplicar estos mínimos en ${year} porque el calendario actual`);
      setSetting('minimums', norm);
      log(user, null, 'Mínimos de cobertura cambiados', Object.entries(norm).map(([t, s]) => `${TEAMS[t]}: M ${s.M.join('/')} · T ${s.T.join('/')}`).join(' — '));
      return { ok: true };
    },

    saveGeneratorSettings({ settings }, user) {
      const s = { ...generatorSettings(), ...(settings || {}) };
      s.mode = s.mode === 'verano' ? 'verano' : 'repartir';
      s.preferredMonths = (s.preferredMonths || []).map(Number).filter((m) => m >= 0 && m < 12);
      s.split = (s.split || []).map((x) => Math.floor(Number(x))).filter((x) => x > 0);
      if (!s.split.length) s.split = [15, 10, 5];
      s.substitutes = { enabled: !!s.substitutes?.enabled, length: Math.max(5, Math.min(31, Number(s.substitutes?.length) || 14)) };
      s.iterations = Math.max(5, Math.min(120, Number(s.iterations) || 40));
      s.strategy = s.strategy === 'equilibrado' ? 'equilibrado' : 'rotacion';
      const rot = s.rotation || {};
      s.rotation = {
        start: isISODate(rot.start) ? rot.start : null,
        spread: !!rot.spread,
        aroundBlocked: rot.aroundBlocked !== false && !rot.spread,
        order: Object.fromEntries(Object.entries(rot.order || {}).map(([k, v]) => [k, (v || []).map(Number).filter(Boolean)])),
      };
      setSetting('generator', s);
      log(user, null, 'Ajustes del generador', `Modo ${s.mode}, reparto ${s.split.join('+')}, suplentes ${s.substitutes.enabled ? `sí (${s.substitutes.length} días)` : 'no'}.`);
      return s;
    },

    savePeriodRules(p, user) {
      const cur = periodRules();
      let L = p.periodLength !== undefined ? Math.floor(Number(p.periodLength) || 0) : cur.periodLength;
      if (L < 0 || L > 31) throw new ApiError(400, 'La duración debe estar entre 1 y 31 días, o 0 para dejarla libre.');
      let M = p.maxOffPerShift !== undefined ? (p.maxOffPerShift === null || p.maxOffPerShift === '' ? null : Math.floor(Number(p.maxOffPerShift))) : cur.maxOffPerShift;
      if (M != null && !(M >= 0 && M <= 10)) throw new ApiError(400, 'El máximo por turno debe estar entre 0 y 10.');
      const W = p.wholeTeam !== undefined ? (Array.isArray(p.wholeTeam) ? p.wholeTeam.filter((t) => t === 'sala' || t === 'cocina') : []) : (cur.wholeTeam || []);
      const A = p.maxOffPerShiftAll !== undefined ? (p.maxOffPerShiftAll === null || p.maxOffPerShiftAll === '' ? null : Math.max(0, Math.floor(Number(p.maxOffPerShiftAll)))) : (cur.maxOffPerShiftAll ?? null);
      if (M !== cur.maxOffPerShift || W.join() !== (cur.wholeTeam || []).join() || A !== (cur.maxOffPerShiftAll ?? null)) {
        for (const year of activeYears()) guard(year, { maxOffPerShift: M, wholeTeam: W, maxOffPerShiftAll: A }, `No se puede aplicar ese máximo en ${year} porque el calendario actual`);
      }
      setSetting('periods', { periodLength: L, maxOffPerShift: M, wholeTeam: W, maxOffPerShiftAll: A });
      log(user, null, 'Reglas de vacaciones', `${L ? `Periodos de ${L} días seguidos` : 'Periodos de duración libre'} · ${M == null ? 'sin máximo por turno' : `máximo ${M} de vacaciones a la vez por turno`}.`);
      return { periodLength: L, maxOffPerShift: M, wholeTeam: W, maxOffPerShiftAll: A };
    },

    saveBlocked({ id, year, start, end, reason }, user) {
      year = Number(year);
      requireYear(year);
      checkPeriod(start, end, year);
      const list = repo.all('blocked', { year });
      const next = id ? list.map((b) => (b.id === Number(id) ? { ...b, start, end, reason } : b)) : [...list, { id: -1, year, start, end, reason }];
      guard(year, { blocked: next }, 'No se puede bloquear ese periodo porque');
      if (id) repo.update('blocked', Number(id), { start, end, reason: reason || '' });
      else repo.insert('blocked', { year, start, end, reason: reason || '' });
      log(user, year, 'Fechas bloqueadas', `${formatRange(start, end)}${reason ? ` (${reason})` : ''}.`);
      return { ok: true };
    },

    deleteBlocked({ id }, user) {
      const b = repo.get('blocked', Number(id));
      if (!b) throw new ApiError(404, 'No encontrado.');
      repo.remove('blocked', b.id);
      log(user, b.year, 'Fechas desbloqueadas', `${formatRange(b.start, b.end)}.`);
      return { ok: true };
    },

    saveReinforcement({ id, team, shift, start, end, count, note }, user) {
      checkPeriod(start, end);
      if (!TEAMS[team] || !SHIFTS[shift]) throw new ApiError(400, 'Puesto o turno no válido.');
      count = Math.max(1, Math.min(5, Number(count) || 1));
      const list = repo.all('reinforcements');
      const next = id ? list.map((r) => (r.id === Number(id) ? { ...r, team, shift, start, end, count } : r)) : [...list, { team, shift, start, end, count }];
      for (const year of new Set([Number(start.slice(0, 4)), Number(end.slice(0, 4)), ...(id ? [Number(repo.get('reinforcements', Number(id))?.start.slice(0, 4))] : [])])) {
        if (yearRow(year)) guard(year, { reinforcements: next }, 'No se puede cambiar este suplente porque');
      }
      if (id) repo.update('reinforcements', Number(id), { team, shift, start, end, count, note: note || '' });
      else repo.insert('reinforcements', { team, shift, start, end, count, note: note || '' });
      log(user, Number(start.slice(0, 4)), id ? 'Suplente modificado' : 'Suplente añadido', `${groupLabel(team, shift)}: ${formatRange(start, end)}${note ? ` (${note})` : ''}.`);
      return { ok: true };
    },

    deleteReinforcement({ id }, user) {
      const r = repo.get('reinforcements', Number(id));
      if (!r) throw new ApiError(404, 'No encontrado.');
      const next = repo.all('reinforcements').filter((x) => x.id !== r.id);
      for (const year of new Set([Number(r.start.slice(0, 4)), Number(r.end.slice(0, 4))])) {
        if (yearRow(year)) guard(year, { reinforcements: next }, 'No se puede quitar este suplente porque hay vacaciones que dependen de él y');
      }
      repo.remove('reinforcements', r.id);
      log(user, Number(r.start.slice(0, 4)), 'Suplente eliminado', `${groupLabel(r.team, r.shift)}: ${formatRange(r.start, r.end)}.`);
      return { ok: true };
    },

    savePreference({ id, year, worker_id, start, end, note }, user) {
      year = Number(year);
      requireYear(year);
      checkPeriod(start, end, year);
      const wid = user.role === 'admin' ? Number(worker_id) : user.worker_id;
      if (!repo.all('staff', { year, worker_id: wid }).length) throw new ApiError(400, 'El trabajador no está en la plantilla de este año.');
      if (id) {
        const p = repo.get('preferences', Number(id));
        if (!p || (user.role !== 'admin' && p.worker_id !== user.worker_id)) throw new ApiError(403, 'No puedes modificar esta preferencia.');
        repo.update('preferences', p.id, { start, end, note: note || '' });
      } else {
        repo.insert('preferences', { year, worker_id: wid, start, end, note: note || '' });
      }
      log(user, year, 'Preferencia de fechas', `${nameOfFn()(wid)} prefiere ${formatRange(start, end)}.`);
      return { ok: true };
    },

    deletePreference({ id }, user) {
      const p = repo.get('preferences', Number(id));
      if (!p || (user.role !== 'admin' && p.worker_id !== user.worker_id)) throw new ApiError(403, 'No puedes borrar esta preferencia.');
      repo.remove('preferences', p.id);
      return { ok: true };
    },

    // ----- solicitudes de cambio -----
    createChangeRequest({ year, remove = [], add = [], comment = '' }, user) {
      year = Number(year);
      const y = requireYear(year);
      if (y.status !== 'publicado') throw new ApiError(400, 'El calendario de este año todavía no está publicado.');
      const wid = user.role === 'admin' ? null : user.worker_id;
      if (!wid) throw new ApiError(400, 'El administrador modifica el calendario directamente, sin solicitudes.');
      const all = repo.all('vacations', { year });
      const removeIds = remove.map(Number);
      for (const rid of removeIds) {
        const v = all.find((x) => x.id === rid);
        if (!v || v.worker_id !== wid) throw new ApiError(403, 'Solo puedes pedir cambios de tus propias vacaciones.');
        if (v.start <= today()) throw new ApiError(400, `El periodo ${formatRange(v.start, v.end)} ya ha empezado y no se puede cambiar.`);
      }
      const adds = add.map((a) => {
        checkVacationPeriod(a.start, a.end, year);
        if (a.start <= today()) throw new ApiError(400, 'Las nuevas fechas deben ser posteriores a hoy.');
        return { start: a.start, end: a.end };
      });
      if (!removeIds.length && !adds.length) throw new ApiError(400, 'La solicitud está vacía.');
      const data = { remove: removeIds.map((id) => { const v = all.find((x) => x.id === id); return { id, start: v.start, end: v.end }; }), add: adds };
      guard(year, { vacations: applyChange(all, wid, data) }, 'No se puede enviar la solicitud porque');
      const req = repo.insert('requests', { year, type: 'cambio', status: 'pendiente', requester_id: wid, target_id: null, data, comment: String(comment).slice(0, 500), admin_comment: '', created_at: now(), resolved_at: null });
      notify(adminIds(), `${user.display} solicita un cambio de vacaciones (${describeChange(data)}).`, `request:${req.id}`);
      log(user, year, 'Solicitud de cambio', `${user.display}: ${describeChange(data)}.`);
      return { ok: true, id: req.id };
    },

    createSwapRequest({ year, my_vacation_id, other_vacation_id, comment = '' }, user) {
      year = Number(year);
      const y = requireYear(year);
      if (y.status !== 'publicado') throw new ApiError(400, 'El calendario de este año todavía no está publicado.');
      const all = repo.all('vacations', { year });
      const mine = all.find((v) => v.id === Number(my_vacation_id));
      const other = all.find((v) => v.id === Number(other_vacation_id));
      if (!mine || mine.worker_id !== user.worker_id) throw new ApiError(403, 'Elige uno de tus periodos.');
      if (!other || other.worker_id === user.worker_id) throw new ApiError(400, 'Elige un periodo de otro compañero.');
      if (mine.start <= today() || other.start <= today()) throw new ApiError(400, 'Solo se pueden intercambiar periodos que todavía no han empezado.');
      const data = { a: { id: mine.id, start: mine.start, end: mine.end }, b: { id: other.id, start: other.start, end: other.end } };
      guard(year, { vacations: applySwap(all, data) }, 'No se puede proponer el intercambio porque');
      const req = repo.insert('requests', { year, type: 'intercambio', status: 'esperando_companero', requester_id: user.worker_id, target_id: other.worker_id, data, comment: String(comment).slice(0, 500), admin_comment: '', created_at: now(), resolved_at: null });
      const u = userOfWorker(other.worker_id);
      if (u) notify([u.id], `${user.display} te propone intercambiar vacaciones: sus días ${formatRange(mine.start, mine.end)} por tus días ${formatRange(other.start, other.end)}.`, `request:${req.id}`);
      log(user, year, 'Propuesta de intercambio', `${user.display} ↔ ${nameOfFn()(other.worker_id)}.`);
      return { ok: true, id: req.id };
    },

    respondSwap({ id, accept }, user) {
      const r = repo.get('requests', Number(id));
      if (!r || r.type !== 'intercambio' || r.target_id !== user.worker_id) throw new ApiError(403, 'Esta propuesta no es para ti.');
      if (r.status !== 'esperando_companero') throw new ApiError(400, 'Esta propuesta ya fue respondida.');
      const requester = userOfWorker(r.requester_id);
      if (!accept) {
        repo.update('requests', r.id, { status: 'rechazada', admin_comment: `Rechazada por ${user.display}.`, resolved_at: now() });
        if (requester) notify([requester.id], `${user.display} ha rechazado tu propuesta de intercambio.`, `request:${r.id}`);
        log(user, r.year, 'Intercambio rechazado por compañero', `${user.display} rechaza el intercambio.`);
        return { ok: true };
      }
      checkSwapStillValid(r);
      guard(r.year, { vacations: applySwap(repo.all('vacations', { year: r.year }), r.data) }, 'El intercambio ya no es posible porque');
      repo.update('requests', r.id, { status: 'pendiente' });
      notify(adminIds(), `Intercambio pendiente de aprobar: ${nameOfFn()(r.requester_id)} ↔ ${user.display}.`, `request:${r.id}`);
      if (requester) notify([requester.id], `${user.display} ha aceptado el intercambio. Falta la aprobación del administrador.`, `request:${r.id}`);
      log(user, r.year, 'Intercambio aceptado por compañero', `${user.display} acepta. Pendiente del administrador.`);
      return { ok: true };
    },

    cancelRequest({ id }, user) {
      const r = repo.get('requests', Number(id));
      if (!r || r.requester_id !== user.worker_id) throw new ApiError(403, 'Solo puedes anular tus solicitudes.');
      if (!['pendiente', 'esperando_companero'].includes(r.status)) throw new ApiError(400, 'Esta solicitud ya está cerrada.');
      repo.update('requests', r.id, { status: 'anulada', resolved_at: now() });
      log(user, r.year, 'Solicitud anulada', `${user.display} anula su solicitud.`);
      return { ok: true };
    },

    resolveRequest({ id, approve, comment = '' }, user) {
      const r = repo.get('requests', Number(id));
      if (!r) throw new ApiError(404, 'Solicitud no encontrada.');
      if (r.status !== 'pendiente') throw new ApiError(400, 'Esta solicitud no está pendiente de aprobación.');
      const nameOf = nameOfFn();
      const involved = [r.requester_id, r.target_id].filter(Boolean).map(userOfWorker).filter(Boolean).map((u) => u.id);
      if (!approve) {
        repo.update('requests', r.id, { status: 'rechazada', admin_comment: String(comment), resolved_at: now() });
        notify(involved, `Tu solicitud de ${r.type} ha sido rechazada${comment ? `: ${comment}` : '.'}`, `request:${r.id}`);
        log(user, r.year, 'Solicitud rechazada', `${r.type} de ${nameOf(r.requester_id)}${comment ? ` · ${comment}` : ''}.`);
        return { ok: true };
      }
      const all = repo.all('vacations', { year: r.year });
      if (r.type === 'cambio') {
        for (const rem of r.data.remove) {
          const v = all.find((x) => x.id === rem.id);
          if (!v || v.start !== rem.start || v.end !== rem.end) throw new ApiError(409, 'Las vacaciones de esta solicitud han cambiado desde que se pidió. Recházala y pide al trabajador que la repita.');
        }
        guard(r.year, { vacations: applyChange(all, r.requester_id, r.data) }, 'No se puede aprobar porque');
        for (const rem of r.data.remove) repo.remove('vacations', rem.id);
        for (const a of r.data.add) repo.insert('vacations', { year: r.year, worker_id: r.requester_id, start: a.start, end: a.end, note: 'Solicitud aprobada', created_at: now() });
      } else {
        checkSwapStillValid(r);
        guard(r.year, { vacations: applySwap(all, r.data) }, 'No se puede aprobar porque');
        const va = repo.get('vacations', r.data.a.id), vb = repo.get('vacations', r.data.b.id);
        repo.update('vacations', va.id, { worker_id: vb.worker_id, note: 'Intercambio aprobado' });
        repo.update('vacations', vb.id, { worker_id: va.worker_id, note: 'Intercambio aprobado' });
      }
      repo.update('requests', r.id, { status: 'aprobada', admin_comment: String(comment), resolved_at: now() });
      notify(involved, `Tu solicitud de ${r.type} ha sido aprobada.`, `request:${r.id}`);
      log(user, r.year, 'Solicitud aprobada', r.type === 'cambio' ? `${nameOf(r.requester_id)}: ${describeChange(r.data)}.` : `Intercambio ${nameOf(r.requester_id)} ↔ ${nameOf(r.target_id)}.`);
      return { ok: true };
    },

    listNotifications(_, user) {
      return repo.all('notifications', { user_id: user.id }).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 50);
    },

    markNotificationsRead(_, user) {
      for (const n of repo.all('notifications', { user_id: user.id })) if (!n.read) repo.update('notifications', n.id, { read: 1 });
      return { ok: true };
    },

    listHistory({ year }) {
      const rows = repo.all('history').filter((h) => !year || h.year === Number(year) || h.year == null);
      return rows.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.id - a.id)).slice(0, 500);
    },
  };

  function applyChange(all, wid, data) {
    const removeIds = new Set(data.remove.map((r) => r.id));
    return [...all.filter((v) => !removeIds.has(v.id)), ...data.add.map((a, i) => ({ id: -1 - i, worker_id: wid, start: a.start, end: a.end }))];
  }

  function applySwap(all, data) {
    const a = all.find((v) => v.id === data.a.id), b = all.find((v) => v.id === data.b.id);
    return all.map((v) => (v.id === a.id ? { ...v, worker_id: b.worker_id } : v.id === b.id ? { ...v, worker_id: a.worker_id } : v));
  }

  function checkSwapStillValid(r) {
    const va = repo.get('vacations', r.data.a.id), vb = repo.get('vacations', r.data.b.id);
    if (!va || !vb || va.start !== r.data.a.start || vb.start !== r.data.b.start || va.end !== r.data.a.end || vb.end !== r.data.b.end
      || va.worker_id !== r.requester_id || vb.worker_id !== r.target_id) {
      throw new ApiError(409, 'Alguno de los periodos ha cambiado desde que se propuso el intercambio.');
    }
  }

  function describeChange(data) {
    const parts = [];
    if (data.remove.length) parts.push(`quitar ${data.remove.map((r) => formatRange(r.start, r.end)).join(', ')}`);
    if (data.add.length) parts.push(`pedir ${data.add.map((a) => formatRange(a.start, a.end)).join(', ')}`);
    return parts.join(' y ');
  }

  return { call, seed, actions, ctxFor, userFromToken };
}

export { isISODate, overlaps };
