// Servidor web: sirve la aplicación y una API /api/<acción> que delega en shared/service.js.
import express from 'express';
import cookieParser from 'cookie-parser';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openRepo } from './db.js';
import { createService, ApiError } from '../shared/service.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 3000);
const DB_FILE = process.env.DB_FILE || join(root, 'data', 'vacaciones.db');
const COOKIE = 'vac_session';

function hashPassword(pw) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${scryptSync(pw, salt, 32).toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [, salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const a = scryptSync(pw, salt, 32);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createApp({ dbFile = DB_FILE } = {}) {
  const repo = openRepo(dbFile);
  const service = createService({ repo, hashPassword, verifyPassword, randomToken: () => randomBytes(32).toString('hex') });
  const adminUsername = process.env.ADMIN_USERNAME || 'admin';
  const seeded = service.seed({ adminUsername, adminPassword: process.env.ADMIN_PASSWORD || 'admin' });
  if (seeded) console.log(`Base de datos creada con datos de ejemplo. Administrador: ${adminUsername.toLowerCase()} / contraseña: ${process.env.ADMIN_PASSWORD ? '(ADMIN_PASSWORD)' : 'admin'}`);

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  app.post('/api/:action', (req, res) => {
    const { action } = req.params;
    try {
      const token = req.cookies[COOKIE];
      const result = service.call(token, action, req.body);
      if (action === 'login') {
        res.cookie(COOKIE, result.token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 1000 * 60 * 60 * 24 * 60 });
        return res.json({ user: result.user });
      }
      if (action === 'logout') res.clearCookie(COOKIE);
      res.json(result ?? { ok: true });
    } catch (e) {
      if (e instanceof ApiError) return res.status(e.status).json({ error: e.message, details: e.details });
      console.error(e);
      res.status(500).json({ error: 'Error interno del servidor.' });
    }
  });

  app.use(express.static(join(root, 'dist'), { index: 'index.html', maxAge: '1h' }));
  app.get('*', (_, res) => res.sendFile(join(root, 'dist', 'index.html')));
  return { app, service, repo };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { app } = createApp();
  app.set('trust proxy', 1);
  app.listen(PORT, () => console.log(`Vacaciones del bar en http://localhost:${PORT}`));
}
