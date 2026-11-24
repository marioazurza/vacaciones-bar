// Generador automático de propuestas de vacaciones.
//
// Idea: cada día y cada grupo (equipo + turno) tiene un "margen" = personas disponibles
// (incluidos suplentes) menos el mínimo exigido. Poner a alguien de vacaciones gasta 1 de
// margen en cada día del periodo; el margen nunca puede bajar de 0. El generador coloca
// los periodos uno a uno eligiendo, entre todas las fechas posibles, la de mejor
// puntuación (reparto equilibrado, meses distintos, preferencias, temporada alta...).
// Repite el proceso con distintas semillas y se queda con la mejor propuesta completa.

import { analyze, groupKey } from './rules.js';
import { dateFromIndex, dayIndex, daysInYear, month, peakSeasons, dow } from './dates.js';

export const DEFAULT_GENERATOR_SETTINGS = {
  mode: 'repartir', // 'repartir' (todo el año) | 'verano' (priorizar verano)
  preferredMonths: [], // 0 = enero ... 11 = diciembre
  split: [15, 10, 5], // reparto deseado de los días en periodos (si no hay duración fija)
  substitutes: { enabled: true, length: 14 }, // suplentes de cocina para un periodo seguido
  iterations: 40,
};

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function splitDays(total, split) {
  const out = [];
  let sum = 0;
  for (const x of split) {
    if (sum >= total) break;
    const take = Math.min(x, total - sum);
    out.push(take);
    sum += take;
  }
  if (sum < total) out.push(total - sum);
  return out.filter((x) => x > 0);
}

function chunk(total, size) {
  const out = [];
  let left = total;
  while (left > 0) { const t = Math.min(size, left); out.push(t); left -= t; }
  return out;
}

/**
 * ctx: igual que en analyze() (las vacaciones existentes se respetan si keepExisting).
 * opts: ajustes del generador + { preferences:[{worker_id,start,end}], notBefore:'AAAA-MM-DD', seed }
 */
