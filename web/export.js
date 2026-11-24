// Exportación del calendario a Excel y PDF (se genera en el navegador).
import ExcelJS from 'exceljs/dist/exceljs.min.js';
import { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable';
import { MONTHS, WEEKDAYS_SHORT, daysInYear, dateFromIndex, dow, daysInMonth, dayIndex, formatDate, periodLength } from '../shared/dates.js';
import { GROUPS, groupLabel, workerStats } from '../shared/rules.js';
import { buildCal } from './model.js';

const COLORS = {
  'cocina-M': { strong: 'B45309', soft: 'FBE3D5' },
  'cocina-T': { strong: '3F63D6', soft: 'DFE6FB' },
  'sala-M': { strong: 'E0A800', soft: 'FAEFD2' },
  'sala-T': { strong: '8A5CD6', soft: 'ECE3FB' },
};
const OLD_COLORS = {
  cocina: { strong: 'E07B46', soft: 'FBD5BF' },
  'sala-M': { strong: '3B8FD4', soft: 'BFDDF5' },
  'sala-T': { strong: '8566D4', soft: 'D9CDF6' },
};
const colorOf = (s) => COLORS[`${s.team}-${s.shift}`] || OLD_COLORS.cocina;
const hexToRgb = (h) => [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function offMap(data) {
  const N = daysInYear(data.year);
  const m = new Map(data.staff.map((s) => [s.worker_id, new Array(N).fill(false)]));
  for (const v of data.vacations) {
    const arr = m.get(v.worker_id);
    if (!arr) continue;
    for (let i = dayIndex(v.start, data.year); i <= dayIndex(v.end, data.year); i++) arr[i] = true;
  }
  return m;
}

export async function exportExcel(data) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Vacaciones del bar';
  const N = daysInYear(data.year);
  const off = offMap(data);
  const cal = buildCal(data);

  // Hoja 1: calendario anual (una columna por día)
  const ws = wb.addWorksheet(`Calendario ${data.year}`, { views: [{ state: 'frozen', xSplit: 2, ySplit: 3 }] });
  ws.getColumn(1).width = 26;
  ws.getColumn(2).width = 18;
  for (let i = 0; i < N; i++) ws.getColumn(3 + i).width = 3.6;
  const r1 = ws.getRow(1), r2 = ws.getRow(2), r3 = ws.getRow(3);
  r1.getCell(1).value = `Vacaciones ${data.year}`;
  r1.getCell(1).font = { bold: true, size: 14 };
  r3.getCell(1).value = 'Trabajador';
  r3.getCell(2).value = 'Grupo';
  for (let m = 0; m < 12; m++) {
    const i0 = dayIndex(`${data.year}-${String(m + 1).padStart(2, '0')}-01`, data.year);
    const n = daysInMonth(data.year, m);
    ws.mergeCells(2, 3 + i0, 2, 3 + i0 + n - 1);
    r2.getCell(3 + i0).value = MONTHS[m];
    r2.getCell(3 + i0).alignment = { horizontal: 'center' };
    r2.getCell(3 + i0).font = { bold: true };
  }
  for (let i = 0; i < N; i++) {
    const d = dateFromIndex(data.year, i);
    const c = r3.getCell(3 + i);
    c.value = Number(d.slice(8, 10));
    c.alignment = { horizontal: 'center' };
    c.font = { size: 8, bold: dow(d) >= 4 };
    if (dow(d) >= 4) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1EDE6' } };
  }
  r3.font = { bold: true };
  let r = 4;
  for (const s of data.staff) {
    const row = ws.getRow(r++);
    row.getCell(1).value = s.name;
    row.getCell(2).value = groupLabel(s.team, s.shift);
    const arr = off.get(s.worker_id);
    const col = colorOf(s);
    for (let i = 0; i < N; i++) {
      if (arr[i]) {
        const c = row.getCell(3 + i);
        c.value = 'V';
        c.alignment = { horizontal: 'center' };
        c.font = { size: 7, color: { argb: 'FF' + col.strong } };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + col.soft } };
      }
    }
  }
  r++;
  for (const g of GROUPS) {
    const G = cal.analysis.groups[g.key];
    if (!G.members.length) continue;
    const row = ws.getRow(r++);
    row.getCell(1).value = `Disponibles ${groupLabel(g.team, g.shift)}`;
    row.getCell(2).value = 'trabajando/mín.';
    row.font = { size: 8 };
    for (let i = 0; i < N; i++) {
      const c = row.getCell(3 + i);
      c.value = `${G.available[i]}/${G.need[i]}`;
      c.font = { size: 6, color: { argb: G.problem[i] ? 'FFD9363E' : 'FF667085' } };
    }
  }

  // Hoja 2: periodos
  const ws2 = wb.addWorksheet('Periodos');
  ws2.columns = [
    { header: 'Trabajador', key: 'n', width: 28 }, { header: 'Grupo', key: 'g', width: 20 },
    { header: 'Inicio', key: 'a', width: 14 }, { header: 'Fin', key: 'b', width: 14 }, { header: 'Días naturales', key: 'd', width: 15 },
  ];
  ws2.getRow(1).font = { bold: true };
  const byStart = [...data.vacations].sort((a, b) => (a.start < b.start ? -1 : 1));
  for (const v of byStart) {
    const s = data.staff.find((x) => x.worker_id === v.worker_id);
    if (!s) continue;
    const row = ws2.addRow({ n: s.name, g: groupLabel(s.team, s.shift), a: formatDate(v.start), b: formatDate(v.end), d: periodLength(v.start, v.end) });
    row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + colorOf(s).soft } };
  }

  // Hoja 3: resumen
  const ws3 = wb.addWorksheet('Resumen');
  ws3.columns = [
    { header: 'Trabajador', key: 'n', width: 28 }, { header: 'Grupo', key: 'g', width: 20 }, { header: 'Días al año', key: 't', width: 12 },
    { header: 'Asignados', key: 'a', width: 12 }, { header: 'Disfrutados', key: 'e', width: 12 }, { header: 'Pendientes de disfrutar', key: 'p', width: 22 }, { header: 'Sin asignar', key: 'u', width: 12 },
  ];
  ws3.getRow(1).font = { bold: true };
  for (const s of data.staff) {
    const st = workerStats(s, data.vacations, data.today);
    ws3.addRow({ n: s.name, g: groupLabel(s.team, s.shift), t: st.total, a: st.assigned, e: st.enjoyed, p: st.pendingToEnjoy, u: st.unassigned });
  }

  const buf = await wb.xlsx.writeBuffer();
  download(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `vacaciones-${data.year}.xlsx`);
}

