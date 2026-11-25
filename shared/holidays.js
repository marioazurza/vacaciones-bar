// Festivos de Zarautz (Gipuzkoa, País Vasco). Solo se marcan en el calendario: las
// vacaciones se cuentan en días naturales, así que no cambian ninguna regla.
// Fuentes: calendario laboral 2027 del Gobierno Vasco (Consejo de Gobierno 09-06-2026)
// y fiestas locales de Gipuzkoa 2027 (BOG 1-10-2026).
export const HOLIDAYS = {
  '2026-12-08': 'Inmaculada Concepción',
  '2026-12-25': 'Navidad',
  '2027-01-01': 'Año Nuevo',
  '2027-01-06': 'Reyes',
  '2027-03-25': 'Jueves Santo',
  '2027-03-26': 'Viernes Santo',
  '2027-03-29': 'Lunes de Pascua',
  '2027-05-01': 'Fiesta del Trabajo',
  '2027-06-26': 'San Pelayo (fiesta local de Zarautz)',
  '2027-07-31': 'San Ignacio de Loyola (fiesta local de Gipuzkoa)',
  '2027-10-07': 'Aniversario del primer Gobierno Vasco',
  '2027-10-12': 'Fiesta Nacional',
  '2027-11-01': 'Todos los Santos',
  '2027-12-06': 'Día de la Constitución',
  '2027-12-08': 'Inmaculada Concepción',
  '2027-12-25': 'Navidad',
};
export const holidayName = (date) => HOLIDAYS[date] || null;
