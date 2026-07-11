// src/routes.js - Todas las rutas de la página (versión 2):
// paneles múltiples, nodos editables, copias organizadas por fechas,
// cancelación de tareas y contador de la próxima copia automática.
const express = require('express');
const bcrypt = require('bcryptjs');
const { db, getSetting, setSetting } = require('./db');
const { encrypt, decrypt } = require('./cipher');
const { withConn, exec, sq } = require('./ssh');
const backup = require('./backup');
const logger = require('./logger');

const router = express.Router();

const PERMISSIONS = [
  ['run_backups', 'Hacer copias manuales'],
  ['restore_backups', 'Restaurar copias'],
  ['download_backups', 'Descargar copias'],
  ['delete_backups', 'Eliminar copias'],
  ['manage_nodes', 'Gestionar nodos y paneles'],
  ['manage_settings', 'Cambiar la configuración'],
  ['manage_admins', 'Gestionar administradores'],
  ['view_logs', 'Ver registros (logs)'],
];

// ---------------------------------------------------------------------------
// Ayudas
// ---------------------------------------------------------------------------
function can(admin, perm) {
  return !!admin && (admin.is_root === 1 || (admin.permissions || []).includes(perm));
}

function requireLogin(req, res, next) {
  if (req.session.admin) return next();
  res.redirect('/login');
}

function requirePerm(perm) {
  return (req, res, next) => {
    if (can(req.session.admin, perm)) return next();
    go(res, back(req), null, 'No tienes permiso para realizar esta acción.');
  };
}

function back(req) {
  const ref = req.get('referer');
  if (!ref) return '/';
  try { return new URL(ref).pathname; } catch (e) { return '/'; }
}

function go(res, path, ok, err) {
  const q = ok ? '?ok=' + encodeURIComponent(ok) : err ? '?err=' + encodeURIComponent(err) : '';
  res.redirect(path + q);
}

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    logger.error(e.message);
    go(res, back(req), null, e.message);
  });

// Cuándo toca la próxima copia automática (timestamp en ms) o null si está apagada
function scheduleParts() {
  // Devuelve los ajustes con compatibilidad hacia el ajuste único anterior.
  const nodesH = parseInt(getSetting('schedule_hours_nodes', getSetting('schedule_hours', '0')), 10) || 0;
  const panelH = parseInt(getSetting('schedule_hours_panel', getSetting('schedule_hours', '0')), 10) || 0;
  const paymenterH = parseInt(getSetting('schedule_hours_paymenter', '0'), 10) || 0;
  const nodesLast = parseInt(getSetting('last_auto_run_nodes', getSetting('last_auto_run', '0')), 10) || Date.now();
  const panelLast = parseInt(getSetting('last_auto_run_panel', getSetting('last_auto_run', '0')), 10) || Date.now();
  const paymenterLast = parseInt(getSetting('last_auto_run_paymenter', '0'), 10) || Date.now();
  return {
    nodesH, panelH, paymenterH,
    next_run_nodes: nodesH ? nodesLast + nodesH * 3600 * 1000 : null,
    next_run_panel: panelH ? panelLast + panelH * 3600 * 1000 : null,
    next_run_paymenter: paymenterH ? paymenterLast + paymenterH * 3600 * 1000 : null,
  };
}

function nextAutoRun() {
  // El "próximo" general es el más cercano de todos (para compatibilidad).
  const p = scheduleParts();
  const times = [p.next_run_nodes, p.next_run_panel, p.next_run_paymenter].filter(Boolean);
  return times.length ? Math.min(...times) : null;
}

// ---------------------------------------------------------------------------
// Inicio de sesión (con límite de intentos por IP)
// ---------------------------------------------------------------------------
const attempts = new Map();

router.get('/login', (req, res) => {
  if (req.session.admin) return res.redirect('/');
  // Seguridad: nunca reflejamos texto libre de la URL (evita XSS por ?err=).
  // Solo se muestran mensajes de una lista conocida; cualquier otra cosa se
  // convierte en un mensaje genérico.
  const ALLOWED_LOGIN_MSGS = {
    invalid: 'Correo o contraseña incorrectos.',
    locked: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.',
    session: 'Tu sesión expiró. Inicia sesión de nuevo.',
    logout: 'Sesión cerrada correctamente.'
  };
  const raw = String(req.query.err || '');
  const error = ALLOWED_LOGIN_MSGS[raw] || (raw ? 'No se pudo iniciar sesión.' : null);
  res.render('login', { error });
});

