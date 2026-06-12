// src/backup.js - El corazón del sistema (versión 2):
// - Copias por NODO agrupadas en "fechas de copia" (snapshots)
// - Copias de la BD de VARIOS paneles, guardadas por separado
// - Excluye node_modules y package-lock.json de los .zip (pesan mucho)
// - Cancelación de la tarea en curso
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { db, getSetting } = require('./db');
const { sq, exec, download, upload, withConn } = require('./ssh');
const { decrypt } = require('./cipher');
const logger = require('./logger');
const bus = require('./bus');

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', 'storage', 'backups');
const SERVER_DIR = path.join(BACKUP_DIR, 'servers');
const PANEL_DIR = path.join(BACKUP_DIR, 'panel');
const ENV_DIR = path.join(PANEL_DIR, 'env'); // copias sueltas del archivo .env de cada panel
[SERVER_DIR, PANEL_DIR, ENV_DIR].forEach((d) => fs.mkdirSync(d, { recursive: true }));

const VOLUMES_PATH = '/var/lib/pterodactyl/volumes';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Lo que NUNCA entra en los .zip: se regenera solo y pesa muchísimo
const ZIP_EXCLUDES = '-x "node_modules/*" -x "*/node_modules/*" -x "package-lock.json" -x "*/package-lock.json"';

// ---------------------------------------------------------------------------
// Estado de la tarea actual (se emite en tiempo real por Socket.IO)
// ---------------------------------------------------------------------------
const job = { active: false, name: null, message: '', current: 0, total: 0, cancelRequested: false };

function setJob(patch) {
  Object.assign(job, patch);
  bus.emit('progress', job);
}

