import { useEffect, useMemo, useState } from 'preact/hooks';
import { api, runtime } from './api.js';
import { Modal, Alert, Field, Stat, StatusBadge, GroupDot, Legend, ShiftTag, run, toast, ask } from './ui.jsx';
import { YearView, MonthView, WeekView, DayModal, Filters, weekStart } from './calendar.jsx';
import { VacationModal, ChangeRequestModal, SwapModal, PreferenceModal } from './editors.jsx';
import { buildCal, liveCheck, nameFn, statsFor } from './model.js';
import { MONTHS, MONTHS_SHORT, WEEKDAYS, addDays, formatDate, formatRange, periodLength, month as monthOf } from '../shared/dates.js';
import { GROUPS, TEAMS, SHIFTS, groupLabel, describeIssue, describeMinimumRow, workerStats, colorClass } from '../shared/rules.js';

// =============== CALENDARIO ===============
export function CalendarPage({ data, reload, isAdmin, me }) {
  const thisMonth = data.today.startsWith(String(data.year)) ? monthOf(data.today) : 0;
  // Siempre se abre en la vista mensual.
  const [view, setView] = useState('month');
  const [filters, setFilters] = useState({ team: '', shift: '', worker: '' });
  const [m, setM] = useState(thisMonth);
  // Semana inicial: la actual si estamos en ese año; si no, la primera semana completa del año.
  const firstWeek = () => (data.today.startsWith(String(data.year)) ? weekStart(data.today) : weekStart(addDays(`${data.year}-01-01`, 6)));
  const [wk, setWk] = useState(firstWeek);
  const [day, setDay] = useState(null);
  const [edit, setEdit] = useState(null);
  const cal = useMemo(() => buildCal(data), [data]);
  useEffect(() => { setM(thisMonth); setWk(firstWeek()); }, [data.year]);

  if (!isAdmin && data.status !== 'publicado') {
    return <div class="card empty"><h2>El calendario de {data.year} aún no está publicado</h2><p>Cuando el administrador lo publique podrás consultarlo aquí. Mientras tanto puedes indicar tus fechas preferidas en «Mis vacaciones».</p></div>;
  }
  const nameOf = nameFn(data);
  const issues = cal.analysis.issues;
  const goMonth = (mm) => { setM(mm); setView('month'); };
  // Arrastrar una barra: mueve el periodo entero los días indicados.
  const moveBar = async (v, d) => {
    const start = addDays(v.start, d), end = addDays(v.end, d);
    const ok = await run(() => api('saveVacation', { id: v.id, year: data.year, worker_id: v.worker_id, start, end }), `${nameOf(v.worker_id)}: ${formatRange(start, end)}`);
    if (ok) reload();
  };

  return (
    <>
      <div class="row">
        <h1 class="cal-h1">Calendario {data.year}</h1>
        <span class="spacer" />
        {view === 'month' && <div class="row"><button class="btn sm" onClick={() => setM((m + 11) % 12)}>‹</button><b style="min-width:90px;text-align:center">{MONTHS[m]}</b><button class="btn sm" onClick={() => setM((m + 1) % 12)}>›</button></div>}
        {view === 'week' && <div class="row"><button class="btn sm" onClick={() => setWk(addDays(wk, -7))}>‹</button><b style="min-width:150px;text-align:center">{formatRange(wk, addDays(wk, 6))}</b><button class="btn sm" onClick={() => setWk(addDays(wk, 7))}>›</button></div>}
        <div class="seg">
          {[['year', 'Año'], ['month', 'Mes'], ['week', 'Semana']].map(([k, t]) => <button key={k} class={view === k ? 'on' : ''} onClick={() => setView(k)}>{t}</button>)}
        </div>
        {isAdmin && <button class="btn primary" onClick={() => setEdit({ start: view === 'month' ? `${data.year}-${String(m + 1).padStart(2, '0')}-01` : undefined })}>＋ Vacaciones</button>}
      </div>
      {issues.length > 0 && (
        <Alert kind="bad" title={`Hay ${issues.length} conflicto${issues.length > 1 ? 's' : ''} en el calendario`} items={issues.slice(0, 5).map((i) => describeIssue(i, nameOf)).concat(issues.length > 5 ? [`… y ${issues.length - 5} más`] : [])} />
      )}
      <div class="row cal-tools">
        <Filters staff={data.staff} value={filters} onChange={setFilters} />
        <Legend conflicts={issues.length > 0} />
      </div>
      {view === 'year' && <YearView cal={cal} filters={filters} onDay={setDay} onMonth={goMonth} />}
      {view === 'month' && <MonthView cal={cal} filters={filters} month={m} onMonth={setM} onDay={setDay}
        onBar={isAdmin ? (v) => setEdit(v) : null} onMove={isAdmin ? moveBar : null}
        onPick={isAdmin ? (worker_id, start, end) => setEdit({ worker_id, start, end }) : null} fixedLength={data.periodRules?.periodLength || 0} />}
      {view === 'week' && <WeekView cal={cal} filters={filters} start={wk} onDay={setDay}
        onBar={isAdmin ? (v) => setEdit(v) : null} onMove={isAdmin ? moveBar : null}
        onPick={isAdmin ? (worker_id, start, end) => setEdit({ worker_id, start, end }) : null} fixedLength={data.periodRules?.periodLength || 0} />}
      {day && <DayModal cal={cal} date={day} onClose={() => setDay(null)} canEdit={isAdmin} onAdd={(d) => { setDay(null); setEdit({ start: d, end: d }); }} />}
      {edit && <VacationModal data={data} initial={edit} onClose={() => setEdit(null)} onDone={reload} />}
    </>
  );
}