router.post('/login', (req, res) => {
  const ip = req.ip;
  const a = attempts.get(ip) || { count: 0, until: 0 };
  if (Date.now() < a.until) return go(res, '/login', null, 'Demasiados intentos. Espera 10 minutos.');

  const email = String(req.body.email || '').toLowerCase().trim();
  const admin = db.prepare('SELECT * FROM admins WHERE email = ?').get(email);
  if (!admin || !bcrypt.compareSync(String(req.body.password || ''), admin.password_hash)) {
    a.count++;
    if (a.count >= 8) { a.until = Date.now() + 10 * 60 * 1000; a.count = 0; }
    attempts.set(ip, a);
    return go(res, '/login', null, 'Correo o contraseña incorrectos.');
  }
  attempts.delete(ip);
  req.session.admin = {
    id: admin.id,
    first_name: admin.first_name,
    last_name: admin.last_name,
    email: admin.email,
    is_root: admin.is_root,
    permissions: JSON.parse(admin.permissions || '[]'),
  };
  res.redirect('/');
});

router.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

router.use(requireLogin);

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  const sched = scheduleParts();
  const stats = {
    nodes: db.prepare('SELECT COUNT(*) AS c FROM nodes').get().c,
    panels: db.prepare('SELECT COUNT(*) AS c FROM panels').get().c,
    paymenters: db.prepare('SELECT COUNT(*) AS c FROM paymenters').get().c,
    backups: db.prepare('SELECT COUNT(*) AS c FROM backups').get().c,
    size: db.prepare('SELECT COALESCE(SUM(size),0) AS s FROM backups').get().s,
    last: db.prepare('SELECT created_at FROM backups ORDER BY id DESC LIMIT 1').get(),
    scheduleHoursNodes: sched.nodesH,
    scheduleHoursPanel: sched.panelH,
    scheduleHoursPaymenter: sched.paymenterH,
    retentionHours: parseInt(getSetting('retention_hours', '0'), 10),
  };
  const nodes = db.prepare('SELECT id, name FROM nodes').all();
  res.render('dashboard', { title: 'Inicio', active: 'dash', stats, nodes });
});

