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
  strategy: 'rotacion', // 'rotacion' (uno detrás de otro en cada turno) | 'equilibrado'
  rotation: { start: null, spread: false, order: {} },
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
      slack[k] = g.room.map((r) => (Number.isFinite(r) ? r : 99));
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

/**
 * Rotación por turnos: en cada turno (equipo + turno) los trabajadores cogen sus periodos
 * uno detrás de otro, sin huecos. Cuando acaba uno empieza el siguiente.
 * opts: { periodLength, start:'AAAA-MM-DD', spread:boolean, order:{ 'sala-M':[ids] }, notBefore }
 *  - spread=false: las rondas van seguidas (ronda 1 y a continuación ronda 2).
 *  - spread=true: cada ronda empieza en una parte distinta del año (p. ej. enero y julio).
 */
export function generateRotation(ctx, opts = {}) {
  if (opts.spread) return generateRotationSpread(ctx, opts);
  const year = ctx.year;
  const N = daysInYear(year);
  const L = Number(opts.periodLength) || 15;
  const base = analyze({ ...ctx, vacations: [] });
  let start = opts.start && opts.start.startsWith(String(year)) ? opts.start : `${year}-01-01`;
  if (opts.notBefore && opts.notBefore > start) start = opts.notBefore;
  const s0 = dayIndex(start, year);
  const blocked = base.blockedDay.map((b) => !!b);
  const free = (a) => { if (a < s0 || a + L > N) return false; for (let i = a; i < a + L; i++) if (blocked[i]) return false; return true; };
  const vacations = [];
  const unassigned = {};

  // "Grupos de rotación": en un equipo que cuenta los dos turnos juntos (sala) hay una sola
  // cadena; si no, una por turno. Los grupos del mismo equipo van en paralelo (en cocina,
  // el de mañana y el de tarde pueden coincidir) y los equipos van uno detrás de otro, para
  // que un camarero y un cocinero no estén de vacaciones a la vez siempre que se pueda.
  const wholeTeams = new Set(ctx.wholeTeam || []);
  const pools = {};
  for (const s of ctx.staff) (pools[wholeTeams.has(s.team) ? s.team : groupKey(s.team, s.shift)] ||= { team: s.team, members: [] }).members.push(s);
  const lanes = {};
  for (const [key, pool] of Object.entries(pools)) {
    const wanted = opts.order?.[key] || (wholeTeams.has(key) ? Object.keys(opts.order || {}).filter((k) => k.startsWith(`${key}-`)).flatMap((k) => opts.order[k]) : []);
    const ordered = [...pool.members].sort((a, b) => {
      const ia = wanted.indexOf(a.worker_id), ib = wanted.indexOf(b.worker_id);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.name.localeCompare(b.name);
    });
    const rounds = Math.max(...ordered.map((m) => Math.floor((m.days ?? 30) / L)), 0);
    const queue = [];
    for (let r = 0; r < rounds; r++) for (const m of ordered) if (Math.floor((m.days ?? 30) / L) > r) queue.push(m);
    (lanes[pool.team] ||= []).push(queue);
  }
  // Cada equipo necesita tantos huecos como la cola más larga de sus grupos.
  const laneList = Object.entries(lanes).map(([team, queues]) => ({ team, queues, slots: Math.max(0, ...queues.map((q) => q.length)) }))
    .sort((a, b) => b.slots - a.slots);
  const occ = {}; // días ocupados por cada equipo
  for (const l of laneList) occ[l.team] = new Array(N).fill(0);
  const place = (lane, k, a) => {
    for (const q of lane.queues) {
      if (k >= q.length) continue;
      vacations.push({ worker_id: q[k].worker_id, start: dateFromIndex(year, a), end: dateFromIndex(year, a + L - 1) });
    }
    for (let i = a; i < a + L; i++) occ[lane.team][i] = 1;
  };

  // 1) Todo seguido en una sola cadena, saltando las fechas bloqueadas.
  let cursor = s0;
  const pending = [];
  const chain = [];
  for (const lane of laneList) {
    for (let k = 0; k < lane.slots; k++) {
      while (cursor + L <= N && !free(cursor)) cursor++;
      if (cursor + L <= N) { chain.push({ lane, k, a: cursor }); cursor += L; } else pending.push([lane, k]);
    }
  }
  // Si sobra algo, el último tramo libre se pega al final del año: así el hueco que queda
  // queda junto a otros periodos y lo que falta coincide lo menos posible.
  if (pending.length && chain.length) {
    const tailEnd = chain[chain.length - 1].a + L - 1;
    let w = tailEnd;
    while (w > s0 && !blocked[w - 1]) w--;
    let shift = 0;
    while (tailEnd + shift + 1 < N && !blocked[tailEnd + shift + 1]) shift++;
    if (shift) for (const c of chain) if (c.a >= w) c.a += shift;
  }
  for (const c of chain) place(c.lane, c.k, c.a);
  // 2) Lo que no cabe: en el hueco que menos coincida con otros equipos.
  for (const [lane, k] of pending) {
    let best = -1, bestCost = Infinity;
    for (let a = s0; a + L <= N; a++) {
      if (!free(a)) continue;
      let own = 0, cross = 0;
      for (let i = a; i < a + L; i++) { own += occ[lane.team][i]; for (const t in occ) if (t !== lane.team) cross += occ[t][i]; }
      if (own) continue;
      if (cross < bestCost) { bestCost = cross; best = a; }
    }
    if (best >= 0) place(lane, k, best);
    else for (const q of lane.queues) if (k < q.length) unassigned[q[k].worker_id] = (unassigned[q[k].worker_id] || 0) + L;
  }
  vacations.sort((x, y) => (x.start < y.start ? -1 : x.start > y.start ? 1 : 0));
  return finishRotation(ctx, vacations, unassigned, start);
}

