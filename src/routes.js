// src/routes.js - Todas las rutas de la página: inicio de sesión, dashboard,
// nodos y panel, copias, configuración, administradores y logs.
const express = require('express');
const bcrypt = require('bcryptjs');
const { db, getSetting, setSetting } = require('./db');
const { encrypt, decrypt } = require('./cipher');
const { withConn, exec, sq } = require('./ssh');
const backup = require('./backup');
const logger = require('./logger');

const router = express.Router();

// Lista de permisos que se pueden asignar a los administradores creados desde la página
const PERMISSIONS = [
  ['run_backups', 'Hacer copias manuales'],
  ['restore_backups', 'Restaurar copias'],
  ['download_backups', 'Descargar copias'],
  ['delete_backups', 'Eliminar copias'],
  ['manage_nodes', 'Gestionar nodos y panel'],
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
    res.redirect(back(req) + '?err=' + encodeURIComponent('No tienes permiso para realizar esta acción.'));
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

// Envuelve rutas async para capturar errores y mostrarlos como aviso
const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    logger.error(e.message);
    go(res, back(req), null, e.message);
  });

// ---------------------------------------------------------------------------
// Inicio de sesión (con límite de intentos por IP)
// ---------------------------------------------------------------------------
const attempts = new Map(); // ip -> { count, until }

router.get('/login', (req, res) => {
  if (req.session.admin) return res.redirect('/');
  res.render('login', { error: req.query.err || null });
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

// A partir de aquí, todo requiere haber iniciado sesión
router.use(requireLogin);

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  const stats = {
    nodes: db.prepare('SELECT COUNT(*) AS c FROM nodes').get().c,
    backups: db.prepare('SELECT COUNT(*) AS c FROM backups').get().c,
    size: db.prepare('SELECT COALESCE(SUM(size),0) AS s FROM backups').get().s,
    last: db.prepare('SELECT created_at FROM backups ORDER BY id DESC LIMIT 1').get(),
    panelConfigured: !!backup.getPanelConfig(),
    scheduleHours: parseInt(getSetting('schedule_hours', '0'), 10),
    retentionHours: parseInt(getSetting('retention_hours', '0'), 10),
  };
  const nodes = db.prepare('SELECT id, name FROM nodes').all();
  res.render('dashboard', { title: 'Panel', active: 'dash', stats, nodes });
});

// ---------------------------------------------------------------------------
// Nodos y configuración del panel
// ---------------------------------------------------------------------------
router.get('/nodes', (req, res) => {
  const nodes = db.prepare('SELECT * FROM nodes ORDER BY id').all();
  const panel = backup.getPanelConfig();
  res.render('nodes', { title: 'Nodos y Panel', active: 'nodes', nodes, panel });
});

