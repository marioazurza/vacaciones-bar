import { analyze, newIssues, describeIssue, workerStats, checkPeriodShape } from '../shared/rules.js';

/** Prepara los datos del año para pintar el calendario. */
export function buildCal(data, { vacations, extraReinforcements = [] } = {}) {
  const vs = vacations ?? data.vacations;
  const reinforcements = [...data.reinforcements, ...extraReinforcements];
  const analysis = analyze({ year: data.year, staff: data.staff, vacations: vs, minimums: data.minimums, reinforcements, blocked: data.blocked, maxOffPerShift: data.periodRules?.maxOffPerShift, wholeTeam: data.periodRules?.wholeTeam || [], maxOffPerShiftAll: data.periodRules?.maxOffPerShiftAll ?? null });
  return {
    year: data.year,
    staff: data.staff,
    staffById: new Map(data.staff.map((s) => [s.worker_id, s])),
    vacations: vs,
    reinforcements,
    blocked: data.blocked,
    analysis,
    today: data.today,
    minimums: data.minimums,
    periodRules: data.periodRules,
  };
}

export function nameFn(data) {
  const m = new Map(data.staff.map((s) => [s.worker_id, s.name]));
  return (id) => m.get(id) || 'Trabajador';
}

/**
 * Validación en tiempo real: devuelve los textos de los conflictos que provocaría
 * pasar del calendario actual al propuesto (misma lógica que el servidor).
 */
export function liveCheck(data, vacationsAfter, { year = data.year, start, end } = {}) {
  if (start !== undefined) {
    const err = checkPeriodShape(start, end, year);
    if (err) return [err];
    const L = data.periodRules?.periodLength || 0;
    const len = Math.round((Date.parse(end) - Date.parse(start)) / 864e5) + 1;
    if (L && len !== L) return [`Cada periodo de vacaciones debe ser de ${L} días seguidos.`];
  }
  const base = { year: data.year, staff: data.staff, minimums: data.minimums, reinforcements: data.reinforcements, blocked: data.blocked, maxOffPerShift: data.periodRules?.maxOffPerShift, wholeTeam: data.periodRules?.wholeTeam || [], maxOffPerShiftAll: data.periodRules?.maxOffPerShiftAll ?? null };
  const before = analyze({ ...base, vacations: data.vacations }).issues;
  const after = analyze({ ...base, vacations: vacationsAfter }).issues;
  const bad = newIssues(before, after);
  const nameOf = nameFn(data);
  const lines = bad.slice(0, 10).map((i) => describeIssue(i, nameOf));
  if (bad.length > 10) lines.push(`… y ${bad.length - 10} conflictos más.`);
  return lines;
}

export function statsFor(data, workerId, vacations = data.vacations) {
  const s = data.staff.find((x) => x.worker_id === workerId);
  return s ? workerStats(s, vacations, data.today) : null;
}
