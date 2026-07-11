// src/extapi.js - API para la extensión del panel de Pterodactyl.
// El panel se conecta aquí con una clave (Authorization: Bearer <clave>).
// La clave se genera sola al arrancar y se ve en Configuración -> Extensión del panel.
const express = require('express');
const crypto = require('crypto');
const { db, getSetting, setSetting } = require('./db');
const backup = require('./backup');
const logger = require('./logger');
const VERSION = require('../package.json').version;

function ensureKey() {
  let key = getSetting('ext_api_key', '');
  if (!key) {
    key = crypto.randomBytes(24).toString('hex');
    setSetting('ext_api_key', key);
    logger.info('Clave de API para la extensión del panel generada (ver Configuración).');
  }
  return key;
}

function regenerateKey() {
  const key = crypto.randomBytes(24).toString('hex');
  setSetting('ext_api_key', key);
  return key;
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

const router = express.Router();

// Autenticación por clave en TODAS las rutas de la API
router.use((req, res, next) => {
  const key = getSetting('ext_api_key', '');
  const header = req.get('authorization') || '';
  const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (key && given && safeEqual(key, given)) return next();
  res.status(401).json({ ok: false, message: 'Clave de API inválida.' });
});

function scheduleParts() {
  const nodesH = parseInt(getSetting('schedule_hours_nodes', getSetting('schedule_hours', '0')), 10) || 0;
  const panelH = parseInt(getSetting('schedule_hours_panel', getSetting('schedule_hours', '0')), 10) || 0;
  const nodesLast = parseInt(getSetting('last_auto_run_nodes', getSetting('last_auto_run', '0')), 10) || Date.now();
  const panelLast = parseInt(getSetting('last_auto_run_panel', getSetting('last_auto_run', '0')), 10) || Date.now();
  return {
    next_run_nodes: nodesH ? nodesLast + nodesH * 3600 * 1000 : null,
    next_run_panel: panelH ? panelLast + panelH * 3600 * 1000 : null,
  };
}

function nextAutoRun() {
  const p = scheduleParts();
  const times = [p.next_run_nodes, p.next_run_panel].filter(Boolean);
  return times.length ? Math.min(...times) : null;
}

// ---------------------------------------------------------------------------
router.get('/ping', (req, res) => res.json({ ok: true, name: 'PteroBackups', version: VERSION }));

router.get('/overview', (req, res) => {
  const nodes = db.prepare(`
    SELECT n.id, n.name, n.host,
      (SELECT COUNT(*) FROM snapshots s WHERE s.node_id = n.id) AS snaps,
      (SELECT MAX(created_at) FROM snapshots s WHERE s.node_id = n.id) AS last_snap,
      (SELECT COALESCE(SUM(size),0) FROM backups b WHERE b.node_id = n.id AND b.type = 'server') AS total_size
    FROM nodes n ORDER BY n.id
  `).all();
  const panel_backups = db.prepare(`
    SELECT b.id, b.filename, b.size, b.created_at, p.name AS panel_name
    FROM backups b LEFT JOIN panels p ON p.id = b.panel_id
    WHERE b.type = 'panel_db' ORDER BY b.id DESC LIMIT 200
  `).all();
  const stats = {
    backups: db.prepare('SELECT COUNT(*) AS c FROM backups').get().c,
    size: db.prepare('SELECT COALESCE(SUM(size),0) AS s FROM backups').get().s,
  };
  res.json({ ok: true, nodes, panel_backups, stats });
});

router.get('/job', (req, res) => {
  const p = scheduleParts();
  res.json({ ok: true, ...backup.job, next_run: nextAutoRun(), next_run_nodes: p.next_run_nodes, next_run_panel: p.next_run_panel, server_now: Date.now() });
});

router.post('/job/cancel', (req, res) => {
  const ok = backup.requestCancel();
  res.json({ ok, message: ok ? 'Cancelando la tarea...' : 'No hay ninguna tarea en ejecución.' });
});

router.post('/run', (req, res) => {
  if (backup.job.active) return res.json({ ok: false, message: 'Ya hay una tarea en ejecución.' });
  const target = ['both', 'nodes', 'panel', 'node'].includes(req.body.target) ? req.body.target : 'both';
  const opts = target === 'node' ? { target: 'nodes', nodeId: parseInt(req.body.node_id, 10) } : { target };
  logger.info('Copia manual iniciada desde la extensión del panel.');
  backup.runBackup(opts).catch((e) => logger.error(e.message));
  res.json({ ok: true, message: 'Copia iniciada.' });
});

// ---------------------------------------------------------------------------
router.get('/nodes/:id/snapshots', (req, res) => {
  const node = db.prepare('SELECT id, name, host FROM nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.json({ ok: false, message: 'El nodo no existe.' });
  const snapshots = db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM backups b WHERE b.snapshot_id = s.id) AS cnt,
      (SELECT COALESCE(SUM(size),0) FROM backups b WHERE b.snapshot_id = s.id) AS total_size
    FROM snapshots s WHERE s.node_id = ? ORDER BY s.id DESC
  `).all(node.id);
  res.json({ ok: true, node, snapshots });
});

router.get('/snapshots/:id', (req, res) => {
  const snapshot = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(req.params.id);
  if (!snapshot) return res.json({ ok: false, message: 'La fecha de copia no existe.' });
  const node = db.prepare('SELECT id, name FROM nodes WHERE id = ?').get(snapshot.node_id) || null;
  const rows = db.prepare(`
    SELECT id, server_uuid, server_name, owner_name, owner_email, filename, size, created_at
    FROM backups WHERE snapshot_id = ? AND type = 'server' ORDER BY owner_name, server_name
  `).all(snapshot.id);
  res.json({ ok: true, snapshot, node, rows });
});

router.post('/snapshots/:id/restore', (req, res) => {
  if (backup.job.active) return res.json({ ok: false, message: 'Ya hay una tarea en ejecución.' });
  const snap = db.prepare('SELECT id FROM snapshots WHERE id = ?').get(req.params.id);
  if (!snap) return res.json({ ok: false, message: 'La fecha de copia no existe.' });
  logger.info('Restauración de fecha completa iniciada desde la extensión del panel.');
  backup.restoreSnapshot(snap.id, !!req.body.wipe).catch((e) => logger.error(e.message));
  res.json({ ok: true, message: 'Restauración de la fecha iniciada.' });
});

router.post('/snapshots/:id/delete', (req, res) => {
  try {
    backup.deleteSnapshot(parseInt(req.params.id, 10));
    res.json({ ok: true, message: 'Fecha de copia eliminada.' });
  } catch (e) {
    res.json({ ok: false, message: e.message });
  }
});

// ---------------------------------------------------------------------------
// Copias de UN servidor (para la página del usuario en el panel)
router.get('/server/:uuid/backups', (req, res) => {
  const rows = db.prepare(`
    SELECT b.id, b.server_name, b.filename, b.size, b.created_at, s.created_at AS snapshot_date
    FROM backups b LEFT JOIN snapshots s ON s.id = b.snapshot_id
    WHERE b.type = 'server' AND b.server_uuid = ?
    ORDER BY b.id DESC LIMIT 100
  `).all(req.params.uuid);
  res.json({ ok: true, rows });
});

router.get('/backups/:id', (req, res) => {
  const row = db.prepare('SELECT id, type, server_uuid, server_name, owner_name, owner_email, filename, size, created_at FROM backups WHERE id = ?').get(req.params.id);
  if (!row) return res.json({ ok: false, message: 'La copia no existe.' });
  res.json({ ok: true, backup: row });
});

router.get('/backups/:id/download', (req, res) => {
  const row = db.prepare('SELECT * FROM backups WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ ok: false, message: 'La copia no existe.' });
  res.download(backup.backupFilePath(row), row.filename, (err) => {
    if (err && !res.headersSent) res.status(404).json({ ok: false, message: 'El archivo ya no existe.' });
  });
});

router.post('/backups/:id/restore', (req, res) => {
  if (backup.job.active) return res.json({ ok: false, message: 'Ya hay una tarea en ejecución. Inténtalo en un momento.' });
  const row = db.prepare("SELECT * FROM backups WHERE id = ? AND type = 'server'").get(req.params.id);
  if (!row) return res.json({ ok: false, message: 'La copia no existe.' });
  // Seguridad: si el panel manda expected_uuid (página del usuario), la copia
  // DEBE pertenecer a ese servidor.
  if (req.body.expected_uuid && row.server_uuid !== String(req.body.expected_uuid)) {
    return res.status(403).json({ ok: false, message: 'Esta copia no pertenece a ese servidor.' });
  }
  logger.info(`Restauración de "${row.server_name}" iniciada desde la extensión del panel.`);
  backup.restoreServer(row.id, !!req.body.wipe).catch((e) => logger.error(e.message));
  res.json({ ok: true, message: 'Restauración iniciada.' });
});

router.post('/backups/:id/delete', (req, res) => {
  try {
    backup.deleteBackup(req.params.id);
    res.json({ ok: true, message: 'Copia eliminada.' });
  } catch (e) {
    res.json({ ok: false, message: e.message });
  }
});

// ---------------------------------------------------------------------------
// Programación (para que los admins la cambien desde el panel)
router.get('/schedule', (req, res) => {
  res.json({
    ok: true,
    schedule_hours_nodes: getSetting('schedule_hours_nodes', getSetting('schedule_hours', '0')),
    schedule_hours_panel: getSetting('schedule_hours_panel', getSetting('schedule_hours', '0')),
    retention_hours: getSetting('retention_hours', '0'),
  });
});

router.post('/schedule', (req, res) => {
  const valid = ['0', '1', '24', '168', '360', '720'];
  const prevNodes = getSetting('schedule_hours_nodes', getSetting('schedule_hours', '0'));
  const prevPanel = getSetting('schedule_hours_panel', getSetting('schedule_hours', '0'));
  const newNodes = valid.includes(String(req.body.schedule_hours_nodes)) ? String(req.body.schedule_hours_nodes) : '0';
  const newPanel = valid.includes(String(req.body.schedule_hours_panel)) ? String(req.body.schedule_hours_panel) : '0';
  setSetting('schedule_hours_nodes', newNodes);
  setSetting('schedule_hours_panel', newPanel);
  setSetting('retention_hours', valid.includes(String(req.body.retention_hours)) ? String(req.body.retention_hours) : '0');
  const now = String(Date.now());
  if (newNodes !== prevNodes) setSetting('last_auto_run_nodes', now);
  if (newPanel !== prevPanel) setSetting('last_auto_run_panel', now);
  logger.info('Programación actualizada desde la extensión del panel.');
  res.json({ ok: true, message: 'Configuración guardada.' });
});

module.exports = { router, ensureKey, regenerateKey };
