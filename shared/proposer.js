// Propuestas escritas por el administrador, sin IA: entiende frases sencillas como
//   «Gemma del 10 al 24 de octubre», «Diego la segunda quincena de noviembre»,
//   «Edar desde el 2 de diciembre», «Tania en octubre».
// Devuelve qué ha entendido, qué no, y qué otros cambios harían falta para cumplir las reglas.
import { analyze, newIssues, describeIssue } from './rules.js';
import { generateRotation } from './generator.js';
import { addDays, dayIndex, dateFromIndex, daysInYear, formatRange, periodLength } from './dates.js';

const MONTHS = {
  enero: 1, ene: 1, febrero: 2, feb: 2, marzo: 3, mar: 3, abril: 4, abr: 4, mayo: 5, may: 5, junio: 6, jun: 6,
  julio: 7, jul: 7, agosto: 8, ago: 8, septiembre: 9, setiembre: 9, sep: 9, sept: 9, octubre: 10, oct: 10,
  noviembre: 11, nov: 11, diciembre: 12, dic: 12,
};
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
export const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const pad = (n) => String(n).padStart(2, '0');
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Fechas de una frase: { start, end } (end puede faltar) o null. */
export function parseDates(text, year, L = 15) {
  const t = norm(text);
  const d = (day, m) => (day >= 1 && day <= lastDay(year, m) ? `${year}-${pad(m)}-${pad(day)}` : null);
  let m;
  // «del 25 de septiembre al 9 de octubre»
  if ((m = t.match(new RegExp(`(\\d{1,2})\\s*(?:de\\s+)?(${MONTH_RE})\\b\\s*(?:al?|hasta(?:\\s+el)?|-|–)\\s*(?:el\\s+)?(\\d{1,2})\\s*(?:de\\s+)?(${MONTH_RE})\\b`)))) {
    return { start: d(+m[1], MONTHS[m[2]]), end: d(+m[3], MONTHS[m[4]]) };
  }
  // «del 3 al 17 de octubre», «3-17 octubre»
  if ((m = t.match(new RegExp(`(\\d{1,2})\\s*(?:al?|hasta(?:\\s+el)?|-|–)\\s*(?:el\\s+)?(\\d{1,2})\\s*(?:de\\s+)?(${MONTH_RE})\\b`)))) {
    return { start: d(+m[1], MONTHS[m[3]]), end: d(+m[2], MONTHS[m[3]]) };
  }
  // «3/10 al 17/10»
  if ((m = t.match(/(\d{1,2})\/(\d{1,2})\s*(?:al?|hasta|-|–)\s*(\d{1,2})\/(\d{1,2})/))) {
    return { start: d(+m[1], +m[2]), end: d(+m[3], +m[4]) };
  }
  // «primera / segunda quincena de noviembre»
  if ((m = t.match(new RegExp(`(primera|1a|1ª|segunda|2a|2ª)\\s+quincena\\s+(?:de\\s+)?(${MONTH_RE})\\b`)))) {
    const mo = MONTHS[m[2]];
    const first = /^(primera|1)/.test(m[1]);
    const start = first ? 1 : 16;
    return { start: d(start, mo), end: d(Math.min(start + L - 1, lastDay(year, mo)), mo) };
  }
  // «desde el 2 de diciembre», «el 2 de diciembre», «a partir del 2 de diciembre»
  if ((m = t.match(new RegExp(`(\\d{1,2})\\s*(?:de\\s+)?(${MONTH_RE})\\b`)))) {
    return { start: d(+m[1], MONTHS[m[2]]), end: null };
  }
  if ((m = t.match(/(\d{1,2})\/(\d{1,2})/))) return { start: d(+m[1], +m[2]), end: null };
  // «en octubre» → primera quincena
  if ((m = t.match(new RegExp(`\\b(${MONTH_RE})\\b`)))) {
    const mo = MONTHS[m[1]];
    return { start: d(1, mo), end: d(Math.min(L, lastDay(year, mo)), mo), month: true };
  }
  return null;
}

/** Persona nombrada en la frase (por nombre o nombre + apellido). */
export function findWorker(text, staff) {
  const t = ` ${norm(text).replace(/[^a-z0-9 ]+/g, ' ')} `;
  const hits = staff.filter((s) => {
    const first = norm(s.first_name || s.name).split(' ')[0];
    return t.includes(` ${first} `) || t.includes(` ${norm(s.name)} `);
  });
  return hits.length === 1 ? hits[0] : hits.length ? { ambiguous: hits } : null;
}

const splitSentences = (text) => String(text || '').split(/[\n.;]+|\s+y\s+(?=[A-ZÁÉÍÓÚÑa-záéíóúñ]+\s+(?:del?|desde|en|la|el|a partir)\b)/).map((s) => s.trim()).filter(Boolean);