// =============== MIS VACACIONES (trabajador) ===============
export function MyVacationsPage({ data, reload, me }) {
  const [change, setChange] = useState(null);
  const [swap, setSwap] = useState(null);
  const [pref, setPref] = useState(false);
  const staff = data.staff.find((s) => s.worker_id === me);
  if (!staff) return <div class="card empty">No formas parte de la plantilla de {data.year}.</div>;
  const published = data.status === 'publicado';
  const st = statsFor(data, me) || { total: staff.days, assigned: 0, enjoyed: 0, pendingToEnjoy: 0, unassigned: staff.days };
  const mine = data.vacations.filter((v) => v.worker_id === me).sort((a, b) => (a.start < b.start ? -1 : 1));
  const incoming = data.requests.filter((r) => r.type === 'intercambio' && r.target_id === me && r.status === 'esperando_companero');
  const nameOf = nameFn(data);

  return (
    <>
      <div class="row"><h1>Hola, {staff.first_name}</h1><ShiftTag shift={staff.shift} /><span class="badge"><GroupDot team={staff.team} shift={staff.shift} /> {TEAMS[staff.team]}</span></div>
      {incoming.map((r) => (
        <Alert key={r.id} kind="info" title={`${nameOf(r.requester_id)} te propone un intercambio`}>
          <div>Tú cogerías <b>{formatRange(r.data.a.start, r.data.a.end)}</b> y {nameOf(r.requester_id)} cogería tus días <b>{formatRange(r.data.b.start, r.data.b.end)}</b>.{r.comment ? ` «${r.comment}»` : ''}</div>
          <div class="row" style="margin-top:8px">
            <button class="btn ok sm" onClick={async () => (await run(() => api('respondSwap', { id: r.id, accept: true }), 'Aceptado. Falta la aprobación del administrador.')) && reload()}>Aceptar</button>
            <button class="btn sm" onClick={async () => (await run(() => api('respondSwap', { id: r.id, accept: false }), 'Propuesta rechazada')) && reload()}>Rechazar</button>
          </div>
        </Alert>
      ))}
      <div class="stats">
        <Stat label="Días al año" value={st.total} />
        <Stat label="Asignados" value={published ? st.assigned : '—'} />
        <Stat label="Disfrutados" value={published ? st.enjoyed : '—'} color="var(--ok)" />
        <Stat label="Pendientes de disfrutar" value={published ? st.pendingToEnjoy : '—'} color="var(--primary)" />
        <Stat label="Sin asignar" value={published ? st.unassigned : '—'} color={st.unassigned ? 'var(--warn)' : undefined} />
      </div>
      <div class="card">
        <div class="card-head"><h2>Mis periodos</h2><span class="spacer" />
          {published && <button class="btn sm" onClick={() => setSwap({})}>⇄ Proponer intercambio</button>}
          {published && st.unassigned >= Math.max(1, data.periodRules?.periodLength || 0) && <button class="btn primary sm" onClick={() => setChange({})}>＋ Pedir días</button>}
        </div>
        {!published ? <div class="empty">El calendario de {data.year} todavía no está publicado.</div>
          : !mine.length ? <div class="empty">No tienes vacaciones asignadas este año.</div>
            : mine.map((v) => {
              const past = v.end < data.today, started = v.start <= data.today;
              return (
                <div class="list-item" key={v.id}>
                  <span class={`dot ${colorClass(staff.team, staff.shift)}`} />
                  <div><b>{formatRange(v.start, v.end)}</b><div class="small muted">{periodLength(v.start, v.end)} días naturales · {WEEKDAYS[(new Date(v.start).getUTCDay() + 6) % 7]} a {WEEKDAYS[(new Date(v.end).getUTCDay() + 6) % 7].toLowerCase()}</div></div>
                  <span class="spacer" />
                  {past ? <span class="badge ok">Disfrutado</span> : started ? <span class="badge info">En curso</span> : <>
                    <button class="btn sm" onClick={() => setChange({ vacation: v })}>Cambiar</button>
                    <button class="btn sm" onClick={() => setSwap({ vacation: v })}>Intercambiar</button>
                  </>}
                </div>
              );
            })}
      </div>
      <div class="card">
        <div class="card-head"><h2>Mis solicitudes</h2></div>
        <RequestList data={data} reload={reload} me={me} isAdmin={false} />
      </div>
      <div class="card">
        <div class="card-head"><h2>Fechas preferidas</h2><span class="spacer" /><button class="btn sm" onClick={() => setPref(true)}>＋ Añadir</button></div>
        <div class="small muted" style="margin-bottom:8px">Sirven para que el generador tenga en cuenta tus preferencias al preparar el calendario.</div>
        {data.preferences.length ? data.preferences.map((p) => (
          <div class="list-item" key={p.id}><b>{formatRange(p.start, p.end)}</b><span class="muted small">{p.note}</span><span class="spacer" />
            <button class="btn ghost sm" onClick={async () => (await run(() => api('deletePreference', { id: p.id }))) && reload()}>Quitar</button></div>
        )) : <div class="empty">No has indicado preferencias.</div>}
      </div>
      {change && <ChangeRequestModal data={data} me={me} vacation={change.vacation} onClose={() => setChange(null)} onDone={reload} />}
      {swap && <SwapModal data={data} me={me} vacation={swap.vacation} onClose={() => setSwap(null)} onDone={reload} />}
      {pref && <PreferenceModal data={data} me={me} onClose={() => setPref(false)} onDone={reload} />}
    </>
  );
}

// =============== SOLICITUDES ===============
function describeRequest(r, nameOf) {
  if (r.type === 'cambio') {
    const parts = [];
    if (r.data.remove.length) parts.push(<span>Quitar <b>{r.data.remove.map((x) => formatRange(x.start, x.end)).join(', ')}</b></span>);
    if (r.data.add.length) parts.push(<span>{parts.length ? ' y pedir ' : 'Pedir '}<b>{r.data.add.map((x) => `${formatRange(x.start, x.end)} (${periodLength(x.start, x.end)} días)`).join(', ')}</b></span>);
    return parts;
  }
  return <span>{nameOf(r.requester_id)} coge <b>{formatRange(r.data.b.start, r.data.b.end)}</b> y {nameOf(r.target_id)} coge <b>{formatRange(r.data.a.start, r.data.a.end)}</b></span>;
}

