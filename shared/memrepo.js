// Almacén en memoria con la misma interfaz que server/db.js. Lo usa la versión de
// demostración (guarda en localStorage) y los tests.
import { SCHEMA } from './schema.js';

export function createMemoryRepo({ load, save } = {}) {
  let state = (load && load()) || null;
  if (!state) state = { seq: {}, tables: {} };
  for (const t of Object.keys(SCHEMA)) { state.tables[t] ||= []; state.seq[t] ||= 0; }
  const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
  const match = (row, filter) => Object.entries(filter || {}).every(([k, v]) => (v === null ? row[k] == null : row[k] === v));
  const pick = (t, obj) => Object.fromEntries(Object.entries(obj).filter(([k]) => SCHEMA[t].includes(k)));
  let depth = 0, snapshot = null;
  const persist = () => { if (save && depth === 0) save(state); };

  return {
    all: (t, filter) => clone(state.tables[t].filter((r) => match(r, filter))),
    get: (t, id) => clone(state.tables[t].find((r) => r.id === id) || null),
    insert(t, obj) {
      const row = { id: ++state.seq[t], ...Object.fromEntries(SCHEMA[t].map((c) => [c, null])), ...clone(pick(t, obj)) };
      state.tables[t].push(row);
      persist();
      return clone(row);
    },
    update(t, id, patch) {
      const row = state.tables[t].find((r) => r.id === id);
      if (row) Object.assign(row, clone(pick(t, patch)));
      persist();
      return clone(row);
    },
    remove(t, id) { state.tables[t] = state.tables[t].filter((r) => r.id !== id); persist(); },
    removeWhere(t, filter) { state.tables[t] = state.tables[t].filter((r) => !match(r, filter)); persist(); },
    tx(fn) {
      if (depth > 0) return fn();
      snapshot = JSON.stringify(state);
      depth++;
      try {
        const r = fn();
        depth--;
        persist();
        return r;
      } catch (e) {
        depth--;
        state = JSON.parse(snapshot);
        throw e;
      }
    },
    reset() { state = { seq: {}, tables: {} }; for (const t of Object.keys(SCHEMA)) { state.tables[t] = []; state.seq[t] = 0; } persist(); },
  };
}
