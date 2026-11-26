import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openRepo } from '../server/db.js';
import { createService, ApiError, EXAMPLE_WORKERS, BAR_WORKERS } from '../shared/service.js';
import { DEFAULT_MINIMUMS } from '../shared/rules.js';

function setup({ periodLength = 0, legacy = true } = {}) {
  const repo = openRepo(':memory:');
  let n = 0;
  const service = createService({
    repo,
    hashPassword: (p) => `x:${p}`,
    verifyPassword: (p, h) => h === `x:${p}`,
    randomToken: () => `t${++n}`,
    today: () => '2026-11-24',
  });
  service.seed({ withDemoPlan: false, workers: EXAMPLE_WORKERS });
  service.call(service.call(null, 'login', { username: 'admin', password: 'admin' }).token, 'savePeriodRules', { wholeTeam: [], maxOffPerShiftAll: null });
  const login = (u, p) => service.call(null, 'login', { username: u, password: p }).token;
  const admin = login('admin', 'admin');
  service.call(admin, 'savePeriodRules', { periodLength });
  if (legacy) {
    // Reglas originales: mínimos por día de la semana y sin máximo por turno.
    service.call(admin, 'saveMinimums', { minimums: DEFAULT_MINIMUMS });
    service.call(admin, 'savePeriodRules', { maxOffPerShift: null });
    service.call(admin, 'saveGeneratorSettings', { settings: { strategy: 'equilibrado' } });
  }
  return { repo, service, admin, login };
}

const err = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof ApiError, e.message); return e; } assert.fail('debería fallar'); };

test('semilla: 12 trabajadores, 4 en cocina y 8 camareros', () => {
  const { service, admin } = setup();
  const d = service.call(admin, 'getYear', { year: 2027 });
  assert.equal(d.staff.length, 12);
  assert.equal(d.staff.filter((s) => s.team === 'cocina').length, 4);
  assert.equal(d.staff.filter((s) => s.team === 'sala' && s.shift === 'M').length, 4);
});

test('el administrador no puede saltarse la cobertura mínima', () => {
  const { service, admin } = setup();
  const d = service.call(admin, 'getYear', { year: 2027 });
  const cook = d.staff.find((s) => s.team === 'cocina');
  const e = err(() => service.call(admin, 'saveVacation', { year: 2027, worker_id: cook.worker_id, start: '2027-03-05', end: '2027-03-05' }));
  assert.equal(e.status, 409);
  assert.match(e.details[0], /Cocina mañana: se necesitan 2/);
  service.call(admin, 'saveVacation', { year: 2027, worker_id: cook.worker_id, start: '2027-03-01', end: '2027-03-04' });
  // Con un suplente, sí puede librar el fin de semana
  service.call(admin, 'saveReinforcement', { team: 'cocina', shift: cook.shift, start: '2027-03-05', end: '2027-03-07', count: 1, note: 'Suplente' });
  service.call(admin, 'saveVacation', { year: 2027, worker_id: cook.worker_id, start: '2027-03-05', end: '2027-03-07' });
  // Y ahora no se puede quitar el suplente
  const rid = service.call(admin, 'getYear', { year: 2027 }).reinforcements[0].id;
  assert.equal(err(() => service.call(admin, 'deleteReinforcement', { id: rid })).status, 409);
});

test('no se pueden subir los mínimos si el calendario dejaría de cumplirlos', () => {
  const { service, admin } = setup();
  const d = service.call(admin, 'getYear', { year: 2027 });
  const w = d.staff.find((s) => s.team === 'sala');
  service.call(admin, 'saveVacation', { year: 2027, worker_id: w.worker_id, start: '2027-03-01', end: '2027-03-02' });
  const m = structuredClone(d.minimums);
  m.sala[w.shift] = [4, 4, 4, 4, 4, 4, 4];
  assert.equal(err(() => service.call(admin, 'saveMinimums', { minimums: m })).status, 409);
});