// Pide cancelar la tarea en curso (se detiene al terminar el servidor actual)
function requestCancel() {
  if (!job.active) return false;
  job.cancelRequested = true;
  setJob({ message: 'Cancelando... se detendrá al terminar el servidor actual.' });
  logger.warn('Cancelación de la tarea solicitada por un administrador.');
  return true;
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
function sanitize(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9.@-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 60) || 'sin_nombre';
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function nodeSsh(node) {
  return { host: node.host, port: node.ssh_port, user: node.ssh_user, password: decrypt(node.ssh_password) };
}

function panelSsh(p) {
  return { host: p.host, port: p.ssh_port, user: p.ssh_user, password: decrypt(p.ssh_password) };
}

function getPanels() {
  return db.prepare('SELECT * FROM panels ORDER BY id').all();
}

function getPanel(id) {
  return db.prepare('SELECT * FROM panels WHERE id = ?').get(id) || null;
}

function backupFilePath(b) {
  return path.join(b.type === 'panel_db' ? PANEL_DIR : SERVER_DIR, b.filename);
}

// ---------------------------------------------------------------------------
// Lee la BD de UN panel: uuid -> { nombre servidor, dueño, correo }
// ---------------------------------------------------------------------------
async function getPanelMeta(p) {
  const query =
    "SELECT s.uuid, REPLACE(REPLACE(s.name,'\\t',' '),'\\n',' '), u.name_first, u.name_last, u.email " +
    'FROM servers s JOIN users u ON u.id = s.owner_id';
  const cmd = `mysql -N -B -h 127.0.0.1 -u ${sq(p.db_user)} -p${sq(decrypt(p.db_password))} ${sq(p.db_name)} -e ${sq(query)}`;
  const out = await withConn(panelSsh(p), (conn) => exec(conn, cmd));
  const meta = {};
  out.split('\n').filter(Boolean).forEach((line) => {
    const [uuid, name, first, last, email] = line.split('\t');
    if (uuid) meta[uuid.trim()] = {
      server_name: (name || uuid).trim(),
      owner_name: `${first || ''} ${last || ''}`.trim() || 'Desconocido',
      owner_email: (email || 'desconocido').trim(),
    };
  });
  return meta;
}

// ---------------------------------------------------------------------------
// Copia de TODOS los servidores de un nodo -> crea una "fecha de copia"
// ---------------------------------------------------------------------------
async function backupNode(node, meta) {
  await withConn(nodeSsh(node), async (conn) => {
    const list = await exec(conn, `ls -1 ${VOLUMES_PATH} 2>/dev/null || true`);
    const uuids = list.split('\n').map((s) => s.trim()).filter((s) => UUID_RE.test(s));
    if (!uuids.length) {
      logger.warn(`Nodo "${node.name}": no se encontraron servidores en ${VOLUMES_PATH}.`);
      return;
    }

    const snap = db.prepare("INSERT INTO snapshots (node_id, status) VALUES (?, 'running')").run(node.id);
    const snapshotId = snap.lastInsertRowid;
    setJob({ total: job.total + uuids.length });
    logger.info(`Nodo "${node.name}": ${uuids.length} servidores encontrados. Creando fecha de copia...`);

    let i = 0;
    let saved = 0;
    for (const uuid of uuids) {
      if (job.cancelRequested) break;
      i++;
      const m = meta[uuid] || { server_name: uuid, owner_name: 'Desconocido', owner_email: 'desconocido' };
      setJob({ message: `Nodo ${node.name}: copiando "${m.server_name}" (${i}/${uuids.length})` });
      try {
        const remoteZip = `/tmp/pb_${uuid}_${Date.now()}.zip`;
        const vol = `${VOLUMES_PATH}/${uuid}`;
        const result = await exec(
          conn,
          `cd ${sq(vol)} && (zip -ryq ${sq(remoteZip)} . ${ZIP_EXCLUDES} >/dev/null 2>&1; if [ -f ${sq(remoteZip)} ]; then echo OK; else echo VACIO; fi)`
        );
        if (result.trim() !== 'OK') {
          logger.warn(`Servidor "${m.server_name}" (${uuid}) está vacío, se omite.`);
          setJob({ current: job.current + 1 });
          continue;
        }
        const filename = `${sanitize(m.owner_name)}__${sanitize(m.owner_email)}__${sanitize(m.server_name)}__${uuid}__${stamp()}.zip`;
        const localPath = path.join(SERVER_DIR, filename);
        await download(conn, remoteZip, localPath);
        await exec(conn, `rm -f ${sq(remoteZip)}`).catch(() => {});
        const size = fs.statSync(localPath).size;
        db.prepare(`
          INSERT INTO backups (type, node_id, snapshot_id, server_uuid, server_name, owner_name, owner_email, filename, size)
          VALUES ('server', ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(node.id, snapshotId, uuid, m.server_name, m.owner_name, m.owner_email, filename, size);
        saved++;
      } catch (e) {
        logger.error(`Error copiando "${m.server_name}" (${uuid}) en nodo "${node.name}": ${e.message}`);
      }
      setJob({ current: job.current + 1 });
    }

    if (saved === 0) {
      db.prepare('DELETE FROM snapshots WHERE id = ?').run(snapshotId);
      logger.warn(`Nodo "${node.name}": la fecha de copia quedó vacía y se descartó.`);
    } else {
      db.prepare('UPDATE snapshots SET status = ? WHERE id = ?').run(job.cancelRequested ? 'canceled' : 'complete', snapshotId);
      logger.info(`Nodo "${node.name}": fecha de copia ${job.cancelRequested ? 'CANCELADA con' : 'completada con'} ${saved} servidores guardados.`);
    }
  });
}

// ---------------------------------------------------------------------------
// Copia de la base de datos de UN panel (mysqldump) + su archivo .env
// ---------------------------------------------------------------------------
async function backupPanelDb(p) {
  setJob({ message: `Copiando la base de datos del panel "${p.name}"...` });
  const base = `pb_panel_${Date.now()}`;
  const remoteSql = `/tmp/${base}.sql`;
  const remoteEnv = `/tmp/${base}.env`;
  const remoteZip = `/tmp/${base}.zip`;
  const dbPass = decrypt(p.db_password);

  await withConn(panelSsh(p), async (conn) => {
    await exec(
      conn,
      `mysqldump -h 127.0.0.1 -u ${sq(p.db_user)} -p${sq(dbPass)} --single-transaction --routines --triggers ${sq(p.db_name)} > ${sq(remoteSql)}`
    );
    const hasEnv = (await exec(conn, `if cp ${sq(p.env_path)} ${sq(remoteEnv)} 2>/dev/null; then echo OK; else echo NO; fi`)).trim() === 'OK';
    await exec(conn, `cd /tmp && zip -jq ${sq(remoteZip)} ${sq(remoteSql)} ${hasEnv ? sq(remoteEnv) : ''}`);

    const filename = `panel_db__${sanitize(p.name)}__${stamp()}.zip`;
    await download(conn, remoteZip, path.join(PANEL_DIR, filename));
    if (hasEnv) {
      await download(conn, remoteEnv, path.join(ENV_DIR, `env_${sanitize(p.name)}_${stamp()}.env`)).catch(() => {});
    } else {
      logger.warn(`Panel "${p.name}": no se encontró el archivo .env en ${p.env_path}.`);
    }
    await exec(conn, `rm -f ${sq(remoteSql)} ${sq(remoteEnv)} ${sq(remoteZip)}`).catch(() => {});

    const size = fs.statSync(path.join(PANEL_DIR, filename)).size;
    db.prepare(`
      INSERT INTO backups (type, panel_id, server_name, owner_name, owner_email, filename, size)
      VALUES ('panel_db', ?, ?, '—', '—', ?, ?)
    `).run(p.id, `BD del panel: ${p.name}`, filename, size);
    logger.info(`Copia de la BD del panel "${p.name}" creada (${filename}).`);
  });
}

// ---------------------------------------------------------------------------
// Tarea principal: hacer copias (manual o automática)
// target: 'both' | 'nodes' | 'panel'  — opts.nodeId / opts.panelId opcionales
// ---------------------------------------------------------------------------
async function runBackup(opts = {}) {
  if (job.active) throw new Error('Ya hay una tarea en ejecución. Espera a que termine o cancélala.');
  const target = opts.target || getSetting('backup_target', 'both');
  setJob({ active: true, name: 'Copia de seguridad', message: 'Iniciando...', current: 0, total: 0, cancelRequested: false });
  try {
    // 1) Bases de datos de los paneles (cada una por separado)
    if (target === 'panel' || target === 'both') {
      const panels = opts.panelId ? [getPanel(opts.panelId)].filter(Boolean) : getPanels();
      if (!panels.length) logger.warn('No hay paneles configurados para copiar su base de datos.');
      setJob({ total: job.total + panels.length });
      for (const p of panels) {
        if (job.cancelRequested) break;
        try {
          await backupPanelDb(p);
        } catch (e) {
          logger.error(`Error en la copia de la BD del panel "${p.name}": ${e.message}`);
        }
        setJob({ current: job.current + 1 });
      }
    }

    // 2) Archivos de los servidores de cada nodo (una fecha de copia por nodo)
    if (target === 'nodes' || target === 'both') {
      const nodes = opts.nodeId
        ? [db.prepare('SELECT * FROM nodes WHERE id = ?').get(opts.nodeId)].filter(Boolean)
        : db.prepare('SELECT * FROM nodes').all();
      if (!nodes.length) logger.warn('No hay nodos configurados para copiar.');

      const metaCache = {}; // panel_id -> meta (para no consultar el mismo panel dos veces)
      for (const node of nodes) {
        if (job.cancelRequested) break;
        let meta = {};
        const panelId = node.panel_id || (getPanels()[0] || {}).id || null;
        if (panelId) {
          if (!(panelId in metaCache)) {
            const p = getPanel(panelId);
            setJob({ message: `Leyendo usuarios y servidores del panel "${p ? p.name : panelId}"...` });
            try {
              metaCache[panelId] = p ? await getPanelMeta(p) : {};
            } catch (e) {
              metaCache[panelId] = {};
              logger.warn(`No se pudo leer la BD del panel (las copias se nombrarán con el UUID): ${e.message}`);
            }
          }
          meta = metaCache[panelId];
        } else {
          logger.warn(`El nodo "${node.name}" no tiene panel asociado: las copias se nombrarán con el UUID.`);
        }
        try {
          await backupNode(node, meta);
        } catch (e) {
          logger.error(`Error en el nodo "${node.name}": ${e.message}`);
        }
      }
    }

    logger.info(job.cancelRequested ? 'Tarea CANCELADA por el administrador.' : 'Tarea de copias finalizada.');
  } finally {
    setJob({ active: false, message: 'Finalizado', current: 0, total: 0, name: null, cancelRequested: false });
  }
}

// ---------------------------------------------------------------------------
// Restaurar la copia de UN servidor a su nodo
// ---------------------------------------------------------------------------
async function restoreServer(backupId, wipe = false) {
  const b = db.prepare("SELECT * FROM backups WHERE id = ? AND type = 'server'").get(backupId);
  if (!b) throw new Error('La copia no existe.');
  if (job.active) throw new Error('Ya hay una tarea en ejecución. Espera a que termine.');
  setJob({ active: true, name: 'Restauración', message: `Restaurando "${b.server_name}"...`, current: 0, total: 1, cancelRequested: false });
  try {
    await restoreServerRow(b, wipe);
    setJob({ current: 1 });
  } finally {
    setJob({ active: false, message: 'Finalizado', current: 0, total: 0, name: null, cancelRequested: false });
  }
}

async function restoreServerRow(b, wipe) {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(b.node_id);
  if (!node) throw new Error(`El nodo de la copia "${b.server_name}" ya no existe en el sistema.`);
  const localPath = backupFilePath(b);
  if (!fs.existsSync(localPath)) throw new Error(`El archivo ${b.filename} ya no existe en el disco.`);

  await withConn(nodeSsh(node), async (conn) => {
    const vol = `${VOLUMES_PATH}/${b.server_uuid}`;
    const exists = (await exec(conn, `if [ -d ${sq(vol)} ]; then echo OK; else echo NO; fi`)).trim() === 'OK';
    if (!exists) {
      // El volumen no existe. Pasa cuando se borraron servidores y luego se
      // restauró la BD del panel: Wings eliminó la carpeta al borrar el servidor.
      // En vez de fallar, creamos la carpeta y restauramos dentro.
      await exec(conn, `mkdir -p ${sq(vol)}`);
      logger.warn(`El volumen de "${b.server_name}" no existía en el nodo: se creó de nuevo. Reinicia Wings en ese nodo (systemctl restart wings) para que el panel vuelva a conectar con el servidor.`);
    }

    const remoteZip = `/tmp/pb_restore_${Date.now()}.zip`;
    await upload(conn, localPath, remoteZip);
    if (wipe) await exec(conn, `find ${sq(vol)} -mindepth 1 -delete`);
    await exec(conn, `unzip -oq ${sq(remoteZip)} -d ${sq(vol)}`);
    await exec(conn, `chown -R pterodactyl:pterodactyl ${sq(vol)} 2>/dev/null || true; rm -f ${sq(remoteZip)}`).catch(() => {});
  });
  logger.info(`Restaurado "${b.server_name}" (${b.owner_email}).`);
}

// ---------------------------------------------------------------------------
// Restaurar TODOS los servidores de UNA fecha de copia (solo archivos de
// servidores: la BD del panel NUNCA se toca aquí).
// ---------------------------------------------------------------------------
async function restoreSnapshot(snapshotId, wipe = false) {
  const snap = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(snapshotId);
  if (!snap) throw new Error('La fecha de copia no existe.');
  const rows = db.prepare("SELECT * FROM backups WHERE snapshot_id = ? AND type = 'server'").all(snapshotId);
  if (!rows.length) throw new Error('Esta fecha de copia no tiene servidores guardados.');
  if (job.active) throw new Error('Ya hay una tarea en ejecución. Espera a que termine.');

  setJob({ active: true, name: 'Restauración de fecha', message: 'Iniciando...', current: 0, total: rows.length, cancelRequested: false });
  try {
    for (const b of rows) {
      if (job.cancelRequested) break;
      setJob({ message: `Restaurando "${b.server_name}" (${job.current + 1}/${rows.length})` });
      try {
        await restoreServerRow(b, wipe);
      } catch (e) {
        logger.error(`No se pudo restaurar "${b.server_name}": ${e.message}`);
      }
      setJob({ current: job.current + 1 });
    }
    logger.info(job.cancelRequested
      ? 'Restauración de la fecha CANCELADA por el administrador.'
      : `Restauración de la fecha ${snap.created_at} finalizada (${rows.length} servidores).`);
  } finally {
    setJob({ active: false, message: 'Finalizado', current: 0, total: 0, name: null, cancelRequested: false });
  }
}

// ---------------------------------------------------------------------------
// Restaurar la BD de un panel (al panel de la copia o a otro VPS)
// ---------------------------------------------------------------------------
async function restorePanelDb(backupId, target = null) {
  const b = db.prepare("SELECT * FROM backups WHERE id = ? AND type = 'panel_db'").get(backupId);
  if (!b) throw new Error('La copia de la base de datos no existe.');
  const localPath = backupFilePath(b);
  if (!fs.existsSync(localPath)) throw new Error('El archivo .zip ya no existe en el disco.');
  if (job.active) throw new Error('Ya hay una tarea en ejecución. Espera a que termine.');

  let cfg, dbUser, dbPass, dbName, label;
  if (target && target.host) {
    cfg = { host: target.host, port: target.ssh_port || 22, user: target.ssh_user || 'root', password: target.ssh_password };
    dbUser = target.db_user || 'pterodactyl';
    dbPass = target.db_password;
    dbName = target.db_name || 'panel';
    label = target.host;
  } else {
    const p = (b.panel_id && getPanel(b.panel_id)) || getPanels()[0];
    if (!p) throw new Error('El panel de esta copia ya no está configurado. Usa la opción "Otro VPS" con sus datos.');
    cfg = panelSsh(p);
    dbUser = p.db_user;
    dbPass = decrypt(p.db_password);
    dbName = p.db_name;
    label = `${p.name} (${p.host})`;
  }

  setJob({ active: true, name: 'Restauración de BD', message: `Restaurando BD en ${label}...`, current: 0, total: 1, cancelRequested: false });
  try {
    await withConn(cfg, async (conn) => {
      const dir = `/tmp/pb_dbrestore_${Date.now()}`;
      const remoteZip = `${dir}.zip`;
      await upload(conn, localPath, remoteZip);
      await exec(conn, `mkdir -p ${sq(dir)} && unzip -oq ${sq(remoteZip)} -d ${sq(dir)}`);
      await exec(
        conn,
        `f=$(ls ${sq(dir)}/*.sql 2>/dev/null | head -n1); [ -n "$f" ] || { echo "El zip no contiene un .sql" >&2; exit 1; }; mysql -h 127.0.0.1 -u ${sq(dbUser)} -p${sq(dbPass)} ${sq(dbName)} < "$f"`
      );
      await exec(conn, `rm -rf ${sq(dir)} ${sq(remoteZip)}`).catch(() => {});
    });
    setJob({ current: 1 });
    logger.info(`Base de datos restaurada en ${label}. Si habías borrado servidores, reinicia Wings en cada nodo (systemctl restart wings) para que el panel reconecte con ellos, y después restaura sus archivos. El .zip también incluye el archivo .env por si necesitas restaurarlo a mano.`);
  } finally {
    setJob({ active: false, message: 'Finalizado', current: 0, total: 0, name: null, cancelRequested: false });
  }
}

// ---------------------------------------------------------------------------
// Eliminar copias y fechas de copia
// ---------------------------------------------------------------------------
function deleteBackup(id) {
  const b = db.prepare('SELECT * FROM backups WHERE id = ?').get(id);
  if (!b) throw new Error('La copia no existe.');
  try { fs.unlinkSync(backupFilePath(b)); } catch (e) { /* el archivo ya no estaba */ }
  db.prepare('DELETE FROM backups WHERE id = ?').run(id);
  // Si era la última copia de su fecha, la fecha vacía se elimina también
  if (b.snapshot_id) {
    const left = db.prepare('SELECT COUNT(*) AS c FROM backups WHERE snapshot_id = ?').get(b.snapshot_id).c;
    if (left === 0) db.prepare('DELETE FROM snapshots WHERE id = ?').run(b.snapshot_id);
  }
  logger.info(`Copia eliminada: ${b.filename}`);
}

function deleteSnapshot(id) {
  const snap = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id);
  if (!snap) throw new Error('La fecha de copia no existe.');
  const rows = db.prepare('SELECT * FROM backups WHERE snapshot_id = ?').all(id);
  for (const b of rows) {
    try { fs.unlinkSync(backupFilePath(b)); } catch (e) { /* ignorar */ }
  }
  db.prepare('DELETE FROM backups WHERE snapshot_id = ?').run(id);
  db.prepare('DELETE FROM snapshots WHERE id = ?').run(id);
  logger.info(`Fecha de copia ${snap.created_at} eliminada (${rows.length} archivos).`);
}

// Limpieza automática de copias antiguas según la retención configurada
function cleanupOld() {
  const hours = parseInt(getSetting('retention_hours', '0'), 10);
  if (!hours) return;
  const rows = db.prepare("SELECT * FROM backups WHERE created_at < datetime('now', 'localtime', ?)").all(`-${hours} hours`);
  for (const b of rows) {
    try { fs.unlinkSync(backupFilePath(b)); } catch (e) { /* ignorar */ }
    db.prepare('DELETE FROM backups WHERE id = ?').run(b.id);
  }
  // Borra las fechas de copia que quedaron vacías (solo si no hay tarea en curso)
  if (!job.active) {
    db.prepare('DELETE FROM snapshots WHERE id NOT IN (SELECT snapshot_id FROM backups WHERE snapshot_id IS NOT NULL)').run();
  }
  if (rows.length) logger.info(`Limpieza automática: ${rows.length} copias antiguas eliminadas (más de ${hours} horas).`);
}

module.exports = {
  job,
  BACKUP_DIR,
  backupFilePath,
  getPanels,
  getPanel,
  runBackup,
  requestCancel,
  restoreServer,
  restoreSnapshot,
  restorePanelDb,
  deleteBackup,
  deleteSnapshot,
  cleanupOld,
};
