// Tablas de la base de datos. Cada tabla tiene además una columna "id" autonumérica.
// Las columnas marcadas en JSON_COLUMNS se guardan como texto JSON.

export const SCHEMA = {
  users: ['username', 'password_hash', 'role', 'worker_id', 'created_at'],
  sessions: ['token', 'user_id', 'created_at'],
  workers: ['first_name', 'last_name', 'created_at'],
  years: ['year', 'status', 'published_at'],
  staff: ['year', 'worker_id', 'team', 'shift', 'days', 'flex'],
  vacations: ['year', 'worker_id', 'start', 'end', 'note', 'created_at'],
  blocked: ['year', 'start', 'end', 'reason'],
  reinforcements: ['team', 'shift', 'start', 'end', 'count', 'note'],
  preferences: ['year', 'worker_id', 'start', 'end', 'note'],
  requests: ['year', 'type', 'status', 'requester_id', 'target_id', 'data', 'comment', 'admin_comment', 'created_at', 'resolved_at'],
  notifications: ['user_id', 'text', 'link', 'read', 'created_at'],
  history: ['year', 'user_name', 'action', 'detail', 'created_at'],
  settings: ['key', 'value'],
};

export const JSON_COLUMNS = { requests: ['data'], settings: ['value'] };

export const INTEGER_COLUMNS = new Set(['worker_id', 'year', 'days', 'flex', 'count', 'user_id', 'requester_id', 'target_id', 'read']);
