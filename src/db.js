// src/db.js - Base de datos local del sistema (SQLite)
// Versión 2: soporta varios paneles y agrupa las copias de cada nodo por
// "fechas de copia" (snapshots). Incluye migración automática desde la v1:
// al arrancar, convierte la configuración y las copias antiguas al formato nuevo.
require('dotenv').config();
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'app.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_root INTEGER NOT NULL DEFAULT 0,
  permissions TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS panels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  ssh_port INTEGER NOT NULL DEFAULT 22,
  ssh_user TEXT NOT NULL DEFAULT 'root',
  ssh_password TEXT NOT NULL,
  db_user TEXT NOT NULL DEFAULT 'pterodactyl',
  db_password TEXT NOT NULL,
  db_name TEXT NOT NULL DEFAULT 'panel',
  env_path TEXT NOT NULL DEFAULT '/var/www/pterodactyl/.env',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  ssh_port INTEGER NOT NULL DEFAULT 22,
  ssh_user TEXT NOT NULL DEFAULT 'root',
  ssh_password TEXT NOT NULL,
  panel_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Instalaciones de Paymenter (panel de facturación). Se copia su base de
-- datos (mysqldump) + su archivo .env, igual que con el panel de Pterodactyl.
CREATE TABLE IF NOT EXISTS paymenters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  ssh_port INTEGER NOT NULL DEFAULT 22,
  ssh_user TEXT NOT NULL DEFAULT 'root',
  ssh_password TEXT NOT NULL,
  db_user TEXT NOT NULL DEFAULT 'paymenter',
  db_password TEXT NOT NULL,
  db_name TEXT NOT NULL DEFAULT 'paymenter',
  env_path TEXT NOT NULL DEFAULT '/var/www/paymenter/.env',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Una "fecha de copia" de un nodo: agrupa todos los .zip de los servidores
-- que se copiaron en esa pasada.
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',  -- running | complete | canceled | error
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,              -- 'server' (archivos de un servidor) o 'panel_db'
  node_id INTEGER,
  snapshot_id INTEGER,             -- fecha de copia a la que pertenece (solo 'server')
  panel_id INTEGER,                -- panel al que pertenece (solo 'panel_db')
  server_uuid TEXT,
  server_name TEXT,
  owner_name TEXT,
  owner_email TEXT,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// ---------------------------------------------------------------------------
// MIGRACIONES automáticas para quien viene de la versión 1
// ---------------------------------------------------------------------------
function hasColumn(table, col) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  } catch (e) {
    return false;
  }
}

if (!hasColumn('nodes', 'panel_id')) db.exec('ALTER TABLE nodes ADD COLUMN panel_id INTEGER');
if (!hasColumn('backups', 'snapshot_id')) db.exec('ALTER TABLE backups ADD COLUMN snapshot_id INTEGER');
if (!hasColumn('backups', 'panel_id')) db.exec('ALTER TABLE backups ADD COLUMN panel_id INTEGER');
// v3.7: copias de la BD de Paymenter (tipo 'paymenter_db')
if (!hasColumn('backups', 'paymenter_id')) db.exec('ALTER TABLE backups ADD COLUMN paymenter_id INTEGER');

// 1) La tabla antigua panel_config (un solo panel) pasa a la tabla panels
const legacyTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='panel_config'").get();
if (legacyTable) {
  const legacy = db.prepare('SELECT * FROM panel_config WHERE id = 1').get();
  const panelCount = db.prepare('SELECT COUNT(*) AS c FROM panels').get().c;
  if (legacy && panelCount === 0) {
    const info = db.prepare(`
      INSERT INTO panels (name, host, ssh_port, ssh_user, ssh_password, db_user, db_password, db_name, env_path)
      VALUES ('Panel principal', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(legacy.host, legacy.ssh_port, legacy.ssh_user, legacy.ssh_password, legacy.db_user, legacy.db_password, legacy.db_name, legacy.env_path);
    db.prepare('UPDATE nodes SET panel_id = ? WHERE panel_id IS NULL').run(info.lastInsertRowid);
    db.prepare("UPDATE backups SET panel_id = ? WHERE type = 'panel_db' AND panel_id IS NULL").run(info.lastInsertRowid);
  }
  db.exec('DROP TABLE panel_config');
}

// 2) Las copias de servidores antiguas (sin fecha de copia) se agrupan en
//    snapshots por nodo y minuto en que se hicieron.
const orphanGroups = db.prepare(`
  SELECT node_id, substr(created_at, 1, 16) AS grp, MIN(created_at) AS first
  FROM backups
  WHERE type = 'server' AND snapshot_id IS NULL AND node_id IS NOT NULL
  GROUP BY node_id, grp
`).all();
for (const g of orphanGroups) {
  const info = db.prepare("INSERT INTO snapshots (node_id, status, created_at) VALUES (?, 'complete', ?)").run(g.node_id, g.first);
  db.prepare(`
    UPDATE backups SET snapshot_id = ?
    WHERE type = 'server' AND snapshot_id IS NULL AND node_id = ? AND substr(created_at, 1, 16) = ?
  `).run(info.lastInsertRowid, g.node_id, g.grp);
}

// ---------------------------------------------------------------------------
function getSetting(key, def = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : def;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

// Borra la huella SSH guardada de un host:puerto. Se usa cuando el admin cambia
// la IP de un nodo/panel/Paymenter (o reconstruye el VPS), para que la próxima
// conexión vuelva a confiar en la clave nueva (trust-on-first-use).
function clearHostKey(host, port) {
  db.prepare('DELETE FROM settings WHERE key = ?').run(`hostkey_${host}_${Number(port) || 22}`);
}

module.exports = { db, getSetting, setSetting, clearHostKey };