router.post('/nodes', requirePerm('manage_nodes'), (req, res) => {
  const { name, host, ssh_port, ssh_user, ssh_password } = req.body;
  if (!name || !host || !ssh_password) return go(res, '/nodes', null, 'Nombre, IP y contraseña SSH son obligatorios.');
  db.prepare('INSERT INTO nodes (name, host, ssh_port, ssh_user, ssh_password) VALUES (?, ?, ?, ?, ?)')
    .run(name.trim(), host.trim(), parseInt(ssh_port, 10) || 22, (ssh_user || 'root').trim(), encrypt(ssh_password));
  logger.info(`Nodo agregado: "${name}" (${host})`);
  go(res, '/nodes', `Nodo "${name}" agregado correctamente.`);
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

router.post('/panel', requirePerm('manage_nodes'), (req, res) => {
  const { host, ssh_port, ssh_user, ssh_password, db_user, db_password, db_name, env_path } = req.body;
  const current = backup.getPanelConfig();
  if (!host) return go(res, '/nodes', null, 'La IP del panel es obligatoria.');
  if (!current && (!ssh_password || !db_password)) {
    return go(res, '/nodes', null, 'La contraseña SSH y la de la base de datos son obligatorias.');
  }
  const sshPass = ssh_password ? encrypt(ssh_password) : current.ssh_password;
  const dbPass = db_password ? encrypt(db_password) : current.db_password;
  db.prepare(`
    INSERT INTO panel_config (id, host, ssh_port, ssh_user, ssh_password, db_user, db_password, db_name, env_path)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET host=excluded.host, ssh_port=excluded.ssh_port, ssh_user=excluded.ssh_user,
      ssh_password=excluded.ssh_password, db_user=excluded.db_user, db_password=excluded.db_password,
      db_name=excluded.db_name, env_path=excluded.env_path
  `).run(
    host.trim(),
    parseInt(ssh_port, 10) || 22,
    (ssh_user || 'root').trim(),
    sshPass,
    (db_user || 'pterodactyl').trim(),
    dbPass,
    (db_name || 'panel').trim(),
    (env_path || '/var/www/pterodactyl/.env').trim()
  );
  logger.info(`Configuración del panel guardada (${host}).`);
  go(res, '/nodes', 'Configuración del panel guardada.');
});

router.post('/panel/test', requirePerm('manage_nodes'), wrap(async (req, res) => {
  const p = backup.getPanelConfig();
  if (!p) return res.json({ ok: false, message: 'Primero guarda la configuración del panel.' });
  try {
    const out = await withConn(
      { host: p.host, port: p.ssh_port, user: p.ssh_user, password: decrypt(p.ssh_password) },
      (conn) => exec(conn, `mysql -N -B -h 127.0.0.1 -u ${sq(p.db_user)} -p${sq(decrypt(p.db_password))} ${sq(p.db_name)} -e ${sq('SELECT COUNT(*) FROM servers')}`)
    );
    res.json({ ok: true, message: `Conexión correcta. Servidores en el panel: ${out.trim()}.` });
  } catch (e) {
    res.json({ ok: false, message: e.message });
  }
}));

// ---------------------------------------------------------------------------
// Copias de seguridad
// ---------------------------------------------------------------------------
router.get('/backups', (req, res) => {
  const rows = db.prepare(`
    SELECT b.*, n.name AS node_name FROM backups b
    LEFT JOIN nodes n ON n.id = b.node_id
    ORDER BY b.id DESC LIMIT 1000
  `).all();
  const nodes = db.prepare('SELECT id, name FROM nodes').all();
  const panelBackups = rows.filter((r) => r.type === 'panel_db');
  res.render('backups', { title: 'Copias', active: 'backups', rows, nodes, panelBackups });
});

// Copia manual (botón "Hacer copia ahora"). Se ejecuta en segundo plano.
router.post('/backups/run', requirePerm('run_backups'), (req, res) => {
  if (backup.job.active) return go(res, back(req), null, 'Ya hay una tarea en ejecución.');
  const target = ['both', 'nodes', 'panel', 'node'].includes(req.body.target) ? req.body.target : 'both';
  const opts = target === 'node' ? { target: 'nodes', nodeId: parseInt(req.body.node_id, 10) } : { target };
  logger.info(`Copia manual iniciada por ${req.session.admin.email}.`);
  backup.runBackup(opts).catch((e) => logger.error(e.message));
  go(res, back(req) === '/login' ? '/' : back(req), 'Copia iniciada. Puedes ver el progreso en tiempo real arriba.');
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
  go(res, '/backups', 'Copia eliminada.');
}));

router.post('/backups/:id/restore', requirePerm('restore_backups'), (req, res) => {
  const wipe = req.body.wipe === '1';
  logger.info(`Restauración iniciada por ${req.session.admin.email} (copia #${req.params.id}).`);
  backup.restoreServer(req.params.id, wipe).catch((e) => logger.error(e.message));
  go(res, '/backups', 'Restauración iniciada. Mira el progreso arriba.');
});

router.post('/restore-all', requirePerm('restore_backups'), (req, res) => {
  const nodeId = req.body.node_id ? parseInt(req.body.node_id, 10) : null;
  const wipe = req.body.wipe === '1';
  logger.info(`Restauración masiva iniciada por ${req.session.admin.email}.`);
  backup.restoreAll(nodeId, wipe).catch((e) => logger.error(e.message));
  go(res, '/backups', 'Restauración masiva iniciada. Mira el progreso arriba.');
});

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
  logger.info(`Restauración de la BD del panel iniciada por ${req.session.admin.email}.`);
  backup.restorePanelDb(id, target).catch((e) => logger.error(e.message));
  go(res, '/backups', 'Restauración de la base de datos iniciada. Mira el progreso arriba.');
});

// Estado de la tarea actual (para refrescar la barra de progreso al cargar la página)
router.get('/api/job', (req, res) => res.json(backup.job));

// ---------------------------------------------------------------------------
// Configuración (copias automáticas y retención)
// ---------------------------------------------------------------------------
router.get('/settings', requirePerm('manage_settings'), (req, res) => {
  res.render('settings', {
    title: 'Configuración',
    active: 'settings',
    scheduleHours: getSetting('schedule_hours', '0'),
    retentionHours: getSetting('retention_hours', '0'),
    backupTarget: getSetting('backup_target', 'both'),
  });
});

router.post('/settings', requirePerm('manage_settings'), (req, res) => {
  const valid = ['0', '1', '24', '168', '360', '720'];
  setSetting('schedule_hours', valid.includes(req.body.schedule_hours) ? req.body.schedule_hours : '0');
  setSetting('retention_hours', valid.includes(req.body.retention_hours) ? req.body.retention_hours : '0');
  setSetting('backup_target', ['both', 'nodes', 'panel'].includes(req.body.backup_target) ? req.body.backup_target : 'both');
  setSetting('last_auto_run', Date.now()); // el contador empieza desde ahora
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
