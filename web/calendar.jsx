import { useState } from 'preact/hooks';
import {
  MONTHS, WEEKDAYS, WEEKDAYS_SHORT, dateFromIndex, dayIndex, daysInMonth, dow, formatDate, formatRange,
  periodLength, addDays, weekStart,
} from '../shared/dates.js';
import { GROUPS, colorClass, groupLabel, SHIFTS, TEAMS } from '../shared/rules.js';
import { Modal, GroupDot, Alert } from './ui.jsx';

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
      if (G.deficit[i] > 0) bad = true;
      else if (offHere.length > 0 && G.available[i] === G.need[i]) full = true;
    }
    for (const id of shown) marks.push({ id, cls: colorClass(g.team, g.shift) });
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
                const cls = ['dcell', we && 'we', info.bad && 'bad', !info.bad && info.full && 'full', cal.analysis.blockedDay[i] && 'blocked', date === cal.today && 'today'].filter(Boolean).join(' ');
                const title = `${formatDate(date, { weekday: true })}${info.marks.length ? `\nDe vacaciones: ${info.marks.map((x) => nameOf(x.id)).join(', ')}` : ''}${info.bad ? '\n⚠ Falta personal' : ''}`;
                return (
                  <div class={cls} key={d} title={title} onClick={() => onDay(date)}>
                    <span class="n">{d + 1}</span>
                    <span class="marks">{info.marks.slice(0, 8).map((x) => <i key={x.id} class={x.cls} />)}</span>
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

// ---------- Vista mensual (filas por trabajador) ----------
export function MonthView({ cal, filters, month, onDay, onBar, onPick, previewIds, fixedLength = 0 }) {
  const [sel, setSel] = useState(null);
  const n = daysInMonth(cal.year, month);
  const first = `${cal.year}-${String(month + 1).padStart(2, '0')}-01`;
  const last = addDays(first, n - 1);
  const i0 = dayIndex(first, cal.year);
  const staff = applyFilters(cal.staff, filters);
  const cols = `minmax(150px, 190px) repeat(${n}, minmax(32px, 1fr))`;
  let row = 2;
  const items = [];
  const dayCol = (date) => 2 + (Number(date.slice(8, 10)) - 1);

  items.push(<div class="g-name" style={{ gridRow: 1, gridColumn: 1, zIndex: 4 }} key="hn"><b>{MONTHS[month]} {cal.year}</b></div>);
  for (let d = 0; d < n; d++) {
    const date = dateFromIndex(cal.year, i0 + d);
    items.push(
      <div key={`h${d}`} class={`g-head ${dow(date) >= 4 ? 'we' : ''} ${date === cal.today ? 'today' : ''}`} style={{ gridRow: 1, gridColumn: 2 + d }} onClick={() => onDay(date)}>
        {WEEKDAYS_SHORT[dow(date)]}<b>{d + 1}</b>
      </div>,
    );
  }

  for (const g of GROUPS) {
    const members = staff.filter((s) => s.team === g.team && s.shift === g.shift);
    if (!members.length) continue;
    const G = cal.analysis.groups[g.key];
    items.push(<div class="g-group" style={{ gridRow: row++ }} key={`g${g.key}`}><GroupDot team={g.team} shift={g.shift} /> {groupLabel(g.team, g.shift)} <span class="muted" style="text-transform:none;font-weight:500">· {members.length} personas</span></div>);
    for (const s of members) {
      const r = row++;
      items.push(<div class="g-name" style={{ gridRow: r, gridColumn: 1 }} key={`n${s.worker_id}`} title={s.name}><span class={`dot ${colorClass(s.team, s.shift)}`} />{s.name}</div>);
      for (let d = 0; d < n; d++) {
        const i = i0 + d;
        const date = dateFromIndex(cal.year, i);
        const isSel = sel && sel.worker_id === s.worker_id && sel.date === date;
        items.push(
          <div key={`c${s.worker_id}-${d}`} class={`g-cell ${dow(date) >= 4 ? 'we' : ''} ${cal.analysis.blockedDay[i] ? 'blocked' : ''} ${onPick ? 'pick' : ''} ${isSel ? 'sel' : ''}`}
            style={{ gridRow: r, gridColumn: 2 + d }}
            title={onPick ? (sel ? 'Haz clic en el último día del periodo' : 'Haz clic en el primer día del periodo') : ''}
            onClick={onPick ? () => {
              if (fixedLength) { onPick(s.worker_id, date, addDays(date, fixedLength - 1)); return; }
              if (!sel || sel.worker_id !== s.worker_id) setSel({ worker_id: s.worker_id, date });
              else { const a = sel.date < date ? sel.date : date, b = sel.date < date ? date : sel.date; setSel(null); onPick(s.worker_id, a, b); }
            } : null} />,
        );
      }
      for (const v of cal.vacations) {
        if (v.worker_id !== s.worker_id || v.end < first || v.start > last) continue;
        const a = v.start < first ? first : v.start, b = v.end > last ? last : v.end;
        const len = periodLength(v.start, v.end);
        const preview = previewIds?.has(v.id);
        items.push(
          <div key={`v${v.id}`} class={`g-bar ${colorClass(s.team, s.shift)} ${preview ? 'preview' : ''} ${onBar ? '' : 'ro'}`}
            style={{ gridRow: r, gridColumn: `${dayCol(a)} / ${dayCol(b) + 1}` }}
            title={`${s.name}: ${formatRange(v.start, v.end)} (${len} días)`}
            onClick={onBar ? (e) => { e.stopPropagation(); onBar(v); } : null}>
            {s.first_name} · {len}d
          </div>,
        );
      }
    }
    const subs = cal.reinforcements.filter((x) => x.team === g.team && x.shift === g.shift && x.start <= last && x.end >= first);
    if (subs.length) {
      const r = row++;
      items.push(<div class="g-name muted" style={{ gridRow: r, gridColumn: 1 }} key={`sn${g.key}`}>Suplentes</div>);
      for (let d = 0; d < n; d++) items.push(<div key={`sc${g.key}${d}`} class="g-cell" style={{ gridRow: r, gridColumn: 2 + d }} />);
      subs.forEach((x, k) => {
        const a = x.start < first ? first : x.start, b = x.end > last ? last : x.end;
        items.push(<div key={`s${g.key}${k}`} class={`g-bar sub ${colorClass(g.team, g.shift)}`} style={{ gridRow: r, gridColumn: `${dayCol(a)} / ${dayCol(b) + 1}` }} title={`${x.note || 'Suplente'}: ${formatRange(x.start, x.end)}`}>{x.note || 'Suplente'}</div>);
      });
    }
    const r = row++;
    items.push(<div class="g-name small muted" style={{ gridRow: r, gridColumn: 1 }} key={`cv${g.key}`}>Disponibles / mínimo</div>);
    for (let d = 0; d < n; d++) {
      const i = i0 + d;
      const cls = G.deficit[i] > 0 ? 'bad' : G.available[i] === G.need[i] && G.off[i].length ? 'full' : 'ok';
      items.push(<div key={`cv${g.key}${d}`} class={`g-cov ${cls}`} style={{ gridRow: r, gridColumn: 2 + d }} onClick={() => onDay(dateFromIndex(cal.year, i))} title="Ver el día">{G.available[i]}/{G.need[i]}</div>);
    }
  }
  if (!staff.length) return <div class="card empty">No hay trabajadores con estos filtros.</div>;
  return (
    <div class="stack">
      {onPick && <div class="small muted">{fixedLength ? `Para añadir vacaciones, haz clic en el primer día en la fila del trabajador (se cogen ${fixedLength} días seguidos). Haz clic en una barra para editarla.` : sel ? `Primer día: ${formatDate(sel.date)}. Ahora haz clic en el último día del periodo en la misma fila.` : 'Para añadir vacaciones, haz clic en el primer y el último día en la fila del trabajador. Haz clic en una barra para editarla.'}</div>}
      <div class="gantt-wrap"><div class="gantt" style={{ gridTemplateColumns: cols }}>{items}</div></div>
    </div>
  );
}

// ---------- Vista semanal ----------
export function WeekView({ cal, filters, start, onDay }) {
  const staff = applyFilters(cal.staff, filters);
  const visible = new Set(staff.map((s) => s.worker_id));
  const days = Array.from({ length: 7 }, (_, k) => addDays(start, k));
  return (
    <div class="gantt-wrap">
      <div class="week">
        <div class="wh" />
        {days.map((d) => <div key={d} class={`wh ${dow(d) >= 4 ? 'we' : ''}`} onClick={() => d.startsWith(String(cal.year)) && onDay(d)}>{WEEKDAYS[dow(d)]}<div class="small muted">{formatDate(d)}</div></div>)}
        {GROUPS.filter((g) => staff.some((s) => s.team === g.team && s.shift === g.shift)).map((g) => {
          const G = cal.analysis.groups[g.key];
          return [
            <div class="wg" key={g.key}><GroupDot team={g.team} shift={g.shift} />{groupLabel(g.team, g.shift)}</div>,
            ...days.map((d) => {
              if (!d.startsWith(String(cal.year))) return <div key={g.key + d} class="wc muted">Otro año</div>;
              const i = dayIndex(d, cal.year);
              const off = new Set(G.off[i]);
              const extra = G.extra[i];
              return (
                <div key={g.key + d} class={`wc ${G.deficit[i] ? 'bad' : ''}`}>
                  <span class={`badge ${G.deficit[i] ? 'bad' : G.available[i] === G.need[i] && off.size ? 'warn' : 'ok'}`}>{G.available[i]} de {G.need[i]} necesarios</span>
                  {G.members.filter((id) => visible.has(id)).map((id) => {
                    const s = cal.staffById.get(id);
                    return <span key={id} class={`chip ${colorClass(g.team, g.shift)} ${off.has(id) ? 'off' : ''}`} title={off.has(id) ? 'De vacaciones' : 'Trabajando'}>{off.has(id) ? '🌴 ' : ''}{s.first_name}</span>;
                  })}
                  {extra > 0 && <span class={`chip sub ${colorClass(g.team, g.shift)}`}>+{extra} suplente</span>}
                </div>
              );
            }),
          ];
        })}
      </div>
    </div>
  );
}

// ---------- Detalle de un día ----------
export function DayModal({ cal, date, onClose, canEdit, onAdd }) {
  const i = dayIndex(date, cal.year);
  const blocked = cal.analysis.blockedDay[i];
  return (
    <Modal title={formatDate(date, { weekday: true })} onClose={onClose} footer={<button class="btn" onClick={onClose}>Cerrar</button>}>
      {blocked && <Alert kind="warn" title="Fecha bloqueada">{blocked.reason ? ` ${blocked.reason}` : ''}</Alert>}
      {GROUPS.map((g) => {
        const G = cal.analysis.groups[g.key];
        const off = new Set(G.off[i]);
        const working = G.members.filter((id) => !off.has(id));
        const room = G.available[i] - G.need[i];
        return (
          <div key={g.key} class={`group-box ${G.deficit[i] ? 'bad' : ''}`}>
            <div class="row">
              <GroupDot team={g.team} shift={g.shift} /><b>{TEAMS[g.team]} · {SHIFTS[g.shift]}</b>
              <span class="spacer" />
              <span class={`badge ${G.deficit[i] ? 'bad' : room === 0 ? 'warn' : 'ok'}`}>
                {G.deficit[i] ? `Faltan ${G.deficit[i]}` : room === 0 ? 'Al límite' : `Puede faltar ${room} más`}
              </span>
            </div>
            <div class="small muted">Mínimo {G.need[i]} · Disponibles {G.available[i]}{G.extra[i] ? ` (con ${G.extra[i]} suplente)` : ''}</div>
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