export function generateProposal(ctx, opts = {}) {
  const o = { ...DEFAULT_GENERATOR_SETTINGS, ...opts, substitutes: { ...DEFAULT_GENERATOR_SETTINGS.substitutes, ...(opts.substitutes || {}) } };
  const keep = o.keepExisting !== false;
  const baseCtx = { ...ctx, vacations: keep ? ctx.vacations : [] };
  const base = analyze(baseCtx);
  const year = ctx.year;
  const N = daysInYear(year);
  const iterations = Math.max(1, Math.min(200, o.iterations | 0));

  // Datos fijos del año
  const isPeak = new Array(N).fill(false);
  const isSummer = new Array(N).fill(false);
  for (const p of peakSeasons(year)) {
    for (let i = Math.max(0, dayIndex(p.start, year)); i <= Math.min(N - 1, dayIndex(p.end, year)); i++) {
      isPeak[i] = true;
      if (p.key === 'verano') isSummer[i] = true;
    }
  }
  const monthOf = Array.from({ length: N }, (_, i) => month(dateFromIndex(year, i)));
  const dowOf = Array.from({ length: N }, (_, i) => dow(dateFromIndex(year, i)));
  const prefMonth = new Set(o.preferredMonths || []);
  const minStart = o.notBefore && o.notBefore.slice(0, 4) === String(year) ? dayIndex(o.notBefore, year) : o.notBefore > `${year}-12-31` ? N : 0;
  const blocked = base.blockedDay.map((b) => !!b);

  const prefsByWorker = new Map();
  for (const p of o.preferences || []) {
    if (!prefsByWorker.has(p.worker_id)) prefsByWorker.set(p.worker_id, new Array(N).fill(false));
    const arr = prefsByWorker.get(p.worker_id);
    for (let i = Math.max(0, dayIndex(p.start, year)); i <= Math.min(N - 1, dayIndex(p.end, year)); i++) if (i >= 0) arr[i] = true;
  }

  const workers = ctx.staff.map((s) => ({ ...s, key: groupKey(s.team, s.shift) }));

  let best = null;
  for (let it = 0; it < iterations; it++) {
    const res = runOnce(it);
    if (!best || res.cost < best.cost) best = res;
    if (best.unassignedTotal === 0 && it >= 8 && res.cost >= best.cost) {
      // Seguimos un poco más para buscar mejor reparto, pero sin desperdiciar tiempo.
    }
  }

  const final = analyze({ ...ctx, vacations: [...baseCtx.vacations, ...best.vacations], reinforcements: [...(ctx.reinforcements || []), ...best.reinforcements] });
  return {
    vacations: best.vacations,
    reinforcements: best.reinforcements,
    unassigned: best.unassigned,
    issues: final.issues,
    monthLoad: best.monthLoad,
    seed: best.seed,
  };

  function runOnce(iter) {
    const seed = (o.seed ?? 12345) + iter * 7919;
    const rand = rng(seed);
    // Margen por grupo y día
    const slack = {};
    const subUsed = {};
    for (const [k, g] of Object.entries(base.groups)) {
      slack[k] = g.available.map((a, i) => a - g.need[i]);
      subUsed[k] = new Array(N).fill(false);
    }
    const load = new Array(N).fill(0);
    for (const g of Object.values(base.groups)) for (let i = 0; i < N; i++) load[i] += new Set(g.off[i]).size;

    const own = new Map();
    const usedMonths = new Map();
    const peakAssigned = new Map();
    const remaining = new Map();
    for (const w of workers) {
      const ownArr = new Array(N).fill(false);
      const months = new Set();
      let assigned = 0;
      for (const v of baseCtx.vacations) {
        if (v.worker_id !== w.worker_id) continue;
        for (let i = Math.max(0, dayIndex(v.start, year)); i <= Math.min(N - 1, dayIndex(v.end, year)); i++) {
          ownArr[i] = true; months.add(monthOf[i]); assigned++;
        }
      }
      own.set(w.worker_id, ownArr);
      usedMonths.set(w.worker_id, months);
      peakAssigned.set(w.worker_id, 0);
      remaining.set(w.worker_id, Math.max(0, (w.days ?? 30) - assigned));
    }

    const ok = (w, i) => i >= minStart && !blocked[i] && !own.get(w.worker_id)[i] && slack[w.key][i] >= 1;
    const okSub = (w, i) => i >= minStart && !blocked[i] && !own.get(w.worker_id)[i] && slack[w.key][i] >= 0 && !subUsed[w.key][i];

    function runLengths(w, test) {
      const run = new Array(N + 1).fill(0);
      for (let i = N - 1; i >= 0; i--) run[i] = test(w, i) ? run[i + 1] + 1 : 0;
      return run;
    }

    // Plan de periodos por trabajador
    const queue = [];
    for (const w of workers) {
      const R = remaining.get(w.worker_id);
      if (R <= 0) continue;
      const maxRun = Math.max(0, ...runLengths(w, ok));
      const longest = Math.max(...o.split);
      let segs;
      const fixed = Number(o.periodLength) || 0;
      if (fixed > 0) {
        // Periodos de duración fija (p. ej. 2 × 15 días). En cocina, si no cabe sin
        // suplente, cada periodo lleva su suplente.
        const needSub = maxRun < fixed && o.substitutes.enabled && w.team === 'cocina';
        segs = Array.from({ length: Math.floor(R / fixed) }, () => ({ len: fixed, sub: needSub, fixed: true }));
      } else if (w.team === 'cocina' && o.substitutes.enabled && maxRun < Math.min(longest, R) && o.substitutes.length > maxRun) {
        const main = Math.min(o.substitutes.length, R);
        segs = [{ len: main, sub: true, main: true }, ...chunk(R - main, Math.max(1, maxRun)).map((len) => ({ len }))];
      } else if (maxRun > 0 && maxRun < longest) {
        segs = chunk(R, maxRun).map((len) => ({ len }));
      } else {
        segs = splitDays(R, o.split).map((len) => ({ len }));
      }
      segs.forEach((s, idx) => queue.push({ w, ...s, main: s.main || idx === 0, order: idx, tie: rand() }));
    }
    // Primero los periodos largos y los grupos con menos margen.
    queue.sort((a, b) => (b.sub - a.sub) || (a.order - b.order) || (b.len - a.len) || (a.tie - b.tie));

    const vacations = [];
    const reinforcements = [];
    let totalScore = 0;

    while (queue.length) {
      const seg = queue.shift();
      const w = seg.w;
      const test = seg.sub ? okSub : ok;
      const run = runLengths(w, test);
      let L = seg.len;
      let maxAvail = 0;
      for (let i = 0; i < N; i++) if (run[i] > maxAvail) maxAvail = run[i];
      if (seg.fixed && maxAvail < L) continue; // con duración fija no se recorta: quedará pendiente
      if (maxAvail === 0) {
        if (seg.sub) { queue.push({ ...seg, sub: false }); continue; }
        continue; // no cabe: quedará como pendiente
      }
      if (maxAvail < L) L = maxAvail;

      let bestS = -1, bestScore = Infinity;
      const ownArr = own.get(w.worker_id);
      const prefs = prefsByWorker.get(w.worker_id);
      for (let s = 0; s + L <= N; s++) {
        if (run[s] < L) continue;
        const sc = score(w, seg, s, L, ownArr, prefs) + rand() * 0.35;
        if (sc < bestScore) { bestScore = sc; bestS = s; }
      }
      if (bestS < 0) continue;
      totalScore += bestScore;

      const start = dateFromIndex(year, bestS);
      const end = dateFromIndex(year, bestS + L - 1);
      vacations.push({ worker_id: w.worker_id, start, end });
      if (seg.sub) {
        reinforcements.push({ team: w.team, shift: w.shift, start, end, count: 1, note: `Suplente para ${w.name || 'cocinero'}` });
      }
      for (let i = bestS; i < bestS + L; i++) {
        ownArr[i] = true;
        if (seg.sub) subUsed[w.key][i] = true; else slack[w.key][i] -= 1;
        load[i] += 1;
        usedMonths.get(w.worker_id).add(monthOf[i]);
        if (isPeak[i]) peakAssigned.set(w.worker_id, peakAssigned.get(w.worker_id) + 1);
      }
      if (L < seg.len) {
        // No cabía entero: lo que falta se reparte en trozos del tamaño posible.
        queue.unshift({ ...seg, len: seg.len - L, main: false, sub: false });
      }
    }

    const unassigned = {};
    let unassignedTotal = 0;
    for (const w of workers) {
      const got = vacations.filter((v) => v.worker_id === w.worker_id)
        .reduce((a, v) => a + dayIndex(v.end, year) - dayIndex(v.start, year) + 1, 0);
      const miss = remaining.get(w.worker_id) - got;
      if (miss > 0) { unassigned[w.worker_id] = miss; unassignedTotal += miss; }
    }
    const monthLoad = new Array(12).fill(0);
    for (let i = 0; i < N; i++) monthLoad[monthOf[i]] += load[i];
    const mean = monthLoad.reduce((a, b) => a + b, 0) / 12;
    const variance = monthLoad.reduce((a, b) => a + (b - mean) ** 2, 0) / 12;
    const cost = unassignedTotal * 1000 + totalScore + (o.mode === 'verano' ? 0 : variance / 200);
    return { vacations, reinforcements, unassigned, unassignedTotal, cost, monthLoad, seed };

    function score(w, seg, s, L, ownArr, prefs) {
      let loadSum = 0, tight = 0, peak = 0, summer = 0, prefM = 0, pref = 0;
      const months = new Set();
      for (let i = s; i < s + L; i++) {
        loadSum += load[i];
        if (!seg.sub && slack[w.key][i] === 1) tight += dowOf[i] >= 4 ? 1.5 : 1;
        if (isPeak[i]) peak++;
        if (isSummer[i]) summer++;
        if (prefMonth.has(monthOf[i])) prefM++;
        if (prefs && prefs[i]) pref++;
        months.add(monthOf[i]);
      }
      let sc = (loadSum / L) * 1.0 + (tight / L) * 0.6;
      // Repartir los periodos de cada persona en meses distintos y separados entre sí
      const used = usedMonths.get(w.worker_id);
      for (const m of months) if (used.has(m)) sc += 1.2;
      let gap = Infinity;
      for (let d = 1; d <= 45; d++) {
        if ((s - d >= 0 && ownArr[s - d]) || (s + L - 1 + d < N && ownArr[s + L - 1 + d])) { gap = d; break; }
      }
      if (gap < 45) sc += (45 - gap) / 15;
      if (gap === 1) sc += 2; // evitar pegar periodos (se verían como uno)
      // Temporada alta
      if (o.mode === 'verano') {
        if (seg.main) sc -= 3.5 * (summer / L);
        sc += 0.8 * ((peak - summer) / L);
      } else {
        // Ni vaciar ni llenar la temporada alta: penaliza poco y reparte entre personas
        sc += 0.2 * (peak / L) + (peak > 0 && peakAssigned.get(w.worker_id) > 0 ? 1.2 : 0);
      }
      sc -= 2.0 * (prefM / L);
      sc -= 6.0 * (pref / L);
      if (dowOf[s] === 0) sc -= 0.15; // empezar en lunes resulta más natural
      return sc;
    }
  }
}
