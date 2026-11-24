import { useMemo, useState } from 'preact/hooks';
import { api } from './api.js';
import { Modal, Alert, Field, run, ask } from './ui.jsx';
import { liveCheck, statsFor } from './model.js';
import { formatRange, periodLength, isISODate, addDays } from '../shared/dates.js';
import { groupLabel } from '../shared/rules.js';

function DaysInfo({ data, workerId, vacations }) {
  const st = statsFor(data, workerId, vacations);
  if (!st) return null;
  const over = st.assigned > st.total;
  return (
    <div class={`small ${over ? '' : 'muted'}`} style={over ? 'color:var(--bad);font-weight:600' : ''}>
      Con este cambio: {st.assigned} de {st.total} días asignados · {Math.max(0, st.total - st.assigned)} sin asignar
    </div>
  );
}

function Check({ problems, okText = 'Las fechas cumplen todos los mínimos de cobertura.' }) {
  if (!problems) return null;
  const kitchen = problems.some((t) => /Cocina (mañana|tarde): se necesitan/.test(t));
  return problems.length
    ? <Alert kind="bad" title="No se puede: estas fechas generan conflictos" items={problems}>
        {kitchen && <div class="small" style="margin-top:6px">En cocina no puede faltar nadie de viernes a domingo. Para estas fechas hace falta un suplente: se añade en Ajustes → Suplentes (o lo propone el Generador).</div>}
      </Alert>
    : <Alert kind="ok" title={okText} />;
}

/** Alta o edición directa de un periodo (solo administrador). */
/** Duración fija de los periodos (0 = libre). */
export const fixedLength = (data) => data.periodRules?.periodLength || 0;

/** Selector de fechas: con duración fija solo se elige el primer día. */
function DateRange({ data, start, end, setStart, setEnd, min, labels = ['Primer día', 'Último día'] }) {
  const L = fixedLength(data);
  const max = `${data.year}-12-31`;
  if (L) {
    return (
      <div class="grid2">
        <Field label={labels[0]}><input class="input" type="date" value={start} min={min} max={max} onInput={(e) => { const v = e.currentTarget.value; setStart(v); if (isISODate(v)) setEnd(addDays(v, L - 1)); }} /></Field>
        <Field label={`${labels[1]} (${L} días seguidos)`}><input class="input" type="date" value={end} disabled /></Field>
      </div>
    );
  }
  return (
    <div class="grid2">
      <Field label={labels[0]}><input class="input" type="date" value={start} min={min} max={max} onInput={(e) => { const v = e.currentTarget.value; setStart(v); if (v > end) setEnd(v); }} /></Field>
      <Field label={labels[1]}><input class="input" type="date" value={end} min={start} max={max} onInput={(e) => setEnd(e.currentTarget.value)} /></Field>
    </div>
  );
}

export function VacationModal({ data, initial, onClose, onDone }) {
  const L = fixedLength(data);
  const [workerId, setWorkerId] = useState(initial.worker_id ?? data.staff[0]?.worker_id);
  const [start, setStart] = useState(initial.start || `${data.year}-01-01`);
  const [end, setEnd] = useState(initial.id ? initial.end : L ? addDays(initial.start || `${data.year}-01-01`, L - 1) : (initial.end || initial.start || `${data.year}-01-01`));
  const editing = !!initial.id;
  const after = useMemo(() => {
    const base = data.vacations.filter((v) => v.id !== initial.id);
    return [...base, { id: initial.id ?? -1, worker_id: Number(workerId), start, end }];
  }, [workerId, start, end]);
  const problems = useMemo(() => (isISODate(start) && isISODate(end) ? liveCheck(data, after, { start, end }) : ['Escribe fechas válidas.']), [after]);
  const len = isISODate(start) && isISODate(end) && end >= start ? periodLength(start, end) : 0;

  const save = async () => {
    const ok = await run(() => api('saveVacation', { id: initial.id, year: data.year, worker_id: Number(workerId), start, end }), 'Vacaciones guardadas');
    if (ok) { onDone(); onClose(); }
  };
  const del = async () => {
    if (!await ask('¿Eliminar este periodo de vacaciones?')) return;
    const ok = await run(() => api('deleteVacation', { id: initial.id }), 'Periodo eliminado');
    if (ok) { onDone(); onClose(); }
  };
  return (
    <Modal title={editing ? 'Editar vacaciones' : 'Añadir vacaciones'} onClose={onClose}
      footer={<>
        {editing && <button class="btn danger" onClick={del}>Eliminar</button>}
        <span class="spacer" />
        <button class="btn" onClick={onClose}>Cancelar</button>
        <button class="btn primary" disabled={problems.length > 0} onClick={save}>Guardar</button>
      </>}>
      <Field label="Trabajador">
        <select class="input" value={workerId} onChange={(e) => setWorkerId(Number(e.currentTarget.value))}>
          {data.staff.map((s) => <option key={s.worker_id} value={s.worker_id}>{s.name} · {groupLabel(s.team, s.shift)}</option>)}
        </select>
      </Field>
      <DateRange data={data} start={start} end={end} setStart={setStart} setEnd={setEnd} min={`${data.year}-01-01`} />
      <div class="row"><span class="badge info">{len} días naturales</span><DaysInfo data={data} workerId={Number(workerId)} vacations={after} /></div>
      <Check problems={problems} />
      <CrossTeamNote data={data} workerId={Number(workerId)} start={start} end={end} ignoreId={initial.id} />
    </Modal>
  );
}

