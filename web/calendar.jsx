import { useState, useRef, useEffect } from 'preact/hooks';
import {
  MONTHS, WEEKDAYS, WEEKDAYS_SHORT, dateFromIndex, dayIndex, daysInMonth, dow, formatDate, formatRange,
  periodLength, addDays, weekStart, diffDays, formatShort,
} from '../shared/dates.js';
import { GROUPS, colorClass, groupLabel, SHIFTS, TEAMS } from '../shared/rules.js';
import { Modal, GroupDot, Alert, ShiftTag } from './ui.jsx';
import { holidayName } from '../shared/holidays.js';

/** Grupos y trabajadores que pasan los filtros. */
export function applyFilters(staff, f) {
  return staff.filter((s) => (!f.team || s.team === f.team) && (!f.shift || s.shift === f.shift) && (!f.worker || s.worker_id === Number(f.worker)));
}

export function Filters({ staff, value, onChange }) {
  const set = (k, v) => onChange({ ...value, [k]: v });
  return (
    <div class="filters">
      <select class="input" value={value.team} onChange={(e) => set('team', e.currentTarget.value)} aria-label="Equipo">
        <option value="">Todos los equipos</option>
        <option value="cocina">Cocina</option>
        <option value="sala">Camareros</option>
      </select>
      <select class="input" value={value.shift} onChange={(e) => set('shift', e.currentTarget.value)} aria-label="Turno">
        <option value="">Ambos turnos</option>
        <option value="M">Mañana</option>
        <option value="T">Tarde</option>
      </select>
      <select class="input" value={value.worker} onChange={(e) => set('worker', e.currentTarget.value)} aria-label="Trabajador">
        <option value="">Todo el equipo</option>
        {staff.map((s) => <option key={s.worker_id} value={s.worker_id}>{s.name}</option>)}
      </select>
      {(value.team || value.shift || value.worker) && <button class="btn ghost sm" onClick={() => onChange({ team: '', shift: '', worker: '' })}>Quitar filtros</button>}
    </div>
  );
}

function dayInfo(cal, i, visibleIds) {
  let bad = false, full = false;
  const marks = [];
  for (const g of GROUPS) {
    const G = cal.analysis.groups[g.key];
    if (!G) continue;
    const offHere = [...new Set(G.off[i])];
    const shown = offHere.filter((id) => visibleIds.has(id));
    if (G.members.some((id) => visibleIds.has(id)) || shown.length) {
      if (G.problem[i] > 0) bad = true;
      else if (offHere.length > 0 && G.room[i] <= 0) full = true;
    }
    for (const id of shown) marks.push({ id, team: g.team, cls: colorClass(g.team, g.shift) });
  }
  return { bad, full, marks };
}