test('flujo completo: generar, aplicar, publicar, solicitar cambio e intercambio', () => {
  const { service, admin, login } = setup();
  const prop = service.call(admin, 'generate', { year: 2027 });
  assert.equal(prop.issues.length, 0);
  service.call(admin, 'applyProposal', { year: 2027, vacations: prop.vacations, reinforcements: prop.reinforcements, replace: true });
  const marta = login('marta', '1234');
  // Antes de publicar, el trabajador no ve las vacaciones
  assert.equal(service.call(marta, 'getYear', { year: 2027 }).vacations.length, 0);
  assert.equal(err(() => service.call(marta, 'saveVacation', { year: 2027, worker_id: 1, start: '2027-03-01', end: '2027-03-01' })).status, 403);
  service.call(admin, 'publishYear', { year: 2027 });
  const d = service.call(marta, 'getYear', { year: 2027 });
  const me = d.user.worker_id;
  const mine = d.vacations.filter((v) => v.worker_id === me);
  assert.equal(mine.reduce((a, v) => a + (Date.parse(v.end) - Date.parse(v.start)) / 864e5 + 1, 0), 30);

  // Anular un periodo es un cambio válido; queda pendiente
  service.call(marta, 'createChangeRequest', { year: 2027, remove: [mine[0].id], add: [] });
  let reqs = service.call(admin, 'getYear', { year: 2027 }).requests;
  assert.equal(reqs[0].status, 'pendiente');
  service.call(admin, 'resolveRequest', { id: reqs[0].id, approve: true });
  assert.equal(service.call(marta, 'getYear', { year: 2027 }).vacations.filter((v) => v.worker_id === me).length, mine.length - 1);

  // Intercambio con un compañero del mismo turno
  const d2 = service.call(marta, 'getYear', { year: 2027 });
  const meStaff = d2.staff.find((s) => s.worker_id === me);
  const mate = d2.staff.find((s) => s.team === meStaff.team && s.shift === meStaff.shift && s.worker_id !== me);
  const my = d2.vacations.filter((v) => v.worker_id === me);
  const theirs = d2.vacations.filter((v) => v.worker_id === mate.worker_id);
  let done = false;
  for (const a of my) {
    for (const b of theirs) {
      try {
        service.call(marta, 'createSwapRequest', { year: 2027, my_vacation_id: a.id, other_vacation_id: b.id });
        done = true;
      } catch (e) { if (!(e instanceof ApiError)) throw e; }
      if (done) break;
    }
    if (done) break;
  }
  assert.ok(done, 'debería haber algún intercambio posible');
  const mateToken = login(mate.username || service.call(admin, 'getYear', { year: 2027 }).staff.find((s) => s.worker_id === mate.worker_id).username, '1234');
  const swap = service.call(mateToken, 'getYear', { year: 2027 }).requests.find((r) => r.type === 'intercambio');
  assert.equal(swap.status, 'esperando_companero');
  // Marta no puede aceptar su propio intercambio ni aprobarlo
  assert.equal(err(() => service.call(marta, 'respondSwap', { id: swap.id, accept: true })).status, 403);
  assert.equal(err(() => service.call(marta, 'resolveRequest', { id: swap.id, approve: true })).status, 403);
  service.call(mateToken, 'respondSwap', { id: swap.id, accept: true });
  service.call(admin, 'resolveRequest', { id: swap.id, approve: true });
  const after = service.call(admin, 'getYear', { year: 2027 });
  assert.equal(after.vacations.find((v) => v.id === swap.data.a.id).worker_id, mate.worker_id);
  assert.ok(service.call(admin, 'listHistory', {}).length > 5);
  assert.ok(service.call(marta, 'listNotifications').length > 0);
});

test('un trabajador no puede pedir fechas que rompan la cobertura', () => {
  const { service, admin, login } = setup();
  service.call(admin, 'publishYear', { year: 2027 });
  const lucia = login('lucia', '1234'); // cocinera
  const e = err(() => service.call(lucia, 'createChangeRequest', { year: 2027, add: [{ start: '2027-05-07', end: '2027-05-09' }] }));
  assert.equal(e.status, 409);
  assert.match(e.message, /cobertura mínima/);
});