export async function exportPDF(data) {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const off = offMap(data);
  const cal = buildCal(data);

  doc.setFontSize(18);
  doc.text(`Vacaciones ${data.year}`, 14, 16);
  doc.setFontSize(9);
  doc.setTextColor(100);
  doc.text(`Generado el ${new Date().toLocaleDateString('es-ES')} · ${data.status === 'publicado' ? 'Calendario publicado' : 'Borrador'}`, 14, 22);
  doc.setTextColor(0);
  autoTable(doc, {
    startY: 28,
    head: [['Trabajador', 'Grupo', 'Días', 'Asignados', 'Disfrutados', 'Pendientes', 'Sin asignar', 'Periodos']],
    body: data.staff.map((s) => {
      const st = workerStats(s, data.vacations, data.today);
      const ps = data.vacations.filter((v) => v.worker_id === s.worker_id).sort((a, b) => (a.start < b.start ? -1 : 1))
        .map((v) => `${formatDate(v.start).slice(0, -5)}–${formatDate(v.end).slice(0, -5)}`).join(', ');
      return [s.name, groupLabel(s.team, s.shift), st.total, st.assigned, st.enjoyed, st.pendingToEnjoy, st.unassigned, ps];
    }),
    styles: { fontSize: 8, cellPadding: 1.6 },
    headStyles: { fillColor: [47, 111, 237] },
    columnStyles: { 7: { cellWidth: 110 } },
    didParseCell: (h) => {
      if (h.section === 'body' && h.column.index === 0) {
        const s = data.staff[h.row.index];
        h.cell.styles.fillColor = hexToRgb(colorOf(s).soft);
      }
    },
  });

  for (let m = 0; m < 12; m++) {
    doc.addPage();
    const n = daysInMonth(data.year, m);
    const first = `${data.year}-${String(m + 1).padStart(2, '0')}-01`;
    const i0 = dayIndex(first, data.year);
    doc.setFontSize(14);
    doc.text(`${MONTHS[m]} ${data.year}`, 10, 12);
    const head = [['Trabajador', ...Array.from({ length: n }, (_, d) => `${WEEKDAYS_SHORT[dow(dateFromIndex(data.year, i0 + d))]}\n${d + 1}`)]];
    const body = data.staff.map((s) => [s.name, ...Array.from({ length: n }, (_, d) => (off.get(s.worker_id)[i0 + d] ? 'V' : ''))]);
    const covRows = GROUPS.filter((g) => cal.analysis.groups[g.key].members.length).map((g) => {
      const G = cal.analysis.groups[g.key];
      return [`Disp. ${groupLabel(g.team, g.shift)}`, ...Array.from({ length: n }, (_, d) => `${G.available[i0 + d]}/${G.need[i0 + d]}`)];
    });
    const dayW = (297 - 20 - 40) / n;
    autoTable(doc, {
      startY: 16,
      margin: { left: 10, right: 10 },
      head,
      body: [...body, ...covRows],
      styles: { fontSize: 6.5, cellPadding: 0.8, halign: 'center', lineWidth: 0.1, lineColor: [220, 220, 220] },
      headStyles: { fillColor: [245, 246, 248], textColor: [60, 60, 60], fontSize: 6 },
      columnStyles: { 0: { cellWidth: 40, halign: 'left' }, ...Object.fromEntries(Array.from({ length: n }, (_, d) => [d + 1, { cellWidth: dayW }])) },
      didParseCell: (h) => {
        const d = h.column.index - 1;
        const isWe = d >= 0 && dow(dateFromIndex(data.year, i0 + d)) >= 4;
        if (h.section === 'head' && isWe) h.cell.styles.fillColor = [241, 237, 230];
        if (h.section !== 'body') return;
        if (h.row.index < data.staff.length) {
          const s = data.staff[h.row.index];
          if (h.column.index === 0) { h.cell.styles.fillColor = hexToRgb(colorOf(s).soft); return; }
          if (h.cell.raw === 'V') { h.cell.styles.fillColor = hexToRgb(colorOf(s).strong); h.cell.styles.textColor = [255, 255, 255]; }
          else if (isWe) h.cell.styles.fillColor = [248, 246, 242];
        } else {
          h.cell.styles.fontSize = 5.5;
          h.cell.styles.textColor = [110, 110, 110];
          if (d >= 0) {
            const [a, b] = String(h.cell.raw).split('/').map(Number);
            if (a < b) { h.cell.styles.fillColor = [217, 54, 62]; h.cell.styles.textColor = [255, 255, 255]; }
          }
        }
      },
    });
  }
  doc.save(`vacaciones-${data.year}.pdf`);
}
