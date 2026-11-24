// Motor de reglas de cobertura. Se usa igual en el navegador (validación en tiempo real)
// y en el servidor (validación definitiva antes de guardar cualquier cambio).

import {
  WEEKDAYS, daysInYear, dateFromIndex, dayIndex, dow, formatDate, formatRange,
  isISODate, overlaps, periodLength, yearEnd, yearStart, todayISO,
} from './dates.js';

export const TEAMS = { cocina: 'Cocina', sala: 'Camareros' };
export const SHIFTS = { M: 'Mañana', T: 'Tarde' };
export const GROUPS = [
  { key: 'cocina-M', team: 'cocina', shift: 'M' },
  { key: 'cocina-T', team: 'cocina', shift: 'T' },
  { key: 'sala-M', team: 'sala', shift: 'M' },
  { key: 'sala-T', team: 'sala', shift: 'T' },
];

export const DEFAULT_ANNUAL_DAYS = 30;

// Regla principal: como máximo esta cantidad de personas de vacaciones a la vez en
// cada turno (equipo + turno). Un suplente permite una más. null = sin límite.
export const DEFAULT_MAX_OFF_PER_SHIFT = 1;

// Mínimos por día sin restricciones adicionales (la regla de "1 por turno" ya basta).
export const NO_MINIMUMS = {
  cocina: { M: [0, 0, 0, 0, 0, 0, 0], T: [0, 0, 0, 0, 0, 0, 0] },
  sala: { M: [0, 0, 0, 0, 0, 0, 0], T: [0, 0, 0, 0, 0, 0, 0] },
};

// Mínimos por día de la semana (lunes ... domingo).
export const DEFAULT_MINIMUMS = {
  cocina: { M: [1, 1, 1, 1, 2, 2, 2], T: [1, 1, 1, 1, 2, 2, 2] },
  sala: { M: [2, 2, 2, 2, 3, 3, 3], T: [2, 2, 2, 2, 3, 3, 3] },
};

export function groupKey(team, shift) {
  return `${team}-${shift}`;
}

export function groupLabel(team, shift) {
  return `${TEAMS[team]} ${SHIFTS[shift].toLowerCase()}`;
}

/** Clase de color: cocina, camareros de mañana, camareros de tarde. */
export function colorClass(team, shift) {
  return team === 'cocina' ? 'c-cocina' : shift === 'M' ? 'c-sala-m' : 'c-sala-t';
}

export function normalizeMinimums(m) {
  const out = {};
  for (const team of Object.keys(TEAMS)) {
    out[team] = {};
    for (const shift of Object.keys(SHIFTS)) {
      const row = m?.[team]?.[shift] ?? DEFAULT_MINIMUMS[team][shift];
      out[team][shift] = Array.from({ length: 7 }, (_, i) => Math.max(0, Math.floor(Number(row[i]) || 0)));
    }
  }
  return out;
}

/**
 * Analiza un año completo.
 * ctx = { year, staff:[{worker_id,team,shift,days,name}], vacations:[{id,worker_id,start,end}],
 *         minimums, reinforcements:[{team,shift,start,end,count}], blocked:[{start,end,reason}] }
 * Devuelve, por cada grupo (equipo + turno) y día, quién está de vacaciones, cuántos
 * trabajan, el mínimo y el déficit, además de la lista de incidencias.
 */