function requestAfter(data, r) {
  if (r.type === 'cambio') {
    const rem = new Set(r.data.remove.map((x) => x.id));
    return [...data.vacations.filter((v) => !rem.has(v.id)), ...r.data.add.map((a, i) => ({ id: -1 - i, worker_id: r.requester_id, ...a }))];
  }
  return data.vacations.map((v) => (v.id === r.data.a.id ? { ...v, worker_id: r.target_id } : v.id === r.data.b.id ? { ...v, worker_id: r.requester_id } : v));
}

function RequestList({ data, reload, me, isAdmin, onlyOpen }) {
  const [resolve, setResolve] = useState(null);
  const nameOf = nameFn(data);
  let list = data.requests;
  if (onlyOpen === true) list = list.filter((r) => ['pendiente', 'esperando_companero'].includes(r.status));
  if (onlyOpen === false) list = list.filter((r) => !['pendiente', 'esperando_companero'].includes(r.status));
  if (!list.length) return <div class="empty">No hay solicitudes.</div>;
  return (
    <>
      {list.map((r) => (
        <div class="list-item" key={r.id}>
          <div style="flex:1;min-width:240px">
            <div class="row"><span class="badge">{r.type === 'cambio' ? 'Cambio' : 'Intercambio'}</span><StatusBadge status={r.status} />{(isAdmin || r.requester_id !== me) && <b>{nameOf(r.requester_id)}{r.target_id ? ` ↔ ${nameOf(r.target_id)}` : ''}</b>}</div>
            <div style="margin-top:4px">{describeRequest(r, nameOf)}</div>
            <div class="small muted">{new Date(r.created_at).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' })}{r.comment ? ` · «${r.comment}»` : ''}{r.admin_comment ? ` · Respuesta: ${r.admin_comment}` : ''}</div>
          </div>
          {isAdmin && r.status === 'pendiente' && <button class="btn primary sm" onClick={() => setResolve(r)}>Revisar</button>}
          {!isAdmin && r.requester_id === me && ['pendiente', 'esperando_companero'].includes(r.status) &&
            <button class="btn sm" onClick={async () => (await run(() => api('cancelRequest', { id: r.id }), 'Solicitud anulada')) && reload()}>Anular</button>}
        </div>
      ))}
      {resolve && <ResolveModal data={data} r={resolve} onClose={() => setResolve(null)} onDone={reload} />}
    </>
  );
}

function ResolveModal({ data, r, onClose, onDone }) {
  const [comment, setComment] = useState('');
  const nameOf = nameFn(data);
  const problems = useMemo(() => liveCheck(data, requestAfter(data, r)), [data, r]);
  const act = async (approve) => {
    const ok = await run(() => api('resolveRequest', { id: r.id, approve, comment }), approve ? 'Solicitud aprobada y calendario actualizado' : 'Solicitud rechazada');
    if (ok) { onDone(); onClose(); }
  };
  return (
    <Modal title={`Solicitud de ${r.type}`} onClose={onClose}
      footer={<><button class="btn danger" onClick={() => act(false)}>Rechazar</button><span class="spacer" /><button class="btn" onClick={onClose}>Cerrar</button><button class="btn ok" disabled={problems.length > 0} onClick={() => act(true)}>Aprobar</button></>}>
      <div><b>{nameOf(r.requester_id)}{r.target_id ? ` ↔ ${nameOf(r.target_id)}` : ''}</b></div>
      <div>{describeRequest(r, nameOf)}</div>
      {r.comment && <div class="small muted">Comentario: «{r.comment}»</div>}
      {problems.length ? <Alert kind="bad" title="No se puede aprobar: dejaría al bar sin la cobertura mínima" items={problems} /> : <Alert kind="ok" title="Se cumple la cobertura mínima todos los días afectados." />}
      <Field label="Respuesta para el trabajador (opcional)"><input class="input" value={comment} onInput={(e) => setComment(e.currentTarget.value)} /></Field>
    </Modal>
  );
}

export function RequestsPage({ data, reload, isAdmin, me }) {
  return (
    <>
      <h1>Solicitudes {data.year}</h1>
      <div class="card"><div class="card-head"><h2>Abiertas</h2></div><RequestList data={data} reload={reload} me={me} isAdmin={isAdmin} onlyOpen={true} /></div>
      <div class="card"><div class="card-head"><h2>Cerradas</h2></div><RequestList data={data} reload={reload} me={me} isAdmin={isAdmin} onlyOpen={false} /></div>
    </>
  );
}

// =============== EQUIPO (admin) ===============
export function TeamPage({ data, reload, onYear }) {
  const [edit, setEdit] = useState(null);
  const nextYear = data.year + 1;
  const hasNext = data.years.some((y) => y.year === nextYear);
  const remove = async (s) => {
    if (!await ask(`¿Quitar a ${s.name} de la plantilla de ${data.year}? Se borrarán sus vacaciones de este año.`)) return;
    (await run(() => api('removeWorker', { id: s.worker_id, year: data.year }), 'Trabajador quitado')) && reload();
  };
  const duplicate = async () => {
    const ok = await run(() => api('createYear', { year: nextYear, copyFrom: data.year }), `Año ${nextYear} creado con la misma plantilla`);
    if (ok) onYear(nextYear);
  };
  return (
    <>
      <div class="row"><h1>Equipo {data.year}</h1><span class="spacer" />
        {!hasNext && <button class="btn" onClick={duplicate}>Duplicar plantilla para {nextYear}</button>}
        <button class="btn primary" onClick={() => setEdit({ team: 'sala', shift: 'M', days: 30 })}>＋ Trabajador</button>
      </div>
      {GROUPS.map((g) => {
        const list = data.staff.filter((s) => s.team === g.team && s.shift === g.shift);
        return (
          <div class={`card group-box shift-${g.shift}`} key={g.key}>
            <div class="card-head"><ShiftTag shift={g.shift} /><GroupDot team={g.team} shift={g.shift} /><h2>{TEAMS[g.team]}</h2><span class="badge">{list.length} personas</span>
              <span class="small muted">Mínimo: {describeMinimumRow(data.minimums[g.team][g.shift])}</span></div>
            <div class="table-wrap"><table class="table">
              <thead><tr><th>Nombre</th><th class="hide-mobile">Usuario</th><th>Días</th><th>Asignados</th><th class="hide-mobile">Disfrutados</th><th /></tr></thead>
              <tbody>{list.map((s) => {
                const st = workerStats(s, data.vacations, data.today);
                return (
                  <tr key={s.worker_id}>
                    <td><b>{s.name}</b>{s.flex ? <span class="badge" style="margin-left:6px">Suplente</span> : null}</td>
                    <td class="hide-mobile muted">{s.username}</td>
                    <td>{s.days}</td>
                    <td><span class={`badge ${st.assigned === s.days ? 'ok' : st.assigned > s.days ? 'bad' : 'warn'}`}>{st.assigned} / {s.days}</span></td>
                    <td class="hide-mobile">{st.enjoyed}</td>
                    <td style="text-align:right;white-space:nowrap"><button class="btn sm" onClick={() => setEdit(s)}>Editar</button> <button class="btn sm danger" onClick={() => remove(s)}>Quitar</button></td>
                  </tr>
                );
              })}</tbody>
            </table></div>
            {!list.length && <div class="empty">Nadie en este grupo.</div>}
          </div>
        );
      })}
      {edit && <WorkerModal data={data} initial={edit} onClose={() => setEdit(null)} onDone={reload} />}
    </>
  );
}

function WorkerModal({ data, initial, onClose, onDone }) {
  const [f, setF] = useState({ first_name: '', last_name: '', username: '', password: '', ...initial });
  const set = (k) => (e) => setF({ ...f, [k]: e.currentTarget.value });
  const save = async () => {
    const ok = await run(() => api('saveWorker', { id: initial.worker_id, year: data.year, first_name: f.first_name, last_name: f.last_name, team: f.team, shift: f.shift, days: Number(f.days), flex: !!f.flex, username: f.username, password: f.password }), 'Trabajador guardado');
    if (ok) { onDone(); onClose(); }
  };
  return (
    <Modal title={initial.worker_id ? 'Editar trabajador' : 'Nuevo trabajador'} onClose={onClose}
      footer={<><button class="btn" onClick={onClose}>Cancelar</button><button class="btn primary" onClick={save}>Guardar</button></>}>
      <div class="grid2">
        <Field label="Nombre"><input class="input" value={f.first_name} onInput={set('first_name')} /></Field>
        <Field label="Apellidos"><input class="input" value={f.last_name} onInput={set('last_name')} /></Field>
        <Field label="Puesto"><select class="input" value={f.team} onChange={set('team')}>{Object.entries(TEAMS).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
        <Field label="Turno"><select class="input" value={f.shift} onChange={set('shift')}>{Object.entries(SHIFTS).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
        <Field label="Días de vacaciones al año"><input class="input" type="number" min="0" max="60" value={f.days} onInput={set('days')} /></Field>
        <Field label="Usuario para entrar"><input class="input" value={f.username} onInput={set('username')} placeholder="se genera con el nombre" /></Field>
        <Field label={initial.worker_id ? 'Nueva contraseña (opcional)' : 'Contraseña (por defecto 1234)'}><input class="input" type="text" value={f.password} onInput={set('password')} /></Field>
      </div>
      <label class="row" style="gap:8px;margin:4px 0"><input type="checkbox" checked={!!f.flex} onChange={(e) => setF({ ...f, flex: e.currentTarget.checked })} /> Suplente: cubre las vacaciones de los demás (sus vacaciones van primero a antes del verano si no caben todos después)</label>
      <div class="small muted">Si cambias el puesto, el turno o los días, se comprueba que el calendario siga cumpliendo la cobertura mínima.</div>
    </Modal>
  );
}

// =============== GENERADOR (admin) ===============
export function GeneratorPage({ data, reload }) {
  const [s, setS] = useState(data.generator);
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(false);
  const [prop, setProp] = useState(null);
  const [pref, setPref] = useState(false);
  const [view, setView] = useState('year');
  const [m, setM] = useState(6);
  useEffect(() => { setS(data.generator); setProp(null); }, [data.year]);
  const nameOf = nameFn(data);

  const generate = async () => {
    setBusy(true);
    await new Promise((r) => setTimeout(r, 30));
    const saved = await run(() => api('saveGeneratorSettings', { settings: s }));
    if (saved) setS(saved);
    const p = await run(() => api('generate', { year: data.year, settings: saved || s, keepExisting: keep }));
    setBusy(false);
    if (p) setProp({ ...p, keep: p.replaceOnly ? false : keep });
  };
  const apply = async () => {
    const ok = await run(() => api('applyProposal', { year: data.year, vacations: prop.vacations, reinforcements: prop.reinforcements, replace: !prop.keep }), 'Propuesta aplicada. Puedes seguir ajustándola en el calendario.');
    if (ok) { setProp(null); reload(); }
  };

  const previewVacs = prop ? [...(prop.keep ? data.vacations : []), ...prop.vacations.map((v, i) => ({ ...v, id: -1000 - i }))] : null;
  const previewIds = prop ? new Set(prop.vacations.map((_, i) => -1000 - i)) : null;
  const cal = useMemo(() => (prop ? buildCal(data, { vacations: previewVacs, extraReinforcements: prop.reinforcements }) : null), [prop]);
  const rot = s.strategy !== 'equilibrado';
  const orderFor = (key) => {
    const members = data.staff.filter((st) => `${st.team}-${st.shift}` === key);
    const wanted = s.rotation?.order?.[key] || [];
    return [...members].sort((x, y) => { const ix = wanted.indexOf(x.worker_id), iy = wanted.indexOf(y.worker_id); return (ix < 0 ? 999 : ix) - (iy < 0 ? 999 : iy) || x.name.localeCompare(y.name); });
  };
  const move = (key, k, dir) => {
    const ids = orderFor(key).map((x) => x.worker_id);
    [ids[k], ids[k + dir]] = [ids[k + dir], ids[k]];
    setS({ ...s, rotation: { ...s.rotation, order: { ...(s.rotation?.order || {}), [key]: ids } } });
  };
  const toggleMonth = (mm) => setS({ ...s, preferredMonths: s.preferredMonths.includes(mm) ? s.preferredMonths.filter((x) => x !== mm) : [...s.preferredMonths, mm] });
  const maxLoad = prop ? Math.max(1, ...prop.monthLoad) : 1;

  return (
    <>
      <div class="row"><h1>Generador de propuestas {data.year}</h1>{data.status === 'publicado' && <span class="badge warn">Calendario ya publicado</span>}</div>
      <div class="card stack">
        <h2>Cómo quieres repartir las vacaciones</h2>
        <div class="seg">
          <button class={rot ? 'on' : ''} onClick={() => setS({ ...s, strategy: 'rotacion' })}>🔁 Rotación por turnos</button>
          <button class={!rot ? 'on' : ''} onClick={() => setS({ ...s, strategy: 'equilibrado' })}>Reparto automático</button>
        </div>
        {rot ? <>
          <div class="small muted">En cada turno, las vacaciones van una detrás de otra: cuando acaba un trabajador empieza el siguiente. Así nunca hay dos del mismo turno de vacaciones a la vez.</div>
          <div class="grid2">
            <Field label="Empieza la rotación el">
              <input class="input" type="date" value={s.rotation?.start || `${data.year}-01-04`} min={`${data.year}-01-01`} max={`${data.year}-12-31`} onInput={(e) => setS({ ...s, rotation: { ...s.rotation, start: e.currentTarget.value } })} />
            </Field>
            <Field label={`Las ${Math.floor(30 / (data.periodRules?.periodLength || 15))} vueltas de cada turno`}>
              <div class="seg">
                <button class={!s.rotation?.spread && s.rotation?.aroundBlocked !== false ? 'on' : ''} onClick={() => setS({ ...s, rotation: { ...s.rotation, spread: false, aroundBlocked: true } })}>Una antes y otra después del bloqueo</button>
                <button class={!s.rotation?.spread && s.rotation?.aroundBlocked === false ? 'on' : ''} onClick={() => setS({ ...s, rotation: { ...s.rotation, spread: false, aroundBlocked: false } })}>Seguidas</button>
                <button class={s.rotation?.spread ? 'on' : ''} onClick={() => setS({ ...s, rotation: { ...s.rotation, spread: true, aroundBlocked: false } })}>Repartidas en el año</button>
              </div>
            </Field>
          </div>
          <div>
            <div class="small muted" style="margin-bottom:8px">Orden de cada turno (usa las flechas para cambiarlo)</div>
            <div class="grid2" style="grid-template-columns:repeat(auto-fit, minmax(min(100%, 380px), 1fr))">{GROUPS.map((g) => {
              const list = orderFor(g.key);
              if (!list.length) return null;
              return (
                <div key={g.key} class={`group-box shift-${g.shift}`}>
                  <b class="row"><ShiftTag shift={g.shift} /> {TEAMS[g.team]}</b>
                  {list.map((st, k) => (
                    <div class="row" key={st.worker_id}>
                      <span class="badge">{k + 1}</span><span style="flex:1">{st.name}</span>
                      <button class="btn sm ghost" disabled={k === 0} aria-label="Subir" onClick={() => move(g.key, k, -1)}>↑</button>
                      <button class="btn sm ghost" disabled={k === list.length - 1} aria-label="Bajar" onClick={() => move(g.key, k, 1)}>↓</button>
                    </div>
                  ))}
                </div>
              );
            })}</div>
          </div>
          <Alert kind="warn" title="Al aplicar la rotación se sustituyen todas las vacaciones de este año en el calendario." />
        </> : <>
          <div class="seg">
            <button class={s.mode === 'repartir' ? 'on' : ''} onClick={() => setS({ ...s, mode: 'repartir' })}>Repartir durante todo el año</button>
            <button class={s.mode === 'verano' ? 'on' : ''} onClick={() => setS({ ...s, mode: 'verano' })}>Priorizar verano</button>
          </div>
          <Field label="Meses preferentes (opcional)">
            <div class="month-chips">{MONTHS_SHORT.map((t, i) => <button key={i} type="button" class={s.preferredMonths.includes(i) ? 'on' : ''} onClick={() => toggleMonth(i)}>{t}</button>)}</div>
          </Field>
          <label class="row"><input type="checkbox" checked={keep} onChange={(e) => setKeep(e.currentTarget.checked)} /> Mantener las vacaciones que ya están en el calendario y repartir solo los días pendientes</label>
          <div class="small muted">Las fechas bloqueadas y las preferencias de cada trabajador se tienen en cuenta.</div>
        </>}
        {data.periodRules?.periodLength > 0 && <div class="small muted">Cada periodo dura {data.periodRules.periodLength} días seguidos{data.periodRules?.maxOffPerShift != null ? ` y en cada turno puede haber como máximo ${data.periodRules.maxOffPerShift} persona de vacaciones a la vez` : ''}. Se cambia en Ajustes.</div>}
        <div class="row"><button class="btn primary" disabled={busy} onClick={generate}>{busy ? 'Calculando…' : prop ? '↻ Generar otra propuesta' : '✨ Generar propuesta'}</button></div>
      </div>

      {prop && (
        <div class="card stack">
          <div class="card-head"><h2>Propuesta</h2><span class="badge info">Vista previa: aún no se ha guardado</span><span class="spacer" />
            <button class="btn" onClick={() => setProp(null)}>Descartar</button>
            <button class="btn ok" disabled={prop.issues.length > 0} onClick={apply}>Aplicar al calendario</button>
          </div>
          {prop.issues.length ? <Alert kind="bad" title="La propuesta tiene conflictos" items={prop.issues.slice(0, 6).map((i) => describeIssue(i, nameOf))} />
            : <Alert kind="ok" title="Cumple todas las reglas todos los días del año." />}
          {prop.crossDays > 0 && <Alert kind="info" title={`Un camarero y un cocinero coinciden de vacaciones ${prop.crossDays} día${prop.crossDays > 1 ? 's' : ''}`} items={['El generador ya las coloca para que coincidan lo menos posible con los días disponibles.']} />}
          {Object.keys(prop.unassigned).length > 0 && <Alert kind="warn" title="No se pudieron colocar todos los días" items={Object.entries(prop.unassigned).map(([id, n]) => `${nameOf(Number(id))}: faltan ${n} días`)} />}
          {prop.reinforcements.length > 0 && <Alert kind="info" title={`La propuesta incluye ${prop.reinforcements.length} periodos de suplente en cocina`} items={prop.reinforcements.map((r) => `${groupLabel(r.team, r.shift)}: ${formatRange(r.start, r.end)} (${r.note})`)} />}
          <div>
            <div class="small muted" style="margin-bottom:6px">Días de vacaciones por mes (todo el equipo)</div>
            <div class="bars">{prop.monthLoad.map((v, i) => <div key={i}><span>{v}</span><div class="b" style={{ height: `${(v / maxLoad) * 85}%` }} /><span>{MONTHS_SHORT[i]}</span></div>)}</div>
          </div>
          <div class="row"><div class="seg"><button class={view === 'year' ? 'on' : ''} onClick={() => setView('year')}>Año</button><button class={view === 'month' ? 'on' : ''} onClick={() => setView('month')}>Mes</button></div>
            {view === 'month' && <div class="row"><button class="btn sm" onClick={() => setM((m + 11) % 12)}>‹</button><b style="min-width:90px;text-align:center">{MONTHS[m]}</b><button class="btn sm" onClick={() => setM((m + 1) % 12)}>›</button></div>}
          </div>
          {view === 'year' ? <YearView cal={cal} filters={{}} onDay={() => {}} onMonth={(mm) => { setM(mm); setView('month'); }} />
            : <MonthView cal={cal} filters={{}} month={m} onMonth={setM} onDay={() => {}} previewIds={previewIds} />}
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Trabajador</th><th>Periodos propuestos</th><th>Días</th></tr></thead>
            <tbody>{data.staff.map((st) => {
              const vs = previewVacs.filter((v) => v.worker_id === st.worker_id).sort((a, b) => (a.start < b.start ? -1 : 1));
              return <tr key={st.worker_id}><td><GroupDot team={st.team} shift={st.shift} /> {st.name}</td><td class="small">{vs.map((v) => `${formatRange(v.start, v.end)} (${periodLength(v.start, v.end)})`).join(' · ')}</td><td>{vs.reduce((a, v) => a + periodLength(v.start, v.end), 0)}</td></tr>;
            })}</tbody>
          </table></div>
        </div>
      )}

      <div class="card">
        <div class="card-head"><h2>Preferencias de los trabajadores</h2><span class="spacer" /><button class="btn sm" onClick={() => setPref(true)}>＋ Añadir</button></div>
        {data.preferences.length ? data.preferences.map((p) => (
          <div class="list-item" key={p.id}><b>{nameOf(p.worker_id)}</b><span>{formatRange(p.start, p.end)}</span><span class="muted small">{p.note}</span><span class="spacer" />
            <button class="btn ghost sm" onClick={async () => (await run(() => api('deletePreference', { id: p.id }))) && reload()}>Quitar</button></div>
        )) : <div class="empty">Nadie ha indicado preferencias para {data.year}.</div>}
      </div>
      {pref && <PreferenceModal data={data} isAdmin onClose={() => setPref(false)} onDone={reload} />}
    </>
  );
}

// =============== AJUSTES (admin) ===============
export function SettingsPage({ data, reload }) {
  const [mins, setMins] = useState(data.minimums);
  useEffect(() => setMins(data.minimums), [data]);
  const [blk, setBlk] = useState(null);
  const [sub, setSub] = useState(null);
  const setCell = (team, shift, i, v) => setMins({ ...mins, [team]: { ...mins[team], [shift]: mins[team][shift].map((x, k) => (k === i ? Math.max(0, Number(v) || 0) : x)) } });
  const saveMins = async () => (await run(() => api('saveMinimums', { minimums: mins }), 'Mínimos guardados')) && reload();
  const changed = JSON.stringify(mins) !== JSON.stringify(data.minimums);
  const counts = (team, shift) => data.staff.filter((s) => s.team === team && s.shift === shift).length;

  return (
    <>
      <div class="row"><h1>Ajustes</h1><span class="spacer" /><a class="btn sm" href="#historial">🕘 Historial de cambios</a></div>
      <PeriodCard data={data} reload={reload} />
      <div class="card">
        <div class="card-head"><h2>Mínimos de personal por día <span class="badge">Opcional</span></h2><span class="spacer" />
          {changed && <button class="btn" onClick={() => setMins(data.minimums)}>Deshacer</button>}
          <button class="btn primary" disabled={!changed} onClick={saveMins}>Guardar mínimos</button></div>
        <div class="small muted" style="margin-bottom:10px">Personas que tienen que estar trabajando cada día en cada turno, además de la regla anterior. Déjalo a 0 si no lo necesitas. Si un cambio deja el calendario por debajo del mínimo, no se podrá guardar.</div>
        <div class="table-wrap"><table class="table min-table">
          <thead><tr><th>Grupo</th><th>Plantilla</th>{WEEKDAYS.map((d) => <th key={d}>{d.slice(0, 3)}</th>)}<th>Pueden faltar</th></tr></thead>
          <tbody>{GROUPS.map((g) => {
            const row = mins[g.team][g.shift];
            const n = counts(g.team, g.shift);
            return (
              <tr key={g.key}>
                <td style="white-space:nowrap"><GroupDot team={g.team} shift={g.shift} /> {groupLabel(g.team, g.shift)}</td>
                <td>{n}</td>
                {row.map((v, i) => <td key={i}><input class="input" type="number" min="0" max="20" value={v} onInput={(e) => setCell(g.team, g.shift, i, e.currentTarget.value)} /></td>)}
                <td class="small">{describeMinimumRow(row.map((v) => Math.max(0, n - v)))}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Suplentes y refuerzos</h2><span class="spacer" /><button class="btn sm" onClick={() => setSub({ team: 'cocina', shift: 'M', count: 1, start: `${data.year}-07-01`, end: `${data.year}-07-14`, note: '' })}>＋ Añadir suplente</button></div>
        <div class="small muted" style="margin-bottom:8px">Un suplente cuenta como una persona más en ese turno esas fechas. Así un cocinero puede coger varios días seguidos aunque incluyan fin de semana.</div>
        {data.reinforcements.length ? data.reinforcements.map((r) => (
          <div class="list-item" key={r.id}><GroupDot team={r.team} shift={r.shift} /><b>{groupLabel(r.team, r.shift)}</b><span>{formatRange(r.start, r.end)}</span><span class="badge">+{r.count}</span><span class="muted small">{r.note}</span><span class="spacer" />
            <button class="btn sm" onClick={() => setSub(r)}>Editar</button>
            <button class="btn sm danger" onClick={async () => (await ask('¿Quitar este suplente?')) && (await run(() => api('deleteReinforcement', { id: r.id }), 'Suplente quitado')) && reload()}>Quitar</button></div>
        )) : <div class="empty">No hay suplentes en {data.year}.</div>}
      </div>

      <div class="card">
        <div class="card-head"><h2>Fechas bloqueadas</h2><span class="spacer" /><button class="btn sm" onClick={() => setBlk({ start: `${data.year}-12-24`, end: `${data.year}-12-24`, reason: '' })}>＋ Bloquear fechas</button></div>
        <div class="small muted" style="margin-bottom:8px">Días en los que no se pueden conceder vacaciones a nadie (eventos, fiestas locales…).</div>
        {data.blocked.length ? data.blocked.map((b) => (
          <div class="list-item" key={b.id}><b>{formatRange(b.start, b.end)}</b><span class="muted">{b.reason}</span><span class="spacer" />
            <button class="btn sm danger" onClick={async () => (await run(() => api('deleteBlocked', { id: b.id }), 'Fechas desbloqueadas')) && reload()}>Quitar</button></div>
        )) : <div class="empty">No hay fechas bloqueadas en {data.year}.</div>}
      </div>

      {blk && <SimpleRangeModal title="Bloquear fechas" initial={blk} extra={(f, set) => <Field label="Motivo"><input class="input" value={f.reason} onInput={(e) => set({ ...f, reason: e.currentTarget.value })} placeholder="Ej.: Fiestas del pueblo" /></Field>}
        onClose={() => setBlk(null)} onSave={(f) => api('saveBlocked', { ...f, year: data.year })} onDone={reload} />}
      {sub && <SimpleRangeModal title="Suplente" initial={sub} extra={(f, set) => <>
        <div class="grid2">
          <Field label="Puesto"><select class="input" value={f.team} onChange={(e) => set({ ...f, team: e.currentTarget.value })}>{Object.entries(TEAMS).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
          <Field label="Turno"><select class="input" value={f.shift} onChange={(e) => set({ ...f, shift: e.currentTarget.value })}>{Object.entries(SHIFTS).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></Field>
          <Field label="Personas"><input class="input" type="number" min="1" max="5" value={f.count} onInput={(e) => set({ ...f, count: Number(e.currentTarget.value) })} /></Field>
          <Field label="Nombre o nota"><input class="input" value={f.note} onInput={(e) => set({ ...f, note: e.currentTarget.value })} placeholder="Ej.: Suplente verano" /></Field>
        </div></>}
        onClose={() => setSub(null)} onSave={(f) => api('saveReinforcement', f)} onDone={reload} />}
    </>
  );
}

function PeriodCard({ data, reload }) {
  const [L, setL] = useState(data.periodRules?.periodLength ?? 15);
  const [M, setM] = useState(data.periodRules?.maxOffPerShift ?? 1);
  useEffect(() => { setL(data.periodRules?.periodLength ?? 15); setM(data.periodRules?.maxOffPerShift ?? 1); }, [data]);
  const fixed = L > 0;
  const save = async (v) => (await run(() => api('savePeriodRules', { periodLength: v }), 'Guardado')) && reload();
  const saveM = async (v) => (await run(() => api('savePeriodRules', { maxOffPerShift: v }), 'Guardado')) && reload();
  const hasMax = data.periodRules?.maxOffPerShift != null;
  return (
    <div class="card stack">
      <div class="card-head" style="margin:0"><h2>Reglas de vacaciones</h2></div>
      <label class="row"><input type="checkbox" checked={hasMax} onChange={(e) => saveM(e.currentTarget.checked ? 1 : null)} /> Limitar cuántas personas de un mismo turno pueden estar de vacaciones a la vez</label>
      {hasMax && (
        <div class="row">Como máximo
          <input class="input" type="number" min="0" max="10" style="width:70px" value={M} onInput={(e) => setM(Number(e.currentTarget.value))} /> persona(s) de vacaciones a la vez en cada turno (cocina mañana, cocina tarde, camareros mañana y camareros tarde)
          {M !== data.periodRules?.maxOffPerShift && <button class="btn primary sm" onClick={() => saveM(M)}>Guardar</button>}
        </div>
      )}
      {hasMax && ['sala', 'cocina'].map((t) => {
        const W = data.periodRules?.wholeTeam || [];
        const on = W.includes(t);
        return <label class="row" key={t}><input type="checkbox" checked={on} onChange={async (e) => (await run(() => api('savePeriodRules', { wholeTeam: e.currentTarget.checked ? [...W, t] : W.filter((x) => x !== t) }), 'Guardado')) && reload()} /> En {t === 'sala' ? 'sala (camareros)' : 'cocina'}, contar mañana y tarde juntas: el máximo es para todo el equipo, no para cada turno</label>;
      })}
      <hr style="border:none;border-top:1px solid var(--border);margin:4px 0" />
      <label class="row"><input type="checkbox" checked={fixed} onChange={(e) => { const v = e.currentTarget.checked ? 15 : 0; setL(v); save(v); }} /> Todos los periodos tienen la misma duración</label>
      {fixed && (
        <div class="row">Cada periodo dura
          <input class="input" type="number" min="1" max="31" style="width:70px" value={L} onInput={(e) => setL(Number(e.currentTarget.value))} /> días seguidos
          {L !== data.periodRules?.periodLength && <button class="btn primary sm" onClick={() => save(L)}>Guardar</button>}
        </div>
      )}
      <div class="small muted">{fixed ? `Al elegir fechas solo se indica el primer día. Las vacaciones que ya están en el calendario no cambian.` : 'Cada periodo puede tener cualquier duración.'}</div>
    </div>
  );
}

function SimpleRangeModal({ title, initial, extra, onClose, onSave, onDone }) {
  const [f, setF] = useState(initial);
  const save = async () => { if (await run(() => onSave(f), 'Guardado')) { onDone(); onClose(); } };
  return (
    <Modal title={title} onClose={onClose} footer={<><button class="btn" onClick={onClose}>Cancelar</button><button class="btn primary" onClick={save}>Guardar</button></>}>
      <div class="grid2">
        <Field label="Desde"><input class="input" type="date" value={f.start} onInput={(e) => { const v = e.currentTarget.value; setF({ ...f, start: v, end: v > f.end ? v : f.end }); }} /></Field>
        <Field label="Hasta"><input class="input" type="date" value={f.end} min={f.start} onInput={(e) => setF({ ...f, end: e.currentTarget.value })} /></Field>
      </div>
      {extra(f, setF)}
    </Modal>
  );
}

// =============== HISTORIAL (admin) ===============
export function HistoryPage({ data }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { run(() => api('listHistory', { year: data.year })).then((r) => r && setRows(r)); }, [data]);
  return (
    <>
      <h1>Historial de cambios</h1>
      <div class="card">
        {!rows ? <div class="empty">Cargando…</div> : !rows.length ? <div class="empty">Todavía no hay cambios.</div> : (
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Fecha</th><th>Quién</th><th>Acción</th><th>Detalle</th></tr></thead>
            <tbody>{rows.map((h) => <tr key={h.id}><td class="small" style="white-space:nowrap">{new Date(h.created_at).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' })}</td><td>{h.user_name}</td><td><b>{h.action}</b></td><td class="small">{h.detail}</td></tr>)}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}

// =============== RESUMEN ANUAL ===============
export function SummaryPage({ data }) {
  const cal = useMemo(() => buildCal(data), [data]);
  const nameOf = nameFn(data);
  const [busy, setBusy] = useState('');
  const totals = data.staff.reduce((a, s) => { const st = workerStats(s, data.vacations, data.today); a.total += st.total; a.assigned += st.assigned; a.enjoyed += st.enjoyed; return a; }, { total: 0, assigned: 0, enjoyed: 0 });
  // Días al límite: ya no cabe nadie más de vacaciones en algún grupo
  let fullDays = 0;
  for (let i = 0; i < cal.analysis.N; i++) if (GROUPS.some((g) => { const G = cal.analysis.groups[g.key]; return G.members.length && G.room[i] <= 0; })) fullDays++;
  const exp = async (kind) => {
    if (runtime.noDownloads) { toast('En esta versión de prueba no se pueden descargar archivos. En la aplicación instalada, este botón descarga el Excel o el PDF.'); return; }
    setBusy(kind);
    try {
      const mod = await import('./export.js');
      await (kind === 'xlsx' ? mod.exportExcel(data) : mod.exportPDF(data));
      toast('Archivo descargado', 'ok');
    } catch (e) { console.error(e); toast('No se pudo exportar: ' + e.message, 'bad'); }
    setBusy('');
  };
  return (
    <>
      <div class="row"><h1>Resumen {data.year}</h1><span class="spacer" />
        <button class="btn" disabled={!!busy} onClick={() => exp('xlsx')}>{busy === 'xlsx' ? 'Preparando…' : '⬇ Excel'}</button>
        <button class="btn" disabled={!!busy} onClick={() => exp('pdf')}>{busy === 'pdf' ? 'Preparando…' : '⬇ PDF'}</button>
      </div>
      <div class="stats">
        <Stat label="Días a repartir" value={totals.total} hint={`${data.staff.length} trabajadores`} />
        <Stat label="Asignados" value={totals.assigned} hint={`${Math.round((totals.assigned / (totals.total || 1)) * 100)} %`} />
        <Stat label="Disfrutados" value={totals.enjoyed} color="var(--ok)" />
        <Stat label="Conflictos" value={cal.analysis.issues.length} color={cal.analysis.issues.length ? 'var(--bad)' : 'var(--ok)'} />
        <Stat label="Días al límite" value={fullDays} hint="algún turno no admite más bajas" />
      </div>
      {cal.analysis.issues.length > 0 && <Alert kind="bad" title="Conflictos de disponibilidad" items={cal.analysis.issues.slice(0, 15).map((i) => describeIssue(i, nameOf))} />}
      <div class="card">
        <div class="card-head"><h2>Por trabajador</h2></div>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Trabajador</th><th class="hide-mobile">Grupo</th><th>Asignados</th><th>Disfrutados</th><th>Pendientes</th><th>Sin asignar</th><th class="hide-mobile">Periodos</th></tr></thead>
          <tbody>{data.staff.map((s) => {
            const st = workerStats(s, data.vacations, data.today);
            const vs = data.vacations.filter((v) => v.worker_id === s.worker_id).sort((a, b) => (a.start < b.start ? -1 : 1));
            return (
              <tr key={s.worker_id}>
                <td><GroupDot team={s.team} shift={s.shift} /> <b>{s.name}</b></td>
                <td class="hide-mobile small">{groupLabel(s.team, s.shift)}</td>
                <td>{st.assigned} / {st.total}</td>
                <td>{st.enjoyed}</td>
                <td>{st.pendingToEnjoy}</td>
                <td>{st.unassigned ? <span class="badge warn">{st.unassigned}</span> : <span class="badge ok">0</span>}</td>
                <td class="hide-mobile small">{vs.map((v) => formatRange(v.start, v.end)).join(' · ')}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      </div>
    </>
  );
}