/** Aviso suave: se permite, pero es mejor que un camarero y un cocinero no coincidan de vacaciones. */
function CrossTeamNote({ data, workerId, start, end, ignoreId }) {
  const me = data.staff.find((s) => s.worker_id === workerId);
  if (!me || !isISODate(start) || !isISODate(end)) return null;
  const others = data.vacations.filter((v) => v.id !== ignoreId && v.start <= end && v.end >= start)
    .map((v) => ({ v, s: data.staff.find((x) => x.worker_id === v.worker_id) }))
    .filter(({ s }) => s && s.team !== me.team);
  if (!others.length) return null;
  return <Alert kind="warn" title={`Se puede guardar, pero coincide con ${me.team === 'sala' ? 'cocina' : 'sala'}`}
    items={others.map(({ v, s }) => `${s.name}: ${formatRange(v.start, v.end)}`).concat(['Es mejor que un camarero y un cocinero no estén de vacaciones a la vez.'])} />;
}

/** Solicitud de cambio de un trabajador: mover un periodo, pedir días nuevos o anular uno. */
export function ChangeRequestModal({ data, me, vacation, onClose, onDone }) {
  const [mode, setMode] = useState(vacation ? 'mover' : 'nuevo');
  const tomorrow = addDays(data.today, 1);
  const minDate = tomorrow > `${data.year}-01-01` ? tomorrow : `${data.year}-01-01`;
  const L = fixedLength(data);
  const [start, setStart] = useState(vacation?.start > data.today ? vacation.start : minDate);
  const [end, setEnd] = useState(vacation?.end > data.today ? vacation.end : L ? addDays(minDate, L - 1) : minDate);
  const [comment, setComment] = useState('');
  const remove = vacation && mode !== 'nuevo' ? [vacation.id] : [];
  const add = mode === 'anular' ? [] : [{ start, end }];
  const after = useMemo(() => [
    ...data.vacations.filter((v) => !remove.includes(v.id)),
    ...add.map((a, i) => ({ id: -1 - i, worker_id: me, ...a })),
  ], [mode, start, end]);
  const problems = useMemo(() => {
    if (mode === 'anular') return [];
    if (!isISODate(start) || !isISODate(end)) return ['Escribe fechas válidas.'];
    if (start <= data.today) return ['Las nuevas fechas deben ser posteriores a hoy.'];
    return liveCheck(data, after, { start, end });
  }, [after]);

  const send = async () => {
    const ok = await run(() => api('createChangeRequest', { year: data.year, remove, add, comment }), 'Solicitud enviada al administrador');
    if (ok) { onDone(); onClose(); }
  };
  return (
    <Modal title="Solicitar un cambio" onClose={onClose}
      footer={<><button class="btn" onClick={onClose}>Cancelar</button><button class="btn primary" disabled={problems.length > 0} onClick={send}>Enviar solicitud</button></>}>
      {vacation && (
        <div class="seg">
          <button class={mode === 'mover' ? 'on' : ''} onClick={() => setMode('mover')}>Cambiar fechas</button>
          <button class={mode === 'anular' ? 'on' : ''} onClick={() => setMode('anular')}>Anular periodo</button>
        </div>
      )}
      {vacation && <div class="small muted">Periodo actual: <b>{formatRange(vacation.start, vacation.end)}</b> ({periodLength(vacation.start, vacation.end)} días)</div>}
      {mode !== 'anular' && (
        <DateRange data={data} start={start} end={end} setStart={setStart} setEnd={setEnd} min={minDate} labels={['Nuevo primer día', 'Nuevo último día']} />
      )}
      <DaysInfo data={data} workerId={me} vacations={after} />
      <Field label="Comentario para el administrador (opcional)"><textarea class="input" rows="2" value={comment} onInput={(e) => setComment(e.currentTarget.value)} /></Field>
      <Check problems={problems} okText="Las fechas cumplen la cobertura mínima. La solicitud quedará pendiente de aprobación." />
    </Modal>
  );
}