// ---------------------------------------------------------------------------
// Paneles (puede haber varios)
// ---------------------------------------------------------------------------
router.post('/panels', requirePerm('manage_nodes'), (req, res) => {
  const { name, host, ssh_port, ssh_user, ssh_password, db_user, db_password, db_name, env_path } = req.body;
  if (!name || !host || !ssh_password || !db_password) {
    return go(res, '/nodes', null, 'Nombre, IP, contraseña SSH y contraseña de la BD son obligatorios.');
  }
  db.prepare(`
    INSERT INTO panels (name, host, ssh_port, ssh_user, ssh_password, db_user, db_password, db_name, env_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name.trim(), host.trim(), parseInt(ssh_port, 10) || 22, (ssh_user || 'root').trim(),
    encrypt(ssh_password), (db_user || 'pterodactyl').trim(), encrypt(db_password),
    (db_name || 'panel').trim(), (env_path || '/var/www/pterodactyl/.env').trim()
  );
  logger.info(`Panel agregado: "${name}" (${host}).`);
  go(res, '/nodes', `Panel "${name}" agregado.`);
});

router.post('/panels/:id/update', requirePerm('manage_nodes'), (req, res) => {
  const p = db.prepare('SELECT * FROM panels WHERE id = ?').get(req.params.id);
  if (!p) return go(res, '/nodes', null, 'El panel no existe.');
  const { name, host, ssh_port, ssh_user, ssh_password, db_user, db_password, db_name, env_path } = req.body;
  if (!name || !host) return go(res, '/nodes', null, 'El nombre y la IP son obligatorios.');
  db.prepare(`
    UPDATE panels SET name=?, host=?, ssh_port=?, ssh_user=?, ssh_password=?, db_user=?, db_password=?, db_name=?, env_path=?
    WHERE id=?
  `).run(
    name.trim(), host.trim(), parseInt(ssh_port, 10) || 22, (ssh_user || 'root').trim(),
    ssh_password ? encrypt(ssh_password) : p.ssh_password,
    (db_user || 'pterodactyl').trim(),
    db_password ? encrypt(db_password) : p.db_password,
    (db_name || 'panel').trim(), (env_path || '/var/www/pterodactyl/.env').trim(),
    p.id
  );
  logger.info(`Panel actualizado: "${name}" (por ${req.session.admin.email}).`);
  go(res, '/nodes', `Panel "${name}" actualizado.`);
});

router.post('/panels/:id/delete', requirePerm('manage_nodes'), (req, res) => {
  const p = db.prepare('SELECT * FROM panels WHERE id = ?').get(req.params.id);
  if (!p) return go(res, '/nodes', null, 'El panel no existe.');
  db.prepare('DELETE FROM panels WHERE id = ?').run(p.id);
  db.prepare('UPDATE nodes SET panel_id = NULL WHERE panel_id = ?').run(p.id);
  logger.info(`Panel eliminado: "${p.name}" (sus copias guardadas se conservan).`);
  go(res, '/nodes', `Panel "${p.name}" eliminado.`);
});

router.post('/panels/:id/test', requirePerm('manage_nodes'), wrap(async (req, res) => {
  const p = db.prepare('SELECT * FROM panels WHERE id = ?').get(req.params.id);
  if (!p) return res.json({ ok: false, message: 'El panel no existe.' });
  try {
    const out = await withConn(
      { host: p.host, port: p.ssh_port, user: p.ssh_user, password: decrypt(p.ssh_password) },
      (conn) => exec(conn, `mysql -N -B -h 127.0.0.1 -u ${sq(p.db_user)} -p${sq(decrypt(p.db_password))} ${sq(p.db_name)} -e ${sq('SELECT COUNT(*) FROM servers')}`)
    );
    res.json({ ok: true, message: `Conexión correcta con "${p.name}". Servidores en el panel: ${out.trim()}.` });
  } catch (e) {
    res.json({ ok: false, message: e.message });
  }
}));

// ---------------------------------------------------------------------------
// Paymenter (puede haber varias instalaciones)
// ---------------------------------------------------------------------------
router.post('/paymenters', requirePerm('manage_nodes'), (req, res) => {
  const { name, host, ssh_port, ssh_user, ssh_password, db_user, db_password, db_name, env_path } = req.body;
  if (!name || !host || !ssh_password || !db_password) {
    return go(res, '/nodes', null, 'Nombre, IP, contraseña SSH y contraseña de la BD son obligatorios.');
  }
  db.prepare(`
    INSERT INTO paymenters (name, host, ssh_port, ssh_user, ssh_password, db_user, db_password, db_name, env_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name.trim(), host.trim(), parseInt(ssh_port, 10) || 22, (ssh_user || 'root').trim(),
    encrypt(ssh_password), (db_user || 'paymenter').trim(), encrypt(db_password),
    (db_name || 'paymenter').trim(), (env_path || '/var/www/paymenter/.env').trim()
  );
  logger.info(`Paymenter agregado: "${name}" (${host}).`);
  go(res, '/nodes', `Paymenter "${name}" agregado.`);
});

router.post('/paymenters/:id/update', requirePerm('manage_nodes'), (req, res) => {
  const pm = db.prepare('SELECT * FROM paymenters WHERE id = ?').get(req.params.id);
  if (!pm) return go(res, '/nodes', null, 'El Paymenter no existe.');
  const { name, host, ssh_port, ssh_user, ssh_password, db_user, db_password, db_name, env_path } = req.body;
  if (!name || !host) return go(res, '/nodes', null, 'El nombre y la IP son obligatorios.');
  db.prepare(`
    UPDATE paymenters SET name=?, host=?, ssh_port=?, ssh_user=?, ssh_password=?, db_user=?, db_password=?, db_name=?, env_path=?
    WHERE id=?
  `).run(
    name.trim(), host.trim(), parseInt(ssh_port, 10) || 22, (ssh_user || 'root').trim(),
    ssh_password ? encrypt(ssh_password) : pm.ssh_password,
    (db_user || 'paymenter').trim(),
    db_password ? encrypt(db_password) : pm.db_password,
    (db_name || 'paymenter').trim(), (env_path || '/var/www/paymenter/.env').trim(),
    pm.id
  );
  logger.info(`Paymenter actualizado: "${name}" (por ${req.session.admin.email}).`);
  go(res, '/nodes', `Paymenter "${name}" actualizado.`);
});

router.post('/paymenters/:id/delete', requirePerm('manage_nodes'), (req, res) => {
  const pm = db.prepare('SELECT * FROM paymenters WHERE id = ?').get(req.params.id);
  if (!pm) return go(res, '/nodes', null, 'El Paymenter no existe.');
  db.prepare('DELETE FROM paymenters WHERE id = ?').run(pm.id);
  logger.info(`Paymenter eliminado: "${pm.name}" (sus copias guardadas se conservan).`);
  go(res, '/nodes', `Paymenter "${pm.name}" eliminado.`);
});

router.post('/paymenters/:id/test', requirePerm('manage_nodes'), wrap(async (req, res) => {
  const pm = db.prepare('SELECT * FROM paymenters WHERE id = ?').get(req.params.id);
  if (!pm) return res.json({ ok: false, message: 'El Paymenter no existe.' });
  try {
    const out = await withConn(
      { host: pm.host, port: pm.ssh_port, user: pm.ssh_user, password: decrypt(pm.ssh_password) },
      (conn) => exec(conn, `mysql -N -B -h 127.0.0.1 -u ${sq(pm.db_user)} -p${sq(decrypt(pm.db_password))} ${sq(pm.db_name)} -e ${sq('SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE()')}`)
    );
    res.json({ ok: true, message: `Conexión correcta con "${pm.name}". Tablas en la base de datos: ${out.trim()}.` });
  } catch (e) {
    res.json({ ok: false, message: e.message });
  }
}));

// ---------------------------------------------------------------------------
// Nodos
// ---------------------------------------------------------------------------
router.get('/nodes', (req, res) => {
  const panels = db.prepare('SELECT * FROM panels ORDER BY id').all();
  const paymenters = db.prepare('SELECT * FROM paymenters ORDER BY id').all();
  const nodes = db.prepare(`
    SELECT n.*, p.name AS panel_name FROM nodes n
    LEFT JOIN panels p ON p.id = n.panel_id
    ORDER BY n.id
  `).all();
  res.render('nodes', { title: 'Nodos y Paneles', active: 'nodes', nodes, panels, paymenters });
});

router.post('/nodes', requirePerm('manage_nodes'), (req, res) => {
  const { name, host, ssh_port, ssh_user, ssh_password, panel_id } = req.body;
  if (!name || !host || !ssh_password) return go(res, '/nodes', null, 'Nombre, IP y contraseña SSH son obligatorios.');
  db.prepare('INSERT INTO nodes (name, host, ssh_port, ssh_user, ssh_password, panel_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name.trim(), host.trim(), parseInt(ssh_port, 10) || 22, (ssh_user || 'root').trim(), encrypt(ssh_password), parseInt(panel_id, 10) || null);
  logger.info(`Nodo agregado: "${name}" (${host}).`);
  go(res, '/nodes', `Nodo "${name}" agregado correctamente.`);
});

router.post('/nodes/:id/update', requirePerm('manage_nodes'), (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return go(res, '/nodes', null, 'El nodo no existe.');
  const { name, host, ssh_port, ssh_user, ssh_password, panel_id } = req.body;
  if (!name || !host) return go(res, '/nodes', null, 'El nombre y la IP son obligatorios.');
  db.prepare('UPDATE nodes SET name=?, host=?, ssh_port=?, ssh_user=?, ssh_password=?, panel_id=? WHERE id=?')
    .run(
      name.trim(), host.trim(), parseInt(ssh_port, 10) || 22, (ssh_user || 'root').trim(),
      ssh_password ? encrypt(ssh_password) : node.ssh_password,
      parseInt(panel_id, 10) || null,
      node.id
    );
  logger.info(`Nodo actualizado: "${name}" (por ${req.session.admin.email}).`);
  go(res, '/nodes', `Nodo "${name}" actualizado.`);
});

router.post('/nodes/:id/delete', requirePerm('manage_nodes'), (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return go(res, '/nodes', null, 'El nodo no existe.');
  db.prepare('DELETE FROM nodes WHERE id = ?').run(node.id);
  logger.info(`Nodo eliminado: "${node.name}" (sus copias existentes se conservan).`);
  go(res, '/nodes', `Nodo "${node.name}" eliminado.`);
});

router.post('/nodes/:id/test', requirePerm('manage_nodes'), wrap(async (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.json({ ok: false, message: 'El nodo no existe.' });
  try {
    const out = await withConn(
      { host: node.host, port: node.ssh_port, user: node.ssh_user, password: decrypt(node.ssh_password) },
      async (conn) => {
        const zipOk = (await exec(conn, 'command -v zip >/dev/null && command -v unzip >/dev/null && echo OK || echo NO')).trim();
        const volumes = (await exec(conn, `ls -1 /var/lib/pterodactyl/volumes 2>/dev/null | wc -l`)).trim();
        return { zipOk, volumes };
      }
    );
    let msg = `Conexión correcta. Volúmenes detectados: ${out.volumes}.`;
    if (out.zipOk !== 'OK') msg += ' AVISO: instala zip y unzip en este nodo (apt install -y zip unzip).';
    res.json({ ok: true, message: msg });
  } catch (e) {
    res.json({ ok: false, message: e.message });
  }
}));

// ---------------------------------------------------------------------------
// Copias: vista general (tarjetas por nodo + BD de paneles aparte)
// ---------------------------------------------------------------------------
router.get('/backups', (req, res) => {
  const nodes = db.prepare(`
    SELECT n.*,
      (SELECT COUNT(*) FROM snapshots s WHERE s.node_id = n.id) AS snaps,
      (SELECT MAX(created_at) FROM snapshots s WHERE s.node_id = n.id) AS last_snap,
      (SELECT COALESCE(SUM(size),0) FROM backups b WHERE b.node_id = n.id AND b.type = 'server') AS total_size
    FROM nodes n ORDER BY n.id
  `).all();
  const panelBackups = db.prepare(`
    SELECT b.*, p.name AS panel_name FROM backups b
    LEFT JOIN panels p ON p.id = b.panel_id
    WHERE b.type = 'panel_db' ORDER BY b.id DESC LIMIT 300
  `).all();
  const paymenterBackups = db.prepare(`
    SELECT b.*, pm.name AS paymenter_name FROM backups b
    LEFT JOIN paymenters pm ON pm.id = b.paymenter_id
    WHERE b.type = 'paymenter_db' ORDER BY b.id DESC LIMIT 300
  `).all();
  const paymenters = db.prepare('SELECT id, name FROM paymenters ORDER BY id').all();
  res.render('backups', { title: 'Copias', active: 'backups', nodes, panelBackups, paymenterBackups, paymenters });
});

// Fechas de copia de UN nodo
router.get('/nodes/:id/backups', (req, res) => {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return go(res, '/backups', null, 'El nodo no existe.');
  const snapshots = db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM backups b WHERE b.snapshot_id = s.id) AS cnt,
      (SELECT COALESCE(SUM(size),0) FROM backups b WHERE b.snapshot_id = s.id) AS total_size
    FROM snapshots s WHERE s.node_id = ? ORDER BY s.id DESC
  `).all(node.id);
  res.render('node_backups', { title: `Copias de ${node.name}`, active: 'backups', node, snapshots });
});

// Servidores dentro de UNA fecha de copia
router.get('/snapshots/:id', (req, res) => {
  const snap = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(req.params.id);
  if (!snap) return go(res, '/backups', null, 'La fecha de copia no existe.');
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(snap.node_id);
  const rows = db.prepare("SELECT * FROM backups WHERE snapshot_id = ? AND type = 'server' ORDER BY owner_name, server_name").all(snap.id);
  res.render('snapshot', { title: `Copia ${snap.created_at}`, active: 'backups', snap, node, rows });
});

// ---------------------------------------------------------------------------
// Acciones de copias
// ---------------------------------------------------------------------------
router.post('/backups/run', requirePerm('run_backups'), (req, res) => {
  if (backup.job.active) return go(res, back(req), null, 'Ya hay una tarea en ejecución.');
  const target = ['all', 'both', 'nodes', 'panel', 'paymenter', 'node'].includes(req.body.target) ? req.body.target : 'both';
  const opts = target === 'node' ? { target: 'nodes', nodeId: parseInt(req.body.node_id, 10) } : { target };
  logger.info(`Copia manual iniciada por ${req.session.admin.email}.`);
  backup.runBackup(opts).catch((e) => logger.error(e.message));
  go(res, back(req) === '/login' ? '/' : back(req), 'Copia iniciada. Mira el progreso arriba (puedes cancelarla).');
});

router.get('/backups/:id/download', requirePerm('download_backups'), (req, res) => {
  const b = db.prepare('SELECT * FROM backups WHERE id = ?').get(req.params.id);
  if (!b) return go(res, '/backups', null, 'La copia no existe.');
  const file = backup.backupFilePath(b);
  res.download(file, b.filename, (err) => {
    if (err && !res.headersSent) go(res, '/backups', null, 'El archivo ya no existe en el disco.');
  });
});

router.post('/backups/:id/delete', requirePerm('delete_backups'), wrap(async (req, res) => {
  backup.deleteBackup(req.params.id);
  go(res, back(req), 'Copia eliminada.');
}));

router.post('/backups/:id/restore', requirePerm('restore_backups'), (req, res) => {
  const wipe = req.body.wipe === '1';
  logger.info(`Restauración de un servidor iniciada por ${req.session.admin.email} (copia #${req.params.id}).`);
  backup.restoreServer(req.params.id, wipe).catch((e) => logger.error(e.message));
  go(res, back(req), 'Restauración iniciada. Mira el progreso arriba.');
});

// Restaurar TODOS los servidores de una fecha (no toca la BD del panel)
router.post('/snapshots/:id/restore', requirePerm('restore_backups'), (req, res) => {
  const wipe = req.body.wipe === '1';
  logger.info(`Restauración de fecha completa iniciada por ${req.session.admin.email} (fecha #${req.params.id}).`);
  backup.restoreSnapshot(parseInt(req.params.id, 10), wipe).catch((e) => logger.error(e.message));
  go(res, back(req), 'Restauración de la fecha iniciada. Mira el progreso arriba.');
});

router.post('/snapshots/:id/delete', requirePerm('delete_backups'), wrap(async (req, res) => {
  const snap = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(req.params.id);
  if (!snap) return go(res, '/backups', null, 'La fecha de copia no existe.');
  backup.deleteSnapshot(snap.id);
  go(res, `/nodes/${snap.node_id}/backups`, 'Fecha de copia eliminada.');
}));

router.post('/restore-panel', requirePerm('restore_backups'), (req, res) => {
  const id = parseInt(req.body.backup_id, 10);
  let target = null;
  if (req.body.mode === 'custom') {
    target = {
      host: String(req.body.host || '').trim(),
      ssh_port: parseInt(req.body.ssh_port, 10) || 22,
      ssh_user: (req.body.ssh_user || 'root').trim(),
      ssh_password: req.body.ssh_password,
      db_user: (req.body.db_user || 'pterodactyl').trim(),
      db_password: req.body.db_password,
      db_name: (req.body.db_name || 'panel').trim(),
    };
    if (!target.host || !target.ssh_password || !target.db_password) {
      return go(res, '/backups', null, 'Para restaurar a otro VPS necesitas IP, contraseña SSH y contraseña de la BD.');
    }
  }
  logger.info(`Restauración de la BD de un panel iniciada por ${req.session.admin.email}.`);
  backup.restorePanelDb(id, target).catch((e) => logger.error(e.message));
  go(res, '/backups', 'Restauración de la base de datos iniciada. Mira el progreso arriba.');
});

// Restaurar la BD de Paymenter (al Paymenter de la copia o a otro VPS)
router.post('/restore-paymenter', requirePerm('restore_backups'), (req, res) => {
  const id = parseInt(req.body.backup_id, 10);
  let target = null;
  if (req.body.mode === 'custom') {
    target = {
      host: String(req.body.host || '').trim(),
      ssh_port: parseInt(req.body.ssh_port, 10) || 22,
      ssh_user: (req.body.ssh_user || 'root').trim(),
      ssh_password: req.body.ssh_password,
      db_user: (req.body.db_user || 'paymenter').trim(),
      db_password: req.body.db_password,
      db_name: (req.body.db_name || 'paymenter').trim(),
    };
    if (!target.host || !target.ssh_password || !target.db_password) {
      return go(res, '/backups', null, 'Para restaurar a otro VPS necesitas IP, contraseña SSH y contraseña de la BD.');
    }
  }
  logger.info(`Restauración de la BD de Paymenter iniciada por ${req.session.admin.email}.`);
  backup.restorePaymenterDb(id, target).catch((e) => logger.error(e.message));
  go(res, '/backups', 'Restauración de la base de datos de Paymenter iniciada. Mira el progreso arriba.');
});

// ---------------------------------------------------------------------------
// API de estado: progreso + próxima copia automática
// ---------------------------------------------------------------------------
router.get('/api/job', (req, res) => {
  const p = scheduleParts();
  res.json({
    ...backup.job,
    next_run: nextAutoRun(),
    next_run_nodes: p.next_run_nodes,
    next_run_panel: p.next_run_panel,
    next_run_paymenter: p.next_run_paymenter,
    server_now: Date.now(),
  });
});

router.post('/api/job/cancel', (req, res) => {
  if (!can(req.session.admin, 'run_backups')) {
    return res.json({ ok: false, message: 'No tienes permiso para cancelar tareas.' });
  }
  const ok = backup.requestCancel();
  res.json({ ok, message: ok ? 'Cancelando la tarea...' : 'No hay ninguna tarea en ejecución.' });
});

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------
router.get('/settings', requirePerm('manage_settings'), (req, res) => {
  res.render('settings', {
    title: 'Configuración',
    active: 'settings',
    scheduleHoursNodes: getSetting('schedule_hours_nodes', getSetting('schedule_hours', '0')),
    scheduleHoursPanel: getSetting('schedule_hours_panel', getSetting('schedule_hours', '0')),
    scheduleHoursPaymenter: getSetting('schedule_hours_paymenter', '0'),
    retentionHours: getSetting('retention_hours', '0'),
    backupTarget: getSetting('backup_target', 'both'),
    extApiKey: getSetting('ext_api_key', ''),
    extUrl: `${req.protocol}://${req.get('host')}`,
  });
});

// Regenerar la clave de API de la extensión del panel
router.post('/settings/regen-key', requirePerm('manage_settings'), (req, res) => {
  const extapi = require('./extapi');
  extapi.regenerateKey();
  logger.warn(`Clave de API de la extensión regenerada por ${req.session.admin.email}. Hay que actualizarla en el panel.`);
  go(res, '/settings', 'Clave nueva generada. Recuerda pegarla también en el panel (/admin/pterobackups).');
});

router.post('/settings', requirePerm('manage_settings'), (req, res) => {
  const valid = ['0', '1', '24', '168', '360', '720'];
  const prevNodes = getSetting('schedule_hours_nodes', getSetting('schedule_hours', '0'));
  const prevPanel = getSetting('schedule_hours_panel', getSetting('schedule_hours', '0'));
  const prevPaymenter = getSetting('schedule_hours_paymenter', '0');
  const newNodes = valid.includes(req.body.schedule_hours_nodes) ? req.body.schedule_hours_nodes : '0';
  const newPanel = valid.includes(req.body.schedule_hours_panel) ? req.body.schedule_hours_panel : '0';
  const newPaymenter = valid.includes(req.body.schedule_hours_paymenter) ? req.body.schedule_hours_paymenter : '0';
  setSetting('schedule_hours_nodes', newNodes);
  setSetting('schedule_hours_panel', newPanel);
  setSetting('schedule_hours_paymenter', newPaymenter);
  setSetting('retention_hours', valid.includes(req.body.retention_hours) ? req.body.retention_hours : '0');
  // Cada contador se reinicia solo si su intervalo cambió (para no reiniciar los otros).
  const now = String(Date.now());
  if (newNodes !== prevNodes) setSetting('last_auto_run_nodes', now);
  if (newPanel !== prevPanel) setSetting('last_auto_run_panel', now);
  if (newPaymenter !== prevPaymenter) setSetting('last_auto_run_paymenter', now);
  logger.info(`Configuración actualizada por ${req.session.admin.email}.`);
  go(res, '/settings', 'Configuración guardada.');
});

// ---------------------------------------------------------------------------
// Administradores
// ---------------------------------------------------------------------------
router.get('/admins', requirePerm('manage_admins'), (req, res) => {
  const admins = db.prepare('SELECT id, first_name, last_name, email, is_root, permissions, created_at FROM admins ORDER BY id').all()
    .map((a) => ({ ...a, permissions: JSON.parse(a.permissions || '[]') }));
  res.render('admins', { title: 'Administradores', active: 'admins', admins, PERMISSIONS });
});

router.post('/admins', requirePerm('manage_admins'), (req, res) => {
  const { first_name, last_name, email, password } = req.body;
  if (!first_name || !last_name || !email || !password) return go(res, '/admins', null, 'Todos los campos son obligatorios.');
  if (password.length < 8) return go(res, '/admins', null, 'La contraseña debe tener al menos 8 caracteres.');
  const perms = PERMISSIONS.map(([k]) => k).filter((k) => req.body['perm_' + k] === '1');
  try {
    db.prepare('INSERT INTO admins (first_name, last_name, email, password_hash, is_root, permissions) VALUES (?, ?, ?, ?, 0, ?)')
      .run(first_name.trim(), last_name.trim(), email.toLowerCase().trim(), bcrypt.hashSync(password, 12), JSON.stringify(perms));
  } catch (e) {
    return go(res, '/admins', null, 'Ese correo ya está registrado.');
  }
  logger.info(`Administrador creado desde la página: ${email} (por ${req.session.admin.email}).`);
  go(res, '/admins', `Administrador ${email} creado.`);
});

router.post('/admins/:id/delete', requirePerm('manage_admins'), (req, res) => {
  const target = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.params.id);
  if (!target) return go(res, '/admins', null, 'El administrador no existe.');
  if (target.id === req.session.admin.id) return go(res, '/admins', null, 'No puedes eliminar tu propia cuenta.');
  if (target.is_root && !req.session.admin.is_root) {
    return go(res, '/admins', null, 'Solo un administrador raíz (creado desde la consola) puede eliminar a otro raíz.');
  }
  db.prepare('DELETE FROM admins WHERE id = ?').run(target.id);
  logger.info(`Administrador eliminado: ${target.email} (por ${req.session.admin.email}).`);
  go(res, '/admins', `Administrador ${target.email} eliminado.`);
});

router.post('/admins/:id/password', requirePerm('manage_admins'), (req, res) => {
  const target = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.params.id);
  if (!target) return go(res, '/admins', null, 'El administrador no existe.');
  if (target.is_root && !req.session.admin.is_root && target.id !== req.session.admin.id) {
    return go(res, '/admins', null, 'Solo un administrador raíz puede cambiar la contraseña de otro raíz.');
  }
  const password = String(req.body.password || '');
  if (password.length < 8) return go(res, '/admins', null, 'La contraseña debe tener al menos 8 caracteres.');
  db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 12), target.id);
  logger.info(`Contraseña cambiada para ${target.email} (por ${req.session.admin.email}).`);
  go(res, '/admins', `Contraseña de ${target.email} actualizada.`);
});

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------
router.get('/logs', requirePerm('view_logs'), (req, res) => {
  const logs = db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT 300').all();
  res.render('logs', { title: 'Logs', active: 'logs', logs });
});

router.post('/logs/clear', requirePerm('view_logs'), (req, res) => {
  if (!req.session.admin.is_root) return go(res, '/logs', null, 'Solo un administrador raíz puede vaciar los logs.');
  db.prepare('DELETE FROM logs').run();
  go(res, '/logs', 'Registros vaciados.');
});

module.exports = { router, PERMISSIONS };