/**
 * ctx: contexto de analyze() (año, plantilla con nombres, vacaciones...). L: días de cada periodo.
 * Devuelve { understood, notUnderstood, extra, moves, issues, ok }.
 */
export function proposeFromText(ctx, text, { L = 15, nameOf = (id) => `#${id}` } = {}) {
  const year = ctx.year;
  const N = daysInYear(year);
  const base = analyze(ctx);
  const understood = [], notUnderstood = [];
  let vacations = ctx.vacations.map((v) => ({ ...v }));
  const moved = new Map(); // id de vacación -> { from, to }
  const fixedIds = new Set();

  for (const sentence of splitSentences(text)) {
    const w = findWorker(sentence, ctx.staff);
    const dates = parseDates(sentence, year, L);
    if (!w || w.ambiguous || !dates || !dates.start) {
      notUnderstood.push({ text: sentence, why: !w ? 'No encuentro a qué persona se refiere.' : w.ambiguous ? `Hay varias personas con ese nombre (${w.ambiguous.map((s) => s.name).join(', ')}).` : 'No encuentro las fechas.' });
      continue;
    }
    const start = dates.start;
    const end = dates.end || addDays(start, L - 1);
    if (end < start) { notUnderstood.push({ text: sentence, why: 'La fecha de fin es anterior a la de inicio.' }); continue; }
    const len = periodLength(start, end);
    const mine = vacations.filter((v) => v.worker_id === w.worker_id && !fixedIds.has(v.id));
    if (!mine.length) { notUnderstood.push({ text: sentence, why: `${w.name} no tiene vacaciones que se puedan mover.` }); continue; }
    // Se mueve la quincena más cercana a las nuevas fechas (la del mismo lado del verano).
    const target = mine.sort((a, b) => Math.abs(dayIndex(a.start, year) - dayIndex(start, year)) - Math.abs(dayIndex(b.start, year) - dayIndex(start, year)))[0];
    if (len !== periodLength(target.start, target.end)) {
      notUnderstood.push({ text: sentence, why: `Son ${len} días y cada periodo tiene ${periodLength(target.start, target.end)}.` });
      continue;
    }
    moved.set(target.id, { worker_id: w.worker_id, from: { start: target.start, end: target.end }, to: { start, end } });
    fixedIds.add(target.id);
    vacations = vacations.map((v) => (v.id === target.id ? { ...v, start, end } : v));
    understood.push({ text: sentence, worker_id: w.worker_id, id: target.id, from: { start: target.start, end: target.end }, to: { start, end } });
  }

  // Cambios extra para que encaje: a quien choque, se le busca el hueco libre más cercano
  // (primero probando a darle las fechas antiguas del que se ha movido).
  const extra = [];
  const bad = (vs) => newIssues(base.issues, analyze({ ...ctx, vacations: vs }).issues);
  for (let round = 0; round < 12; round++) {
    const issues = bad(vacations);
    if (!issues.length) break;
    const others = [];
    for (const it of issues) for (const id of it.off || []) if (!understood.some((u) => u.worker_id === id) && !others.includes(id)) others.push(id);
    let fixed = false;
    for (const wid of others) {
      const dayList = issues.filter((i) => (i.off || []).includes(wid)).map((i) => i.date);
      const theirs = vacations.find((v) => v.worker_id === wid && !fixedIds.has(v.id) && dayList.some((d) => d >= v.start && d <= v.end));
      if (!theirs) continue;
      const len = periodLength(theirs.start, theirs.end);
      const before = bad(vacations).length;
      const i0 = dayIndex(theirs.start, year);
      const segOf = (i) => { let a = i; while (a > 0 && !base.blockedDay[a - 1]) a--; return a; };
      const seg0 = segOf(i0);
      const involves = (list) => list.filter((it) => (it.off || []).includes(wid) || it.worker_id === wid);
      let best = null;
      // Otras quincenas suyas: no se juntan dos en el mismo lado del verano si antes no lo estaban.
      const ownSegs = vacations.filter((v) => v.worker_id === wid && v.id !== theirs.id).map((v) => segOf(dayIndex(v.start, year)));
      const consider = (i, swap, push) => {
        if (i < 0 || i + len > N || i === i0) return;
        const seg = segOf(i);
        if (seg !== seg0 && ownSegs.includes(seg) && !ownSegs.includes(seg0)) return;
        const st = dateFromIndex(year, i), en = dateFromIndex(year, i + len - 1);
        const vs = vacations.map((v) => (v.id === theirs.id ? { ...v, start: st, end: en } : v));
        const after = bad(vs);
        const mine = involves(after);
        // Nunca en fechas bloqueadas ni solapando sus otras vacaciones.
        if (mine.some((it) => it.type === 'blocked' || it.type === 'overlap' || it.type === 'overlimit')) return;
        // Un hueco sin conflictos; o, si no lo hay, empujarle justo al lado (y luego se recoloca al siguiente).
        if (mine.length && !push) return;
        const cost = (mine.length ? 100000 : 0) + (seg === seg0 ? 0 : 5000) + Math.abs(i - i0) - (swap ? 50 : 0);
        if (!best || cost < best.cost) best = { vs, s: st, e: en, cost, swap: swap || null };
      };
      // 1) Intercambio: las fechas antiguas de alguien que se ha movido.
      for (const u of understood) if (periodLength(u.from.start, u.from.end) === len) consider(dayIndex(u.from.start, year), u.worker_id, false);
      // 2) Un hueco libre (mejor en el mismo lado del verano y cerca).
      for (let i = 0; i + len <= N; i++) consider(i, null, false);
      // 3) Si no hay hueco libre: justo antes o justo después de con quien choca.
      if (!best) {
        for (const it of issues) {
          if (!(it.off || []).includes(wid)) continue;
          for (const ow of it.off) {
            if (ow === wid) continue;
            for (const v of vacations) {
              if (v.worker_id !== ow || !(v.start <= theirs.end && v.end >= theirs.start) && !(it.date >= v.start && it.date <= v.end)) continue;
              consider(dayIndex(v.end, year) + 1, null, true);
              consider(dayIndex(v.start, year) - len, null, true);
            }
          }
        }
      }
      if (best) {
        vacations = best.vs;
        fixedIds.add(theirs.id);
        extra.push({ worker_id: wid, id: theirs.id, from: { start: theirs.start, end: theirs.end }, to: { start: best.s, end: best.e }, swap: best.swap || null });
        fixed = true;
        break;
      }
    }
    if (!fixed) break;
  }
  let remaining = bad(vacations);
  // Si con cambios sueltos no encaja, se rehace la rotación solo en el lado del verano afectado,
  // dejando fijas las fechas pedidas, lo pedido por los trabajadores y el resto del año.
  if (remaining.length && understood.length) {
    const segOf = (d) => { let a = dayIndex(d, year); while (a > 0 && !base.blockedDay[a - 1]) a--; return a; };
    const segs = new Set(understood.flatMap((u) => [segOf(u.from.start), segOf(u.to.start)]));
    const requested = new Map(understood.map((u) => [u.id, u.to]));
    const orig = ctx.vacations;
    const fixed = [], freed = [];
    for (const v of orig) {
      if (requested.has(v.id)) fixed.push({ ...v, ...requested.get(v.id) });
      else if (!segs.has(segOf(v.start)) || String(v.note || '').startsWith('Pedido')) fixed.push(v);
      else freed.push(v);
    }
    const gen = generateRotation({ ...ctx, vacations: [] }, { periodLength: L, fixed, aroundBlocked: true });
    if (!gen.issues.length && !Object.keys(gen.unassigned || {}).length) {
      const pool = new Map();
      for (const p of gen.vacations) (pool.get(p.worker_id) || pool.set(p.worker_id, []).get(p.worker_id)).push(p);
      const extra2 = [];
      let okMap = true;
      for (const v of freed.sort((a, b) => (a.start < b.start ? -1 : 1))) {
        const list = (pool.get(v.worker_id) || []).sort((a, b) => Math.abs(dayIndex(a.start, year) - dayIndex(v.start, year)) - Math.abs(dayIndex(b.start, year) - dayIndex(v.start, year)));
        const p = list.shift();
        if (!p) { okMap = false; break; }
        if (p.start !== v.start) extra2.push({ worker_id: v.worker_id, id: v.id, from: { start: v.start, end: v.end }, to: { start: p.start, end: p.end }, swap: null });
      }
      if (okMap) {
        const vs = orig.map((v) => (requested.has(v.id) ? { ...v, ...requested.get(v.id) } : v)).map((v) => { const x = extra2.find((e) => e.id === v.id); return x ? { ...v, ...x.to } : v; });
        const left = bad(vs);
        if (left.length < remaining.length) { extra.length = 0; extra.push(...extra2); remaining = left; }
      }
    }
  }
  const moves = [...understood, ...extra].map((m) => ({ id: m.id, start: m.to.start, end: m.to.end }));
  return {
    understood: understood.map((u) => ({ ...u, label: `${nameOf(u.worker_id)}: ${formatRange(u.from.start, u.from.end)} → ${formatRange(u.to.start, u.to.end)}` })),
    notUnderstood,
    extra: extra.map((x) => ({ ...x, label: `${nameOf(x.worker_id)}: ${formatRange(x.from.start, x.from.end)} → ${formatRange(x.to.start, x.to.end)}${x.swap ? ` (se queda las fechas de ${nameOf(x.swap)})` : ''}` })),
    moves,
    issues: remaining.slice(0, 10).map((i) => describeIssue(i, nameOf)).concat(remaining.length > 10 ? [`… y ${remaining.length - 10} más.`] : []),
    ok: remaining.length === 0 && moves.length > 0,
  };
}
