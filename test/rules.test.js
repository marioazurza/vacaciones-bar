import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, DEFAULT_MINIMUMS, validateChange } from '../shared/rules.js';
import { generateProposal } from '../shared/generator.js';
import { daysInYear, periodLength, dow, rangeDays, easterSunday } from '../shared/dates.js';

function team() {
  const staff = [];
  let id = 1;
  for (const [t, s, n] of [['cocina', 'M', 2], ['cocina', 'T', 2], ['sala', 'M', 4], ['sala', 'T', 4]]) {
    for (let i = 0; i < n; i++) staff.push({ worker_id: id, name: `W${id++}`, team: t, shift: s, days: 30 });
  }
  return staff;
}
const ctx = (year, vacations = [], extra = {}) => ({ year, staff: team(), vacations, minimums: DEFAULT_MINIMUMS, reinforcements: [], blocked: [], ...extra });

test('Pascua y años bisiestos', () => {
  assert.equal(easterSunday(2027), '2027-03-28');
  assert.equal(easterSunday(2028), '2028-04-16');
  assert.equal(daysInYear(2028), 366);
});

test('dos cocineros de mañana un lunes → conflicto', () => {
  // 2027-03-01 es lunes
  const a = analyze(ctx(2027, [{ id: 1, worker_id: 1, start: '2027-03-01', end: '2027-03-01' }, { id: 2, worker_id: 2, start: '2027-03-01', end: '2027-03-01' }]));
  assert.equal(a.issues.length, 1);
  assert.equal(a.issues[0].type, 'coverage');
  assert.equal(a.issues[0].team, 'cocina');
});

test('un cocinero un lunes → permitido; un sábado → conflicto', () => {
  assert.equal(analyze(ctx(2027, [{ id: 1, worker_id: 1, start: '2027-03-01', end: '2027-03-04' }])).issues.length, 0);
  const sat = analyze(ctx(2027, [{ id: 1, worker_id: 1, start: '2027-03-06', end: '2027-03-06' }]));
  assert.equal(sat.issues.length, 1);
});

test('con un suplente, un cocinero puede librar el fin de semana', () => {
  const v = [{ id: 1, worker_id: 1, start: '2027-03-01', end: '2027-03-14' }];
  assert.ok(analyze(ctx(2027, v)).issues.length > 0);
  assert.equal(analyze(ctx(2027, v, { reinforcements: [{ team: 'cocina', shift: 'M', start: '2027-03-01', end: '2027-03-14', count: 1 }] })).issues.length, 0);
});

test('camareros: 2 de mañana un sábado → conflicto; 2 un martes → bien; 3 un martes → conflicto', () => {
  const sat = '2027-03-06', tue = '2027-03-02';
  assert.equal(analyze(ctx(2027, [5, 6].map((w, i) => ({ id: i, worker_id: w, start: sat, end: sat })))).issues.length, 1);
  assert.equal(analyze(ctx(2027, [5, 6].map((w, i) => ({ id: i, worker_id: w, start: tue, end: tue })))).issues.length, 0);
  assert.equal(analyze(ctx(2027, [5, 6, 7].map((w, i) => ({ id: i, worker_id: w, start: tue, end: tue })))).issues.length, 1);
});

test('más de 30 días → conflicto', () => {
  const a = analyze(ctx(2027, [{ id: 1, worker_id: 5, start: '2027-03-01', end: '2027-03-31' }]));
  assert.ok(a.issues.some((i) => i.type === 'overlimit'));
});

test('validateChange solo devuelve conflictos nuevos', () => {
  const before = ctx(2027, [{ id: 1, worker_id: 1, start: '2027-03-06', end: '2027-03-06' }]);
  const after = ctx(2027, [{ id: 1, worker_id: 1, start: '2027-03-06', end: '2027-03-06' }, { id: 2, worker_id: 5, start: '2027-03-09', end: '2027-03-09' }]);
  assert.equal(validateChange(before, after).length, 0);
});

for (const year of [2027, 2028]) {
  for (const subs of [true, false]) {
    for (const mode of ['repartir', 'verano']) {
      test(`generador ${year} · suplentes=${subs} · ${mode}: 30 días a todos y sin conflictos`, () => {
        const c = ctx(year);
        const p = generateProposal(c, { mode, substitutes: { enabled: subs, length: 14 }, iterations: 12, seed: 7 });
        assert.deepEqual(p.unassigned, {});
        const final = analyze({ ...c, vacations: p.vacations.map((v, i) => ({ ...v, id: i })), reinforcements: p.reinforcements });
        assert.equal(final.issues.length, 0);
        for (const s of c.staff) {
          const days = p.vacations.filter((v) => v.worker_id === s.worker_id).reduce((a, v) => a + periodLength(v.start, v.end), 0);
          assert.equal(days, 30, `${s.name} tiene ${days} días`);
        }
        if (!subs) {
          // Sin suplentes, ningún cocinero puede librar de viernes a domingo
          for (const v of p.vacations.filter((x) => x.worker_id <= 4)) {
            for (const d of rangeDays(v.start, v.end)) assert.ok(dow(d) < 4, `cocinero libra en ${d}`);
          }
        } else {
          assert.equal(p.reinforcements.length, 4);
        }
      });
    }
  }
}

test('el generador respeta las fechas bloqueadas y las preferencias', () => {
  const c = ctx(2027, [], { blocked: [{ start: '2027-08-01', end: '2027-08-31', reason: 'Fiestas' }] });
  const p = generateProposal(c, { iterations: 8, seed: 3, preferences: [{ worker_id: 5, start: '2027-06-01', end: '2027-06-15' }] });
  for (const v of p.vacations) assert.ok(v.end < '2027-08-01' || v.start > '2027-08-31');
  assert.ok(p.vacations.some((v) => v.worker_id === 5 && v.start <= '2027-06-15' && v.end >= '2027-06-01'));
});