/** Propuesta de intercambio con un compañero. */
export function SwapModal({ data, me, vacation, onClose, onDone }) {
  const mine = data.vacations.filter((v) => v.worker_id === me && v.start > data.today);
  const [myId, setMyId] = useState(vacation?.id ?? mine[0]?.id);
  const meStaff = data.staff.find((s) => s.worker_id === me);
  const others = data.vacations.filter((v) => v.worker_id !== me && v.start > data.today)
    .map((v) => ({ v, s: data.staff.find((x) => x.worker_id === v.worker_id) }))
    .filter((x) => x.s)
    .sort((a, b) => (a.s.team === meStaff.team && a.s.shift === meStaff.shift ? -1 : 0) - (b.s.team === meStaff.team && b.s.shift === meStaff.shift ? -1 : 0) || a.s.name.localeCompare(b.s.name) || (a.v.start < b.v.start ? -1 : 1));
  const [otherId, setOtherId] = useState(others[0]?.v.id);
  const [comment, setComment] = useState('');
  const a = data.vacations.find((v) => v.id === Number(myId));
  const b = data.vacations.find((v) => v.id === Number(otherId));
  const after = useMemo(() => (a && b ? data.vacations.map((v) => (v.id === a.id ? { ...v, worker_id: b.worker_id } : v.id === b.id ? { ...v, worker_id: a.worker_id } : v)) : data.vacations), [myId, otherId]);
  const problems = useMemo(() => (a && b ? liveCheck(data, after) : ['Elige los dos periodos.']), [after]);

  const send = async () => {
    const ok = await run(() => api('createSwapRequest', { year: data.year, my_vacation_id: a.id, other_vacation_id: b.id, comment }), 'Propuesta enviada a tu compañero');
    if (ok) { onDone(); onClose(); }
  };
  return (
    <Modal title="Proponer un intercambio" onClose={onClose}
      footer={<><button class="btn" onClick={onClose}>Cancelar</button><button class="btn primary" disabled={problems.length > 0} onClick={send}>Enviar propuesta</button></>}>
      {!mine.length ? <Alert kind="info" title="No tienes periodos futuros para intercambiar." /> : <>
        <Field label="Tu periodo">
          <select class="input" value={myId} onChange={(e) => setMyId(Number(e.currentTarget.value))}>
            {mine.map((v) => <option key={v.id} value={v.id}>{formatRange(v.start, v.end)} ({periodLength(v.start, v.end)} días)</option>)}
          </select>
        </Field>
        <Field label="Periodo del compañero">
          <select class="input" value={otherId} onChange={(e) => setOtherId(Number(e.currentTarget.value))}>
            {others.map(({ v, s }) => <option key={v.id} value={v.id}>{s.name} ({groupLabel(s.team, s.shift)}) · {formatRange(v.start, v.end)} · {periodLength(v.start, v.end)} días</option>)}
          </select>
        </Field>
        {a && b && <div class="small muted">Tú pasarías a librar <b>{formatRange(b.start, b.end)}</b> y tu compañero <b>{formatRange(a.start, a.end)}</b>.</div>}
        <DaysInfo data={data} workerId={me} vacations={after} />
        <Field label="Mensaje (opcional)"><textarea class="input" rows="2" value={comment} onInput={(e) => setComment(e.currentTarget.value)} /></Field>
        <Check problems={problems} okText="El intercambio cumple la cobertura. Tu compañero tendrá que aceptarlo y después lo aprobará el administrador." />
      </>}
    </Modal>
  );
}

/** Preferencia de fechas para el generador. */
export function PreferenceModal({ data, isAdmin, me, onClose, onDone }) {
  const [workerId, setWorkerId] = useState(me ?? data.staff[0]?.worker_id);
  const [start, setStart] = useState(`${data.year}-08-01`);
  const [end, setEnd] = useState(`${data.year}-08-15`);
  const [note, setNote] = useState('');
  const save = async () => {
    const ok = await run(() => api('savePreference', { year: data.year, worker_id: Number(workerId), start, end, note }), 'Preferencia guardada');
    if (ok) { onDone(); onClose(); }
  };
  return (
    <Modal title="Fechas preferidas" onClose={onClose} footer={<><button class="btn" onClick={onClose}>Cancelar</button><button class="btn primary" onClick={save}>Guardar</button></>}>
      <div class="small muted">El generador intentará colocar las vacaciones en estas fechas siempre que se respete la cobertura.</div>
      {isAdmin && (
        <Field label="Trabajador">
          <select class="input" value={workerId} onChange={(e) => setWorkerId(Number(e.currentTarget.value))}>
            {data.staff.map((s) => <option key={s.worker_id} value={s.worker_id}>{s.name}</option>)}
          </select>
        </Field>
      )}
      <div class="grid2">
        <Field label="Desde"><input class="input" type="date" value={start} onInput={(e) => setStart(e.currentTarget.value)} /></Field>
        <Field label="Hasta"><input class="input" type="date" value={end} min={start} onInput={(e) => setEnd(e.currentTarget.value)} /></Field>
      </div>
      <Field label="Nota (opcional)"><input class="input" value={note} onInput={(e) => setNote(e.currentTarget.value)} placeholder="Ej.: boda de mi hermana" /></Field>
    </Modal>
  );
}
