import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openRepo } from '../server/db.js';
import { createService, ApiError } from '../shared/service.js';

function setup({ periodLength = 0 } = {}) {
  const repo = openRepo(':memory:');
  let n = 0;
  const service = createService({
    repo,
    hashPassword: (p) => `x:${p}`,
    verifyPassword: (p, h) => h === `x:${p}`,
    randomToken: () => `t${++n}`,
    today: () => '2026-11-24',
  });
  service.seed({ withDemoPlan: false });
  const login = (u, p) => service.call(null, 'login', { username: u, password: p }).token;
  const admin = login('admin', 'admin');
  service.call(admin, 'savePeriodRules', { periodLength });
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

test('periodos fijos de 15 días: el generador da 2 × 15 a todos y propone suplentes en cocina', () => {
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