test('duplicar la plantilla para el año siguiente', () => {
  const { service, admin } = setup();
  service.call(admin, 'createYear', { year: 2028, copyFrom: 2027 });
  assert.equal(service.call(admin, 'getYear', { year: 2028 }).staff.length, 12);
});

test('periodos fijos de 15 días con mínimos antiguos: suplentes en cocina', () => {
  const { service, admin } = setup({ periodLength: 15 });
  const prop = service.call(admin, 'generate', { year: 2027 });
  assert.equal(prop.issues.length, 0);
  assert.deepEqual(prop.unassigned, {});
  assert.equal(prop.vacations.length, 24);
  for (const v of prop.vacations) assert.equal((Date.parse(v.end) - Date.parse(v.start)) / 864e5 + 1, 15);
  assert.equal(prop.reinforcements.length, 8);
  service.call(admin, 'applyProposal', { year: 2027, vacations: prop.vacations, reinforcements: prop.reinforcements, replace: true });
  const d = service.call(admin, 'getYear', { year: 2027 });
  assert.equal(d.periodRules.periodLength, 15);
  const e = err(() => service.call(admin, 'saveVacation', { year: 2027, worker_id: d.staff[5].worker_id, start: '2027-03-01', end: '2027-03-04' }));
  assert.match(e.message, /15 días seguidos/);
});

test('regla actual: 15 días seguidos y máximo 1 de vacaciones a la vez por turno', () => {
  const { service, admin } = setup({ periodLength: 15, legacy: false });
  const d = service.call(admin, 'getYear', { year: 2027 });
  assert.equal(d.periodRules.maxOffPerShift, 1);
  const [a, b] = d.staff.filter((s) => s.team === 'sala' && s.shift === 'M');
  const cook = d.staff.find((s) => s.team === 'cocina');
  service.call(admin, 'saveVacation', { year: 2027, worker_id: a.worker_id, start: '2027-03-01', end: '2027-03-15' });
  const e = err(() => service.call(admin, 'saveVacation', { year: 2027, worker_id: b.worker_id, start: '2027-03-10', end: '2027-03-24' }));
  assert.match(e.message, /a la vez/);
  // Otro turno sí puede coincidir, y un cocinero puede librar en fin de semana
  service.call(admin, 'saveVacation', { year: 2027, worker_id: cook.worker_id, start: '2027-03-01', end: '2027-03-15' });
  service.call(admin, 'saveGeneratorSettings', { settings: { strategy: 'equilibrado' } });
  const prop = service.call(admin, 'generate', { year: 2027 });
  assert.equal(prop.issues.length, 0);
  assert.deepEqual(prop.unassigned, {});
  assert.equal(prop.reinforcements.length, 0);
});

test('rotación: en cada turno, uno detrás de otro sin huecos', () => {
  const { service, admin } = setup({ periodLength: 15, legacy: false });
  for (const spread of [false, true]) {
    service.call(admin, 'saveGeneratorSettings', { settings: { strategy: 'rotacion', rotation: { start: '2027-01-04', spread, aroundBlocked: false } } });
    const prop = service.call(admin, 'generate', { year: 2027 });
    assert.equal(prop.issues.length, 0);
    assert.deepEqual(prop.unassigned, {});
    assert.equal(prop.vacations.length, 24);
    const d = service.call(admin, 'getYear', { year: 2027 });
    const salaM = d.staff.filter((s) => s.team === 'sala' && s.shift === 'M').map((s) => s.worker_id);
    const chain = prop.vacations.filter((v) => salaM.includes(v.worker_id)).sort((a, b) => (a.start < b.start ? -1 : 1));
    assert.equal(chain[0].start, '2027-01-04');
    for (let i = 1; i < 4; i++) assert.equal(Date.parse(chain[i].start) - Date.parse(chain[i - 1].end), 864e5);
    if (!spread) assert.equal(Date.parse(chain[4].start) - Date.parse(chain[3].end), 864e5);
    service.call(admin, 'applyProposal', { year: 2027, vacations: prop.vacations, replace: true });
  }
});

