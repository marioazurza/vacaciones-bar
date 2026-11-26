import { render } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { api, onSaved, runtime } from './api.js';
import { Toasts, Modal, Field, Alert, run, showError, toast, ask, PasswordInput } from './ui.jsx';
import { CalendarPage, MyVacationsPage, RequestsPage, TeamPage, GeneratorPage, SettingsPage, HistoryPage, SummaryPage } from './pages.jsx';
import { todayISO } from '../shared/dates.js';
import './styles.css';

const NAV_ADMIN = [
  ['calendario', '📅', 'Calendario'],
  ['generador', '✨', 'Generador'],
  ['solicitudes', '📨', 'Solicitudes'],
  ['equipo', '👥', 'Equipo'],
  ['resumen', '📊', 'Resumen'],
  ['ajustes', '⚙️', 'Ajustes'],
  ['historial', '🕘', 'Historial'],
];
// Los trabajadores solo ven el calendario (allí aceptan o rechazan peticiones de días).
const NAV_WORKER = [
  ['calendario', '📅', 'Calendario'],
];

function useRoute(def) {
  const get = () => (location.hash.replace(/^#\/?/, '') || def);
  const [r, setR] = useState(get);
  useEffect(() => { const f = () => setR(get()); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  return r;
}

function Login({ onLogin }) {
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const [mail, setMail] = useState('');
  const [nm, setNm] = useState('');
  const [asAdmin, setAsAdmin] = useState(!runtime.emailLogin);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e, user = u, pass = p) => {
    e?.preventDefault();
    setErr(''); setBusy(true);
    try {
      const r = asAdmin || user !== u ? await api('login', { username: user, password: pass }) : await api('login', { email: mail, name: nm });
      onLogin(r.user);
    } catch (x) { setErr(x.message); }
    setBusy(false);
  };
  return (
    <div class="login">
      {/* Sin <form> nativo: algunos visores incrustados bloquean el envío de formularios. */}
      <div class="card stack" onKeyDown={(e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') submit(e); }}>
        <div class="brand" style="padding:0"><div class="brand-logo">🌴</div><div>Vacaciones del bar<div class="small muted" style="font-weight:400">Calendario del equipo</div></div></div>
        {asAdmin ? <>
          {runtime.emailLogin && <b>Entrar como administrador</b>}
          <Field label="Usuario"><input class="input" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellcheck={false} value={u} onInput={(e) => setU(e.currentTarget.value)} autoFocus /></Field>
          <Field label="Contraseña"><PasswordInput id="login-pw" autoComplete="current-password" value={p} onInput={(e) => setP(e.currentTarget.value)} /></Field>
        </> : <>
          <Field label="Tu email"><input class="input" type="email" autoComplete="email" autoCapitalize="none" autoCorrect="off" spellcheck={false} value={mail} onInput={(e) => setMail(e.currentTarget.value)} autoFocus /></Field>
          <Field label="Tu nombre"><input class="input" autoComplete="given-name" value={nm} onInput={(e) => setNm(e.currentTarget.value)} placeholder="Por ejemplo: Gemma" /></Field>
        </>}
        {err && <Alert kind="bad" title={err} />}
        <button class="btn primary" type="button" id="login-btn" style="justify-content:center" disabled={busy} onClick={submit}>{busy ? 'Entrando…' : 'Entrar'}</button>
        {runtime.emailLogin && <button type="button" class="btn ghost sm" style="justify-content:center" onClick={() => { setAsAdmin(!asAdmin); setErr(''); }}>{asAdmin ? '← Entrar como trabajador' : '🔑 Entrar como administrador'}</button>}
        {runtime.demo && (
          <div class="stack" style="gap:6px">
            <div class="small muted">Versión de prueba: el administrador entra con su usuario y contraseña. Para ver la app como un trabajador, entra con un clic:</div>
            <div class="demo-users">
              {runtime.demoUsers.map((d) => <button type="button" key={d.username} class={`btn sm ${d.username === 'admin' ? 'primary' : ''}`} onClick={() => submit(null, d.username, d.password)}>{d.label}</button>)}
            </div>
            <button type="button" class="btn ghost sm" onClick={() => window.resetDemo?.()}>↺ Borrar los datos de prueba y empezar de cero</button>
          </div>
        )}
      </div>
    </div>
  );
}

function Notifications({ count, onRead }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState([]);
  const toggle = async () => {
    if (!open) {
      const l = await run(() => api('listNotifications'));
      if (l) setList(l);
      if (count) { await api('markNotificationsRead').catch(() => {}); onRead(); }
    }
    setOpen(!open);
  };
  return (
    <div style="position:relative">
      <button class="icon-btn" aria-label="Notificaciones" onClick={toggle}>🔔{count > 0 && <span class="bell-count">{count}</span>}</button>
      {open && (
        <div class="popover" onMouseLeave={() => setOpen(false)}>
          {!list.length ? <div class="empty">No tienes notificaciones.</div> : list.map((n) => (
            <div key={n.id} class={`notif ${n.read ? '' : 'unread'}`}>
              <div>{n.text}</div>
              <div class="small muted">{new Date(n.created_at).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' })}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PasswordModal({ onClose }) {
  const [c, setC] = useState('');
  const [n, setN] = useState('');
  const save = async () => { if (await run(() => api('changePassword', { current: c, next: n }), 'Contraseña cambiada')) onClose(); };
  return (
    <Modal title="Cambiar contraseña" onClose={onClose} footer={<><button class="btn" onClick={onClose}>Cancelar</button><button class="btn primary" onClick={save}>Guardar</button></>}>
      <Field label="Contraseña actual"><PasswordInput autoComplete="current-password" value={c} onInput={(e) => setC(e.currentTarget.value)} /></Field>
      <Field label="Nueva contraseña"><PasswordInput autoComplete="new-password" value={n} onInput={(e) => setN(e.currentTarget.value)} /></Field>
    </Modal>
  );
}

function Shell({ user, onLogout }) {
  const isAdmin = user.role === 'admin';
  const nav = isAdmin ? NAV_ADMIN : NAV_WORKER;
  const route = useRoute(nav[0][0]);
  const [year, setYear] = useState(() => {
    try { const y = Number(localStorage.getItem('vac-year')); if (y) return y; } catch { /* */ }
    const t = todayISO();
    return Number(t.slice(0, 4)) + (t.slice(5, 7) >= '10' ? 1 : 0);
  });
  const [data, setData] = useState(null);
  const [saved, setSaved] = useState(null);
  const [pw, setPw] = useState(false);
  const [menu, setMenu] = useState(false);

  const reload = useCallback(async () => {
    try {
      const d = await api('getYear', { year });
      if (!d.exists && d.years.length) {
        const fallback = d.years.find((y) => y.year === Number(todayISO().slice(0, 4))) || d.years[d.years.length - 1];
        if (fallback.year !== year) { setYear(fallback.year); return; }
      }
      setData(d);
    } catch (e) { showError(e); }
  }, [year]);
  useEffect(() => { reload(); try { localStorage.setItem('vac-year', String(year)); } catch { /* */ } }, [year]);
  useEffect(() => onSaved((t) => setSaved(t)), []);
  useEffect(() => { const t = setInterval(reload, 60000); return () => clearInterval(t); }, [reload]);

  if (!data) return <div class="login"><div class="muted">Cargando…</div></div>;
  const page = nav.find((n) => n[0] === route) ? route : nav[0][0];
  const pendingBadge = isAdmin ? data.pendingRequests : data.requests.filter((r) => r.status === 'esperando_companero' && r.target_id === user.worker_id).length;

  const publish = async () => {
    if (!await ask(`¿Publicar el calendario de ${data.year}? Todos los trabajadores podrán verlo y pedir cambios.`)) return;
    (await run(() => api('publishYear', { year: data.year }), 'Calendario publicado')) && reload();
  };
  const unpublish = async () => {
    if (!await ask('¿Retirar la publicación? Los trabajadores dejarán de ver este año.')) return;
    (await run(() => api('unpublishYear', { year: data.year }), 'Vuelve a estar en borrador')) && reload();
  };
  const newYear = async () => {
    const y = Number(await ask('¿Qué año quieres preparar? Se copiará la plantilla del año anterior.', { input: String(Math.max(...data.years.map((x) => x.year)) + 1), ok: 'Crear año' }));
    if (!y) return;
    if (await run(() => api('createYear', { year: y }), `Año ${y} creado con la plantilla del año anterior`)) setYear(y);
  };

  const props = { data, reload, isAdmin, me: user.worker_id, onYear: setYear };
  const Page = { calendario: CalendarPage, 'mis-vacaciones': MyVacationsPage, solicitudes: RequestsPage, equipo: TeamPage, generador: GeneratorPage, ajustes: SettingsPage, historial: HistoryPage, resumen: SummaryPage }[page];

  return (
    <div class="app">
      <aside class="sidebar">
        <div class="brand"><div class="brand-logo">🌴</div>Vacaciones</div>
        {nav.map(([k, ico, t]) => (
          <a key={k} href={`#${k}`} class={`nav-item ${page === k ? 'active' : ''}`}><span class="ico">{ico}</span>{t}{k === 'solicitudes' && pendingBadge > 0 && <span class="nav-badge">{pendingBadge}</span>}</a>
        ))}
        <span class="spacer" />
        <div class="small muted" style="padding:8px">{user.display}<br />{isAdmin ? 'Administrador' : 'Trabajador'}</div>
      </aside>
      <div class="main">
        <header class="topbar">
          <select class="input" value={year} onChange={(e) => setYear(Number(e.currentTarget.value))} aria-label="Año">
            {data.years.filter((y) => isAdmin || y.status === 'publicado' || y.year === year).map((y) => <option key={y.year} value={y.year}>{y.year}</option>)}
          </select>
          {isAdmin && <span class={`badge ${data.status === 'publicado' ? 'ok' : 'warn'}`}>{data.status === 'publicado' ? 'Publicado' : 'Borrador'}</span>}
          {isAdmin && data.status !== 'publicado' && <button class="btn primary sm" onClick={publish}>Publicar</button>}
          {isAdmin && data.status === 'publicado' && <button class="btn sm ghost hide-mobile" onClick={unpublish}>Retirar publicación</button>}
          {isAdmin && <button class="btn sm ghost hide-mobile" onClick={newYear}>＋ Año</button>}
          <span class="spacer" />
          {saved && <span class="saved hide-mobile">✓ Guardado {saved.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}</span>}
          <Notifications count={data.unread} onRead={reload} />
          <div style="position:relative">
            <button class="icon-btn" aria-label="Cuenta" onClick={() => setMenu(!menu)}>👤</button>
            {menu && (
              <div class="popover" style="width:220px" onMouseLeave={() => setMenu(false)}>
                <div class="notif"><b>{user.display}</b><div class="small muted">Usuario: {user.username}</div></div>
                <button class="btn ghost" style="width:100%;justify-content:flex-start" onClick={() => { setMenu(false); setPw(true); }}>🔑 Cambiar contraseña</button>
                {!runtime.noLogin && <button class="btn ghost" style="width:100%;justify-content:flex-start" onClick={onLogout}>↩ Salir</button>}
              </div>
            )}
          </div>
        </header>
        <main class="content">{Page && <Page {...props} />}</main>
      </div>
      <nav class="bottom-nav">
        {nav.slice(0, 5).map(([k, ico, t]) => (
          <a key={k} href={`#${k}`} class={page === k ? 'active' : ''}><span class="ico">{ico}</span>{t}{k === 'solicitudes' && pendingBadge > 0 && <span class="nav-badge">{pendingBadge}</span>}</a>
        ))}
        {nav.length > 5 && <a href={`#${nav[5][0]}`} class={['ajustes', 'historial'].includes(page) ? 'active' : ''}><span class="ico">⋯</span>Más</a>}
      </nav>
      {pw && <PasswordModal onClose={() => setPw(false)} />}
    </div>
  );
}

function App() {
  const [user, setUser] = useState(undefined);
  useEffect(() => {
    api('me').then((r) => setUser(r.user)).catch(() => setUser(null));
    const f = () => setUser(null);
    window.addEventListener('vac-logout', f);
    return () => window.removeEventListener('vac-logout', f);
  }, []);
  if (user === undefined) return null;
  const logout = async () => { await api('logout').catch(() => {}); location.hash = ''; setUser(null); toast('Has salido de la aplicación'); };
  return (
    <>
      {user ? <Shell key={user.id} user={user} onLogout={logout} /> : <Login onLogin={setUser} />}
      <Toasts />
    </>
  );
}

export function start() {
  render(<App />, document.getElementById('app'));
}