export function analyze(ctx) {
  const year = ctx.year;
  const N = daysInYear(year);
  const minimums = normalizeMinimums(ctx.minimums);
  const staffById = new Map(ctx.staff.map((s) => [s.worker_id, s]));
  const groups = {};
  for (const g of GROUPS) {
    const members = ctx.staff.filter((s) => s.team === g.team && s.shift === g.shift).map((s) => s.worker_id);
    groups[g.key] = {
      ...g,
      members,
      off: Array.from({ length: N }, () => []),
      extra: new Array(N).fill(0),
      need: Array.from({ length: N }, (_, i) => minimums[g.team][g.shift][dow(dateFromIndex(year, i))]),
    };
  }
  const blockedDay = new Array(N).fill(null);
  for (const b of ctx.blocked || []) {
    for (const i of indexesInYear(year, b.start, b.end)) blockedDay[i] = b;
  }
  for (const r of ctx.reinforcements || []) {
    const g = groups[groupKey(r.team, r.shift)];
    if (!g) continue;
    for (const i of indexesInYear(year, r.start, r.end)) g.extra[i] += Number(r.count) || 0;
  }

  const issues = [];
  const perWorker = {};
  for (const s of ctx.staff) perWorker[s.worker_id] = { assigned: 0, limit: s.days ?? DEFAULT_ANNUAL_DAYS, periods: [] };

  const byWorker = new Map();
  for (const v of ctx.vacations) {
    const s = staffById.get(v.worker_id);
    if (!s) continue;
    if (!byWorker.has(v.worker_id)) byWorker.set(v.worker_id, []);
    byWorker.get(v.worker_id).push(v);
    const g = groups[groupKey(s.team, s.shift)];
    const idx = indexesInYear(year, v.start, v.end);
    perWorker[v.worker_id].assigned += idx.length;
    perWorker[v.worker_id].periods.push(v);
    for (const i of idx) {
      g.off[i].push(v.worker_id);
      if (blockedDay[i]) {
        issues.push({ type: 'blocked', date: dateFromIndex(year, i), worker_id: v.worker_id, reason: blockedDay[i].reason || '' });
      }
    }
  }

  for (const [wid, list] of byWorker) {
    list.sort((a, b) => (a.start < b.start ? -1 : 1));
    for (let i = 1; i < list.length; i++) {
      if (list[i].start <= list[i - 1].end) issues.push({ type: 'overlap', worker_id: wid, a: list[i - 1], b: list[i] });
    }
    const pw = perWorker[wid];
    if (pw.assigned > pw.limit) issues.push({ type: 'overlimit', worker_id: wid, assigned: pw.assigned, limit: pw.limit });
  }

  const maxOff = ctx.maxOffPerShift == null || ctx.maxOffPerShift === '' ? null : Number(ctx.maxOffPerShift);
  for (const g of Object.values(groups)) {
    g.available = new Array(N);
    g.deficit = new Array(N);
    g.allowedOff = new Array(N);
    g.offCount = new Array(N);
    g.over = new Array(N);
    g.room = new Array(N);
    g.problem = new Array(N);
    for (let i = 0; i < N; i++) {
      // Un trabajador que aparece dos veces el mismo día (periodos solapados) solo falta una vez.
      const offCount = new Set(g.off[i]).size;
      g.offCount[i] = offCount;
      g.available[i] = g.members.length - offCount + g.extra[i];
      g.deficit[i] = Math.max(0, g.need[i] - g.available[i]);
      g.allowedOff[i] = maxOff == null ? Infinity : maxOff + g.extra[i];
      g.over[i] = Math.max(0, offCount - g.allowedOff[i]);
      g.room[i] = Math.min(g.available[i] - g.need[i], g.allowedOff[i] - offCount);
      g.problem[i] = g.deficit[i] || g.over[i];
      if (g.over[i] > 0) {
        issues.push({ type: 'shiftmax', date: dateFromIndex(year, i), team: g.team, shift: g.shift, max: g.allowedOff[i], count: offCount, off: [...new Set(g.off[i])], extra: g.extra[i] });
      }
      if (g.deficit[i] > 0) {
        issues.push({
          type: 'coverage', date: dateFromIndex(year, i), team: g.team, shift: g.shift,
          need: g.need[i], available: g.available[i], deficit: g.deficit[i], off: [...new Set(g.off[i])], extra: g.extra[i],
        });
      }
    }
  }

  return { year, N, groups, issues, perWorker, blockedDay, minimums };
}

function indexesInYear(year, start, end) {
  const a = start < yearStart(year) ? yearStart(year) : start;
  const b = end > yearEnd(year) ? yearEnd(year) : end;
  if (a > b) return [];
  const i0 = dayIndex(a, year), i1 = dayIndex(b, year);
  const out = [];
  for (let i = i0; i <= i1; i++) out.push(i);
  return out;
}

function issueKey(it) {
  switch (it.type) {
    case 'coverage': return `c|${it.date}|${it.team}|${it.shift}`;
    case 'shiftmax': return `m|${it.date}|${it.team}|${it.shift}`;
    case 'blocked': return `b|${it.date}|${it.worker_id}`;
    case 'overlap': return `o|${it.worker_id}|${it.a.start}|${it.b.start}`;
    case 'overlimit': return `l|${it.worker_id}`;
    default: return `x|${JSON.stringify(it)}`;
  }
}

function issueSeverity(it) {
  if (it.type === 'coverage') return it.deficit;
  if (it.type === 'shiftmax') return it.count;
  if (it.type === 'overlimit') return it.assigned;
  return 1;
}

/** Incidencias que aparecen o empeoran al pasar de "antes" a "después". */
export function newIssues(before, after) {
  const prev = new Map(before.map((it) => [issueKey(it), issueSeverity(it)]));
  return after.filter((it) => {
    const k = issueKey(it);
    return !prev.has(k) || issueSeverity(it) > prev.get(k);
  });
}