test('plantilla del bar: en sala nunca más de un camarero de vacaciones a la vez (mañana y tarde juntas)', () => {
  const repo = openRepo(':memory:');
  let n = 0;
  const service = createService({ repo, hashPassword: (p) => `x:${p}`, verifyPassword: (p, h) => h === `x:${p}`, randomToken: () => `t${++n}`, today: () => '2026-11-24' });
  service.seed({ workers: BAR_WORKERS });
  const admin = service.call(null, 'login', { username: 'admin', password: 'admin' }).token;
  const d = service.call(admin, 'getYear', { year: 2027 });
  assert.equal(d.staff.length, 12);
  assert.deepEqual(d.periodRules.wholeTeam, ['sala', 'cocina']);
  const sala = new Set(d.staff.filter((s) => s.team === 'sala').map((s) => s.worker_id));
  const days = new Map();
  for (const v of d.vacations) {
    if (!sala.has(v.worker_id)) continue;
    for (let x = new Date(v.start); x <= new Date(v.end); x.setUTCDate(x.getUTCDate() + 1)) {
      const k = x.toISOString().slice(0, 10);
      assert.ok(!days.has(k), `dos camareros de vacaciones el ${k}`);
      days.set(k, v.worker_id);
    }
  }
  assert.equal(days.size, 8 * 30);
  // Naima tiene todo marzo (1–30) y Josué la primera quincena de enero.
  const naima = d.staff.find((s) => s.first_name === 'Naima');
  const josue = d.staff.find((s) => s.first_name === 'Josué');
  assert.deepEqual(d.vacations.filter((v) => v.worker_id === naima.worker_id).map((v) => [v.start, v.end]).sort(), [['2027-03-01', '2027-03-15'], ['2027-03-16', '2027-03-30']]);
  assert.ok(d.vacations.some((v) => v.worker_id === josue.worker_id && v.start === '2027-01-01' && v.end === '2027-01-15'));
  // El resto: una quincena antes del verano y otra después.
  for (const s of d.staff) {
    if (s.worker_id === naima.worker_id || s.flex) continue;
    const vs = d.vacations.filter((v) => v.worker_id === s.worker_id);
    assert.equal(vs.filter((v) => v.end < '2027-06-01').length, 1, `${s.first_name} antes del verano`);
    assert.equal(vs.filter((v) => v.start > '2027-09-09').length, 1, `${s.first_name} después del verano`);
  }
  // Al volver a generar, lo pedido se mantiene.
  const prop = service.call(admin, 'generate', { year: 2027 });
  assert.equal(prop.issues.length, 0);
  assert.equal(prop.vacations.filter((v) => v.worker_id === naima.worker_id && v.start.startsWith('2027-03')).length, 2);
  // Nada entre el 1 de junio y el 9 de septiembre, y camareros y cocineros casi sin coincidir.
  for (const v of d.vacations) assert.ok(v.end < '2027-06-01' || v.start > '2027-09-09', `${v.start}–${v.end} en temporada alta`);
  assert.equal(d.vacations.length, 8 * 2 + 4 * 2);
  // Nunca dos cocineros a la vez, y un cocinero solo coincide con un camarero del otro turno.
  const shiftOf = new Map(d.staff.map((s) => [s.worker_id, s.shift]));
  const flexOf = new Map(d.staff.map((s) => [s.worker_id, !!s.flex]));
  const cook = new Map();
  for (const v of d.vacations) if (!sala.has(v.worker_id)) for (let x = new Date(v.start); x <= new Date(v.end); x.setUTCDate(x.getUTCDate() + 1)) {
    const k = x.toISOString().slice(0, 10);
    assert.ok(!cook.has(k), `dos cocineros de vacaciones el ${k}`);
    cook.set(k, v.worker_id);
    if (days.has(k)) assert.notEqual(shiftOf.get(days.get(k)), shiftOf.get(v.worker_id), `cocinero y camarero del mismo turno el ${k}`);
  }
  assert.equal(cook.size, 4 * 30);
  // Edwin (suplente) nunca coincide con otro camarero ni con un cocinero de su turno.
  const edwin = d.staff.find((s) => s.first_name === 'Edwin');
  assert.ok(edwin.flex);
  assert.equal([...days.values()].filter((id) => id === edwin.worker_id).length, 30);
  // Un camarero de mañana y otro de tarde a la vez: se rechaza.
  const m = d.staff.find((s) => s.team === 'sala' && s.shift === 'M');
  const t = d.staff.find((s) => s.team === 'sala' && s.shift === 'T');
  service.call(admin, 'clearVacations', { year: 2027 });
  service.call(admin, 'saveVacation', { year: 2027, worker_id: m.worker_id, start: '2027-12-01', end: '2027-12-15' });
  err(() => service.call(admin, 'saveVacation', { year: 2027, worker_id: t.worker_id, start: '2027-12-10', end: '2027-12-24' }));
  // Con un cocinero del otro turno sí puede coincidir; con uno del mismo turno, no.
  const ct = d.staff.find((s) => s.team === 'cocina' && s.shift === 'T');
  const cm = d.staff.find((s) => s.team === 'cocina' && s.shift === 'M');
  err(() => service.call(admin, 'saveVacation', { year: 2027, worker_id: cm.worker_id, start: '2027-12-01', end: '2027-12-15' }));
  service.call(admin, 'saveVacation', { year: 2027, worker_id: ct.worker_id, start: '2027-12-01', end: '2027-12-15' });
  // Y dos cocineros nunca a la vez.
  const ct2 = d.staff.find((s) => s.team === 'cocina' && s.shift === 'T' && s.worker_id !== ct.worker_id);
  err(() => service.call(admin, 'saveVacation', { year: 2027, worker_id: ct2.worker_id, start: '2027-12-05', end: '2027-12-19' }));
});

