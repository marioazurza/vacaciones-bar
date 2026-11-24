// Utilidades de fechas. Todas las fechas se manejan como texto 'AAAA-MM-DD' en UTC
// para evitar problemas de zona horaria y cambios de hora.

export const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
export const MONTHS_SHORT = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
export const WEEKDAYS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
export const WEEKDAYS_SHORT = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];

const DAY = 86400000;
const pad = (n) => String(n).padStart(2, '0');

export function toISO(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function parse(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function isISODate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return toISO(parse(s)) === s;
}

export function addDays(s, n) {
  return toISO(new Date(parse(s).getTime() + n * DAY));
}

/** Días entre a y b (b - a). */
export function diffDays(a, b) {
  return Math.round((parse(b) - parse(a)) / DAY);
}

/** Día de la semana con lunes = 0 ... domingo = 6. */
export function dow(s) {
  return (parse(s).getUTCDay() + 6) % 7;
}

export function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInYear(y) {
  return isLeap(y) ? 366 : 365;
}

export function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}

export function yearStart(y) {
  return `${y}-01-01`;
}

export function yearEnd(y) {
  return `${y}-12-31`;
}

/** Índice del día dentro de su año (1 de enero = 0). */
export function dayIndex(s, year = Number(s.slice(0, 4))) {
  return diffDays(yearStart(year), s);
}

export function dateFromIndex(year, i) {
  return addDays(yearStart(year), i);
}

/** Lista de fechas de start a end, ambos incluidos. */
export function rangeDays(start, end) {
  const out = [];
  const n = diffDays(start, end);
  for (let i = 0; i <= n; i++) out.push(addDays(start, i));
  return out;
}

/** Días naturales de un periodo (incluye sábados, domingos y festivos). */
export function periodLength(start, end) {
  return diffDays(start, end) + 1;
}

export function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}

export function month(s) {
  return Number(s.slice(5, 7)) - 1;
}

/** Domingo de Pascua (algoritmo de Meeus/Butcher, calendario gregoriano). */
export function easterSunday(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mo = Math.floor((h + l - 7 * m + 114) / 31);
  const da = ((h + l - 7 * m + 114) % 31) + 1;
  return `${y}-${pad(mo)}-${pad(da)}`;
}

/** Temporadas altas del año: verano, Semana Santa y Navidad. */
export function peakSeasons(y) {
  const easter = easterSunday(y);
  return [
    { key: 'semana_santa', label: 'Semana Santa', start: addDays(easter, -7), end: addDays(easter, 1) },
    { key: 'verano', label: 'Verano', start: `${y}-07-01`, end: `${y}-08-31` },
    { key: 'navidad', label: 'Navidad', start: `${y}-12-20`, end: `${y}-12-31` },
    { key: 'navidad_ini', label: 'Navidad', start: `${y}-01-01`, end: `${y}-01-06` },
  ];
}

export function formatDate(s, opts = {}) {
  const d = parse(s);
  const base = `${d.getUTCDate()}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
  return opts.weekday ? `${WEEKDAYS[dow(s)]} ${base}` : base;
}

export function formatShort(s) {
  const d = parse(s);
  return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()].toLowerCase()}`;
}

export function formatRange(a, b) {
  return a === b ? formatShort(a) : `${formatShort(a)} – ${formatShort(b)}`;
}

/** Fecha de hoy según el reloj local de quien ejecuta el código. */
export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Lunes de la semana de la fecha dada. */
export function weekStart(s) {
  return addDays(s, -dow(s));
}