/** Comprueba un periodo antes de guardarlo (formato, año, límites). */
export function checkPeriodShape(start, end, year) {
  if (!isISODate(start) || !isISODate(end)) return 'Las fechas no son válidas.';
  if (end < start) return 'La fecha de fin es anterior a la de inicio.';
  if (year != null && (start.slice(0, 4) !== String(year) || end.slice(0, 4) !== String(year))) {
    return `El periodo debe estar dentro del año ${year}. Si cruza de año, divídelo en dos periodos.`;
  }
  return null;
}

/** Valida un cambio: devuelve las incidencias nuevas que provocaría. */
export function validateChange(ctxBefore, ctxAfter) {
  const before = analyze(ctxBefore).issues;
  const after = analyze(ctxAfter).issues;
  return newIssues(before, after);
}

/** Texto en español, claro para cualquier persona, de una incidencia. */
export function describeIssue(it, nameOf = (id) => `#${id}`) {
  switch (it.type) {
    case 'coverage': {
      const who = it.off.length ? ` De vacaciones: ${it.off.map(nameOf).join(', ')}.` : '';
      const sup = it.extra ? ` (incluye ${it.extra} suplente${it.extra > 1 ? 's' : ''})` : '';
      return `${formatDate(it.date, { weekday: true })} · ${groupLabel(it.team, it.shift)}: se necesitan ${it.need} y solo habría ${it.available} disponible${it.available === 1 ? '' : 's'}${sup}.${who}`;
    }
    case 'shiftmax':
      return `${formatDate(it.date, { weekday: true })} · ${groupLabel(it.team, it.shift)}: no puede haber más de ${it.max} persona${it.max === 1 ? '' : 's'} de vacaciones a la vez en el turno y habría ${it.count} (${it.off.map(nameOf).join(', ')}).`;
    case 'blocked':
      return `${formatDate(it.date, { weekday: true })} es una fecha bloqueada${it.reason ? ` (${it.reason})` : ''} y ${nameOf(it.worker_id)} tendría vacaciones.`;
    case 'overlap':
      return `${nameOf(it.worker_id)} tiene dos periodos que se solapan (${formatRange(it.a.start, it.a.end)} y ${formatRange(it.b.start, it.b.end)}).`;
    case 'overlimit':
      return `${nameOf(it.worker_id)} tendría ${it.assigned} días de vacaciones y el máximo es ${it.limit}.`;
    default:
      return 'Conflicto desconocido.';
  }
}

/** Agrupa incidencias de cobertura consecutivas para mostrarlas sin repetir 30 líneas. */
export function summarizeIssues(issues, nameOf, max = 8) {
  const lines = issues.slice(0, max).map((it) => describeIssue(it, nameOf));
  if (issues.length > max) lines.push(`… y ${issues.length - max} conflicto${issues.length - max > 1 ? 's' : ''} más.`);
  return lines;
}

/** Cuántos pueden faltar como máximo en un grupo un día concreto. */
export function maxOffOn(analysis, key, i) {
  const g = analysis.groups[key];
  return Math.max(0, g.members.length + g.extra[i] - g.need[i]);
}

/** Resumen de días por trabajador: total, asignados, disfrutados, pendientes. */
export function workerStats(staffMember, vacations, today = todayISO()) {
  const limit = staffMember.days ?? DEFAULT_ANNUAL_DAYS;
  let assigned = 0, enjoyed = 0;
  for (const v of vacations) {
    if (v.worker_id !== staffMember.worker_id) continue;
    const len = periodLength(v.start, v.end);
    assigned += len;
    if (v.end < today) enjoyed += len;
    else if (v.start < today) enjoyed += periodLength(v.start, today) - 1;
  }
  return { total: limit, assigned, enjoyed, pendingToEnjoy: assigned - enjoyed, unassigned: Math.max(0, limit - assigned) };
}

/** Texto del mínimo semanal, por ejemplo "L-J 1 · V-D 2". */
export function describeMinimumRow(row) {
  const parts = [];
  let i = 0;
  while (i < 7) {
    let j = i;
    while (j + 1 < 7 && row[j + 1] === row[i]) j++;
    parts.push(`${i === j ? WEEKDAYS[i].slice(0, 3) : `${WEEKDAYS[i].slice(0, 3)}-${WEEKDAYS[j].slice(0, 3)}`} ${row[i]}`);
    i = j + 1;
  }
  return parts.join(' · ');
}

/** ¿Se solapa con algún periodo de la lista? */
export function findOverlap(list, start, end, ignoreId) {
  return list.find((v) => v.id !== ignoreId && overlaps(v.start, v.end, start, end));
}