// ---------- Vista anual ----------
export function YearView({ cal, filters, onDay, onMonth }) {
  const staff = applyFilters(cal.staff, filters);
  const visible = new Set(staff.map((s) => s.worker_id));
  const nameOf = (id) => cal.staffById.get(id)?.first_name || '?';
  return (
    <div class="year-grid">
      {MONTHS.map((mName, m) => {
        const n = daysInMonth(cal.year, m);
        const first = `${cal.year}-${String(m + 1).padStart(2, '0')}-01`;
        const lead = dow(first);
        const i0 = dayIndex(first, cal.year);
        let monthDays = 0;
        for (let d = 0; d < n; d++) monthDays += dayInfo(cal, i0 + d, visible).marks.length;
        return (
          <div class="mini-month" key={m}>
            <h3 onClick={() => onMonth(m)} title="Ver el mes">{mName} <span class="badge">{monthDays} días</span></h3>
            <div class="mini-grid">
              {WEEKDAYS_SHORT.map((w) => <div class="wd" key={w}>{w}</div>)}
              {Array.from({ length: lead }, (_, k) => <div class="dcell empty-cell" key={`e${k}`} />)}
              {Array.from({ length: n }, (_, d) => {
                const i = i0 + d;
                const date = dateFromIndex(cal.year, i);
                const info = dayInfo(cal, i, visible);
                const we = dow(date) >= 4;
                const cls = ['dcell', we && 'we', holidayName(date) && 'fest', info.bad && 'bad', cal.analysis.blockedDay[i] && 'blocked', date === cal.today && 'today'].filter(Boolean).join(' ');
                const title = `${formatDate(date, { weekday: true })}${holidayName(date) ? `\nFestivo: ${holidayName(date)}` : ''}${info.marks.length ? `\nDe vacaciones: ${info.marks.map((x) => nameOf(x.id)).join(', ')}` : ''}${info.bad ? '\n⚠ Falta personal' : ''}`;
                return (
                  <div class={cls} key={d} title={title} onClick={() => onDay(date)}>
                    <span class="n">{d + 1}</span>
                    <span class="marks">{info.marks.slice(0, 6).map((x) => <i key={x.id} class={`${x.cls} k-${x.team}`}>{x.team === 'cocina' ? 'C' : 'S'}</i>)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------- Línea de tiempo (filas por trabajador, barras continuas) ----------
// La usan la vista mensual y la semanal: cada periodo de vacaciones es una sola barra
// que ocupa todos sus días.
/**
 * Barra de vacaciones que se puede arrastrar para moverla de fecha.
 * Ratón: se arrastra directamente. Móvil: mantener pulsado un momento y luego arrastrar
 * (así deslizar sobre el calendario sigue moviendo los meses).
 */
function DragBar({ v, cls, style, title, label, onClick, onMove, days }) {
  const ref = useRef(null);
  const st = useRef(null);
  const [drag, setDrag] = useState(null); // { dx, delta }
  const dayW = () => { const el = ref.current; return el ? el.getBoundingClientRect().width / Math.max(1, days) : 30; };
  const update = (x) => {
    const S = st.current; if (!S) return;
    const dx = x - S.x0; const w = S.w;
    const delta = Math.round(dx / w);
    setDrag({ dx: delta * w, delta });
  };
  const finishRef = useRef(null);
  const finish = (cancel) => {
    const S = st.current; st.current = null;
    if (S?.timer) clearTimeout(S.timer);
    if (!S || !S.active) { setDrag(null); return false; }
    const d = drag?.delta || 0;
    setDrag(null);
    ref.current?.classList.remove('dragging');
    if (!cancel && d) onMove(v, d);
    return true;
  };
  finishRef.current = finish;
  useEffect(() => {
    const el = ref.current; if (!el || !onMove) return;
    const tm = (e) => {
      const S = st.current; if (!S) return;
      const t = e.touches[0];
      if (!S.active) {
        if (Math.abs(t.clientX - S.x0) > 8 || Math.abs(t.clientY - S.y0) > 8) { clearTimeout(S.timer); st.current = null; }
        return;
      }
      e.preventDefault();
      update(t.clientX);
    };
    el.addEventListener('touchmove', tm, { passive: false });
    return () => el.removeEventListener('touchmove', tm);
  });
  if (!onMove) return <div ref={ref} class={cls} style={style} title={title} onClick={onClick}>{label}</div>;
  const moved = drag && drag.delta;
  const preview = moved ? `${formatRange(addDays(v.start, drag.delta), addDays(v.end, drag.delta))}` : null;
  return (
    <div ref={ref} class={`${cls} drag ${drag ? 'dragging' : ''}`} title={title}
      style={{ ...style, transform: drag ? `translateX(${drag.dx}px)` : undefined }}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        st.current = { x0: e.clientX, y0: e.clientY, w: dayW(), active: false };
        const mm = (ev) => {
          const S = st.current; if (!S) return;
          if (!S.active && Math.abs(ev.clientX - S.x0) < 4) return;
          S.active = true; S.dragged = true; update(ev.clientX);
        };
        const mu = () => { window.removeEventListener('mousemove', mm); window.removeEventListener('mouseup', mu); const S = st.current; if (S && !S.active) { st.current = null; onClick?.(e); return; } finishRef.current(false); };
        window.addEventListener('mousemove', mm); window.addEventListener('mouseup', mu);
      }}
      onTouchStart={(e) => {
        const t = e.touches[0];
        const S = { x0: t.clientX, y0: t.clientY, w: dayW(), active: false };
        S.timer = setTimeout(() => { S.active = true; navigator.vibrate?.(15); setDrag({ dx: 0, delta: 0 }); }, 350);
        st.current = S;
      }}
      onTouchEnd={(e) => { const S = st.current; if (S && !S.active) { clearTimeout(S.timer); st.current = null; e.preventDefault(); onClick?.(e); return; } if (S) { e.preventDefault(); finishRef.current(false); } }}
      onTouchCancel={() => finishRef.current(true)}
      onContextMenu={(e) => { if (st.current?.active || drag) e.preventDefault(); }}
      onClick={(e) => e.stopPropagation()}>
      {preview ? <span class="stick-bar">↔ {preview}</span> : label}
    </div>
  );
}

function TimelineView({ cal, filters, from, n, title, wide, onDay, onBar, onPick, onMove, previewIds, fixedLength = 0, wrapRef, onScroll, months, fit }) {
  const [sel, setSel] = useState(null);
  const last = addDays(from, n - 1);
  const yStart = `${cal.year}-01-01`, yEnd = `${cal.year}-12-31`;
  const inYear = (d) => d >= yStart && d <= yEnd;
  const days = Array.from({ length: n }, (_, k) => addDays(from, k));
  const staff = applyFilters(cal.staff, filters);
  const nameCol = fit?.nameCol || 170;
  const tiny = !!fit?.tiny;
  const cols = months ? `${nameCol}px repeat(${n}, var(--colw, 34px))` : wide ? `minmax(110px, 190px) repeat(${n}, minmax(72px, 1fr))` : `minmax(150px, 190px) repeat(${n}, minmax(32px, 1fr))`;
  const col = (date) => 2 + diffDays(from, date);
  // Si hay máximo por turno y ningún mínimo, la fila resumen muestra cuántos faltan.
  const byMax = Object.values(cal.analysis.groups).some((G) => Number.isFinite(G.allowedOff[0])) && Object.values(cal.minimums).every((t) => Object.values(t).every((row) => row.every((x) => x === 0)));
  let row = 2;
  const items = [];

  items.push(<div class="g-name" style={{ gridRow: 1, gridColumn: 1, zIndex: 4 }} key="hn"><b>{title}</b></div>);
  days.forEach((date, d) => {
    items.push(
      <div key={`h${d}`} data-date={date} class={`g-head ${dow(date) >= 4 ? 'we' : ''} ${holidayName(date) ? 'fest' : ''} ${date === cal.today ? 'today' : ''} ${months && date.endsWith('-01') ? 'mstart' : ''} ${dow(date) === 0 || holidayName(date) ? 'num' : ''}`} title={holidayName(date) ? `Festivo: ${holidayName(date)}` : undefined} style={{ gridRow: 1, gridColumn: 2 + d }} onClick={() => inYear(date) && onDay(date)}>
        {months && <i class="g-month">{date.endsWith('-01') ? MONTHS[Number(date.slice(5, 7)) - 1] : '\u00a0'}</i>}
        {tiny ? '' : wide ? WEEKDAYS[dow(date)] : WEEKDAYS_SHORT[dow(date)]}<b>{tiny && !(dow(date) === 0 || date.endsWith('-01') || holidayName(date)) ? '\u00a0' : Number(date.slice(8, 10))}</b>
      </div>,
    );
  });

  const bar = (key, r, a, b, cls, label, tip, onClick, v) => {
    const aa = a < from ? from : a, bb = b > last ? last : b;
    const style = { gridRow: r, gridColumn: `${col(aa)} / ${col(bb) + 1}` };
    if (v && onMove) { items.push(<DragBar key={key} v={v} cls={cls} style={style} title={`${tip} · Arrastra para moverla`} label={label} onClick={onClick} onMove={onMove} days={diffDays(aa, bb) + 1} />); return; }
    items.push(<div key={key} class={cls} style={style} title={tip} onClick={onClick}>{label}</div>);
  };

  let lastShift = null;
  for (const g of GROUPS) {
    const members = staff.filter((s) => s.team === g.team && s.shift === g.shift);
    if (!members.length) continue;
    const G = cal.analysis.groups[g.key];
    if (g.shift !== lastShift) {
      lastShift = g.shift;
      items.push(<div class={`shift-band ${g.shift}`} style={{ gridRow: row++ }} key={`sb${g.shift}`}><span class="stick">{g.shift === 'M' ? '☀️ Turno de mañana' : '🌙 Turno de tarde'}</span></div>);
    }
    items.push(<div class="g-group" style={{ gridRow: row++ }} key={`g${g.key}`}><span class="stick"><GroupDot team={g.team} shift={g.shift} /> {TEAMS[g.team]} <span class="muted" style="text-transform:none;font-weight:500">· {SHIFTS[g.shift].toLowerCase()} · {members.length} personas</span></span></div>);
    for (const s of members) {
      const r = row++;
      items.push(<div class="g-name" style={{ gridRow: r, gridColumn: 1 }} key={`n${s.worker_id}`} title={s.name}><span class={`dot ${colorClass(s.team, s.shift)}`} />{tiny ? s.first_name.split(' ')[0] : s.name}</div>);
      days.forEach((date, d) => {
        const ok = inYear(date);
        const i = ok ? dayIndex(date, cal.year) : -1;
        const isSel = sel && sel.worker_id === s.worker_id && sel.date === date;
        const pick = onPick && ok;
        items.push(
          <div key={`c${s.worker_id}-${d}`} class={`g-cell ${months && date.endsWith('-01') ? 'mstart' : ''} ${dow(date) >= 4 ? 'we' : ''} ${ok && cal.analysis.blockedDay[i] ? 'blocked' : ''} ${pick ? 'pick' : ''} ${isSel ? 'sel' : ''}`}
            style={{ gridRow: r, gridColumn: 2 + d }}
            title={pick ? (fixedLength || !sel ? 'Haz clic en el primer día del periodo' : 'Haz clic en el último día del periodo') : ''}
            onClick={pick ? () => {
              if (fixedLength) { onPick(s.worker_id, date, addDays(date, fixedLength - 1)); return; }
              if (!sel || sel.worker_id !== s.worker_id) setSel({ worker_id: s.worker_id, date });
              else { const a = sel.date < date ? sel.date : date, b = sel.date < date ? date : sel.date; setSel(null); onPick(s.worker_id, a, b); }
            } : null} />,
        );
      });
      for (const v of cal.vacations) {
        if (v.worker_id !== s.worker_id || v.end < from || v.start > last) continue;
        const len = periodLength(v.start, v.end);
        const ico = s.team === 'cocina' ? '🍳' : '🍽️';
        const label = wide ? `${ico} ${s.first_name} · ${formatRange(v.start, v.end)} (${len} días)` : months ? <span class="stick-bar">{tiny ? s.first_name.split(' ')[0] : <>{ico} {s.first_name} · {formatRange(v.start, v.end)} ({len} días)</>}</span> : `${ico} ${s.first_name} · ${len}d`;
        bar(`v${v.id}`, r, v.start, v.end, `g-bar ${colorClass(s.team, s.shift)} ${previewIds?.has(v.id) ? 'preview' : ''} ${onBar ? '' : 'ro'}`,
          label, `${s.name}: ${formatRange(v.start, v.end)} (${len} días)`, onBar ? (e) => { e?.stopPropagation?.(); onBar(v); } : null, v);
      }
    }
    const subs = cal.reinforcements.filter((x) => x.team === g.team && x.shift === g.shift && x.start <= last && x.end >= from);
    if (subs.length) {
      const r = row++;
      items.push(<div class="g-name muted" style={{ gridRow: r, gridColumn: 1 }} key={`sn${g.key}`}>Suplentes</div>);
      days.forEach((_, d) => items.push(<div key={`sc${g.key}${d}`} class="g-cell" style={{ gridRow: r, gridColumn: 2 + d }} />));
      subs.forEach((x, k) => bar(`s${g.key}${k}`, r, x.start, x.end, `g-bar sub ${colorClass(g.team, g.shift)}`, wide ? `${x.note || 'Suplente'} · ${formatRange(x.start, x.end)}` : (x.note || 'Suplente'), `${x.note || 'Suplente'}: ${formatRange(x.start, x.end)}`, null));
    }
    const r = row++;
    items.push(<div class="g-name small muted" style={{ gridRow: r, gridColumn: 1 }} key={`cv${g.key}`}>{tiny ? (byMax ? 'Vacac.' : 'Disp.') : byMax ? ((cal.periodRules?.wholeTeam || []).includes(g.team) ? `Toda ${g.team === 'sala' ? 'la sala' : 'la cocina'} / máximo` : 'De vacaciones / máximo') : wide ? 'Trabajando / mínimo' : 'Disponibles / mínimo'}</div>);
    days.forEach((date, d) => {
      if (!inYear(date)) { items.push(<div key={`cv${g.key}${d}`} class="g-cov" style={{ gridRow: r, gridColumn: 2 + d }} />); return; }
      const i = dayIndex(date, cal.year);
      const cls = G.problem[i] > 0 ? 'bad' : G.room[i] <= 0 && G.off[i].length ? 'full' : 'ok';
      const txt = tiny ? '' : byMax ? (wide ? `${G.offCount[i]} de ${G.allowedOff[i]}` : `${G.offCount[i]}/${G.allowedOff[i]}`) : (wide ? `${G.available[i]} de ${G.need[i]}` : `${G.available[i]}/${G.need[i]}`);
      items.push(<div key={`cv${g.key}${d}`} class={`g-cov ${cls}`} style={{ gridRow: r, gridColumn: 2 + d }} onClick={() => onDay(date)} title="Ver el día">{txt}</div>);
    });
  }
  if (!staff.length) return <div class="card empty">No hay trabajadores con estos filtros.</div>;
  return (
    <div class="stack">
      {onPick && (!months || sel) && <div class="small muted">{fixedLength ? `Para añadir vacaciones, haz clic en el primer día en la fila del trabajador (se cogen ${fixedLength} días seguidos). Haz clic en una barra para editarla o arrástrala para moverla.` : sel ? `Primer día: ${formatDate(sel.date)}. Ahora haz clic en el último día del periodo en la misma fila.` : 'Para añadir vacaciones, haz clic en el primer y el último día en la fila del trabajador. Haz clic en una barra para editarla o arrástrala para moverla.'}</div>}
      <div class={`gantt-wrap ${fit?.tiny ? 'snap' : ''}`} ref={wrapRef} onScroll={onScroll} style={fit?.tiny ? { scrollPaddingLeft: `${nameCol}px` } : undefined}><div class={`gantt ${wide ? 'wide' : ''} ${months ? 'months' : ''} ${tiny ? 'tiny' : ''}`} data-rows={row} style={{ gridTemplateColumns: cols, ...(fit ? { '--colw': `${fit.colW}px`, '--rowh': `${fit.rowH}px`, '--namew': `${nameCol}px` } : {}) }}>{items}</div></div>
    </div>
  );
}

// ---------- Vista mensual ----------
// Todo el año en una sola línea de tiempo: se abre en el mes elegido y deslizando
// hacia la derecha se pasa directamente al mes siguiente.
export function MonthView({ cal, month, onMonth, ...rest }) {
  const wrap = useRef(null);
  const shown = useRef(-1); // mes que se ve ahora mismo (para no recolocar al deslizar)
  const from = `${cal.year}-01-01`;
  const n = diffDays(from, `${cal.year}-12-31`) + 1;
  const monthStart = (m) => `${cal.year}-${String(m + 1).padStart(2, '0')}-01`;
  // Posición de una cabecera de día dentro de la zona que se desliza (sin contar la columna de nombres).
  const posOf = (h) => wrap.current.scrollLeft + h.getBoundingClientRect().left - wrap.current.getBoundingClientRect().left - nameW();
  const nameW = () => wrap.current?.querySelector('.g-name')?.offsetWidth || 0;
  // Tamaño ajustado a la pantalla: el mes entero a lo ancho y todas las filas sin bajar,
  // lo más grande posible.
  const [fit, setFit] = useState(null);
  const fitRef = useRef(null);
  const shrink = useRef({ sig: '', n: 0 });
  const placed = useRef('');
  useEffect(() => {
    const measure = () => {
      const el = wrap.current;
      const g = el?.firstChild;
      if (!g) return;
      const W = window.innerWidth;
      const tiny = W < 600; // móvil: el mes entero a lo ancho, con nombres cortos
      const nameCol = tiny ? 62 : W < 1200 ? 150 : 170;
      const days = 31; // ancho fijo (el mes más largo) para que no salte al cambiar de mes
      const colW = Math.max(tiny ? 8 : 18, Math.min(64, Math.floor((el.clientWidth - nameCol - 2) / days)));
      const rows = Number(g.dataset.rows) || 20;
      const top = el.getBoundingClientRect().top;
      const navH = document.querySelector('.bottom-nav')?.offsetHeight || 0;
      const avail = window.innerHeight - top - 12 - (getComputedStyle(document.querySelector('.bottom-nav') || document.body).display === 'none' ? 0 : navH);
      const headH = g.querySelector('.g-head')?.offsetHeight || 42;
      const base = Math.max(tiny ? 16 : 18, Math.min(40, Math.floor((avail - headH - 4) / Math.max(1, rows - 2))));
      const sig = `${window.innerWidth}x${window.innerHeight}|${rows}|${month}`;
      if (shrink.current.sig !== sig) shrink.current = { sig, n: 0 };
      // Si aun así sobresale (filas con contenido más alto), se reduce un poco más (nunca vuelve a crecer).
      const over = el.getBoundingClientRect().bottom - (window.innerHeight - 8);
      if (fitRef.current && over > 0 && fitRef.current.rowH > 18 && shrink.current.n < 10) shrink.current.n++;
      const rowH = Math.max(tiny ? 16 : 18, base - shrink.current.n);
      setFit((f) => (f && f.colW === colW && f.rowH === rowH && f.nameCol === nameCol && f.tiny === tiny ? f : (fitRef.current = { colW, rowH, nameCol, tiny })));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  });
  useEffect(() => {
    const el = wrap.current;
    const key = `${month}|${fit?.colW}`;
    if (!el || placed.current === key) return;
    const h = el.querySelector(`[data-date="${monthStart(month)}"]`);
    if (h) {
      // En el móvil, si ya se veía el calendario, el cambio de mes se anima.
      if (fit?.tiny && placed.current.endsWith(`|${fit?.colW}`)) el.scrollTo({ left: posOf(h), behavior: 'smooth' });
      else el.scrollLeft = posOf(h);
    }
    shown.current = month;
    placed.current = key;
  }, [month, cal.year, fit?.colW]);
  const onScroll = () => {
    const el = wrap.current;
    if (!el) return;
    const x = el.scrollLeft + 60;
    let m = 0;
    for (let k = 0; k < 12; k++) {
      const h = el.querySelector(`[data-date="${monthStart(k)}"]`);
      if (h && posOf(h) <= x) m = k;
    }
    if (m !== shown.current) {
      shown.current = m;
      placed.current = `${m}|${fit?.colW}`; // ya está en su sitio: no recolocar mientras se desliza
      onMonth?.(m);
    }
  };
  return <TimelineView cal={cal} from={from} n={n} months fit={fit} title={`${cal.year} →`} wrapRef={wrap} onScroll={onScroll} {...rest} />;
}

// ---------- Vista semanal ----------
export function WeekView({ cal, start, ...rest }) {
  return <TimelineView cal={cal} from={start} n={7} wide title={`Semana del ${formatShort(start)}`} {...rest} />;
}

// ---------- Detalle de un día ----------
export function DayModal({ cal, date, onClose, canEdit, onAdd }) {
  const i = dayIndex(date, cal.year);
  const blocked = cal.analysis.blockedDay[i];
  return (
    <Modal title={formatDate(date, { weekday: true })} onClose={onClose} footer={<button class="btn" onClick={onClose}>Cerrar</button>}>
      {holidayName(date) && <Alert kind="info" title={`Festivo: ${holidayName(date)}`} />}
      {blocked && <Alert kind="warn" title="Fecha bloqueada">{blocked.reason ? ` ${blocked.reason}` : ''}</Alert>}
      {GROUPS.map((g) => {
        const G = cal.analysis.groups[g.key];
        const off = new Set(G.off[i]);
        const working = G.members.filter((id) => !off.has(id));
        const room = G.room[i];
        return (
          <div key={g.key} class={`group-box shift-${g.shift} ${G.problem[i] ? 'bad' : ''}`}>
            <div class="row">
              <ShiftTag shift={g.shift} /><GroupDot team={g.team} shift={g.shift} /><b>{TEAMS[g.team]}</b>
              <span class="spacer" />
              <span class={`badge ${G.problem[i] ? 'bad' : room <= 0 ? 'warn' : 'ok'}`}>
                {G.deficit[i] ? `Faltan ${G.deficit[i]}` : G.over[i] ? `Demasiados de vacaciones` : room <= 0 ? 'Al límite' : `Puede faltar ${room} más`}
              </span>
            </div>
            <div class="small muted">{Number.isFinite(G.allowedOff[i]) ? `Máximo ${G.allowedOff[i]} de vacaciones a la vez · ` : ''}{G.need[i] ? `Mínimo ${G.need[i]} · ` : ''}Trabajando {G.available[i]}{G.extra[i] ? ` (con ${G.extra[i]} suplente)` : ''}</div>
            <div class="row">
              <span class="small muted" style="width:90px">Trabajando</span>
              {working.length ? working.map((id) => <span key={id} class={`chip ${colorClass(g.team, g.shift)}`}>{cal.staffById.get(id)?.name}</span>) : <span class="small muted">Nadie</span>}
              {G.extra[i] > 0 && <span class={`chip sub ${colorClass(g.team, g.shift)}`}>Suplente × {G.extra[i]}</span>}
            </div>
            <div class="row">
              <span class="small muted" style="width:90px">Vacaciones</span>
              {off.size ? [...off].map((id) => <span key={id} class={`chip off ${colorClass(g.team, g.shift)}`}>🌴 {cal.staffById.get(id)?.name}</span>) : <span class="small muted">Nadie</span>}
            </div>
          </div>
        );
      })}
      {canEdit && <button class="btn primary" onClick={() => onAdd(date)}>＋ Añadir vacaciones desde este día</button>}
    </Modal>
  );
}

export { weekStart };