test('un trabajador mueve su quincena: libre se guarda; si choca, pide los días al compañero', () => {
  const repo = openRepo(':memory:');
  let n = 0;
  const service = createService({ repo, hashPassword: (p) => `x:${p}`, verifyPassword: (p, h) => h === `x:${p}`, randomToken: () => `t${++n}`, today: () => '2026-11-24' });
  service.seed({ workers: BAR_WORKERS });
  const login = (u) => service.call(null, 'login', { username: u, password: u === 'admin' ? 'admin' : '1234' }).token;
  const admin = login('admin');
  service.call(admin, 'publishYear', { year: 2027 });
  const gemma = login('gemma'), lasha = login('lasha'), tania = login('tania');
  const d = service.call(gemma, 'getYear', { year: 2027 });
  const id = (name) => d.staff.find((s) => s.first_name === name).worker_id;
  const vac = (name, month) => d.vacations.find((v) => v.worker_id === id(name) && v.start.slice(5, 7) === month);
  const g = vac('Gemma', '10'), l = vac('Lasha', '10');
  // No puede mover las de otro.
  err(() => service.call(tania, 'moveMyVacation', { year: 2027, id: g.id, start: g.start, end: g.end }));
  // Choca con Lasha: no se mueve y a Lasha le llega la petición.
  const r = service.call(gemma, 'moveMyVacation', { year: 2027, id: g.id, start: '2027-10-10', end: '2027-10-24' });
  assert.equal(r.moved, false);
  assert.equal(r.requested, 'Lasha Kabzinadze');
  const after = service.call(gemma, 'getYear', { year: 2027 });
  assert.equal(after.vacations.find((v) => v.id === g.id).start, g.start);
  const notes = service.call(lasha, 'listNotifications', {});
  assert.ok((notes.items || notes).some((x) => /Gemma .* te pide tus días/.test(x.text)));
  const req = service.call(lasha, 'getYear', { year: 2027 }).requests.find((x) => x.type === 'dias');
  assert.ok(req);
  // Lasha acepta: se intercambian las quincenas.
  service.call(lasha, 'respondDays', { id: req.id, accept: true });
  const fin = service.call(admin, 'getYear', { year: 2027 });
  assert.equal(fin.vacations.find((v) => v.id === g.id).start, l.start);
  assert.equal(fin.vacations.find((v) => v.id === l.id).start, g.start);
  // Fechas en verano: no se puede.
  err(() => service.call(gemma, 'moveMyVacation', { year: 2027, id: g.id, start: '2027-07-01', end: '2027-07-15' }));
});