// Cuántos días coinciden de vacaciones personas de equipos distintos (p. ej. un camarero y un cocinero).
export function crossTeamOverlap(ctx, vacations) {
  const year = ctx.year;
  const byId = new Map(ctx.staff.map((s) => [s.worker_id, s]));
  const days = new Map();
  for (const v of vacations) {
    const s = byId.get(v.worker_id);
    if (!s) continue;
    for (let i = Math.max(0, dayIndex(v.start, year)); i <= Math.min(daysInYear(year) - 1, dayIndex(v.end, year)); i++) {
      if (!days.has(i)) days.set(i, new Set());
      days.get(i).add(s.team);
    }
  }
  return [...days.values()].filter((t) => t.size > 1).length;
}

function finishRotation(ctx, vacations, unassigned, start) {
  const year = ctx.year;
  const final = analyze({ ...ctx, vacations: vacations.map((v, i) => ({ ...v, id: -1 - i })) });
  const monthLoad = new Array(12).fill(0);
  for (const v of vacations) for (let i = dayIndex(v.start, year); i <= dayIndex(v.end, year); i++) monthLoad[month(dateFromIndex(year, i))]++;
  return { vacations, reinforcements: [], unassigned, issues: final.issues, monthLoad, start, crossDays: crossTeamOverlap(ctx, vacations) };
}

// Variante "repartidas": cada grupo hace sus rondas separadas a lo largo del año.
function generateRotationSpread(ctx, opts = {}) {
  const year = ctx.year;
  const N = daysInYear(year);
  const L = Number(opts.periodLength) || 15;
  const base = analyze({ ...ctx, vacations: [] });
  let start = opts.start && opts.start.startsWith(String(year)) ? opts.start : firstMonday(year);
  if (opts.notBefore && opts.notBefore > start) start = opts.notBefore;
  const s0 = dayIndex(start, year);
  const blocked = base.blockedDay.map((b) => !!b);
  const vacations = [];
  const unassigned = {};

  const groups = {};
  // En los equipos que cuentan los dos turnos juntos, la cadena es una sola para todo el equipo.
  const wholeTeams = new Set(ctx.wholeTeam || []);
  for (const s of ctx.staff) (groups[wholeTeams.has(s.team) ? s.team : groupKey(s.team, s.shift)] ||= []).push(s);
  for (const [key, members] of Object.entries(groups)) {
    const wanted = opts.order?.[key] || (wholeTeams.has(key) ? Object.keys(opts.order || {}).filter((k) => k.startsWith(`${key}-`)).flatMap((k) => opts.order[k]) : []);
    const ordered = [...members].sort((a, b) => {
      const ia = wanted.indexOf(a.worker_id), ib = wanted.indexOf(b.worker_id);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.name.localeCompare(b.name);
    });
    const rounds = Math.max(...ordered.map((m) => Math.floor((m.days ?? 30) / L)), 0);
    let cursor = s0;
    for (let r = 0; r < rounds; r++) {
      if (opts.spread && r > 0) {
        let c = Math.max(cursor, s0 + Math.round((r * (N - s0)) / rounds));
        while (c < N && dow(dateFromIndex(year, c)) !== 0) c++; // empezar en lunes
        cursor = c;
      }
      for (const m of ordered) {
        if (Math.floor((m.days ?? 30) / L) <= r) continue;
        // Saltar fechas bloqueadas
        let tries = 0;
        while (tries++ < N) {
          let hit = -1;
          for (let i = cursor; i < cursor + L && i < N; i++) if (blocked[i]) { hit = i; break; }
          if (hit < 0) break;
          cursor = hit + 1;
        }
        if (cursor + L > N) { unassigned[m.worker_id] = (unassigned[m.worker_id] || 0) + L; continue; }
        vacations.push({ worker_id: m.worker_id, start: dateFromIndex(year, cursor), end: dateFromIndex(year, cursor + L - 1) });
        cursor += L;
      }
    }
  }
  return finishRotation(ctx, vacations, unassigned, start);
}

function firstMonday(year) {
  let d = `${year}-01-01`;
  for (let i = 0; i < 7; i++) { const x = dateFromIndex(year, i); if (dow(x) === 0) { d = x; break; } }
  return d;
}
