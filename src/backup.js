// src/backup.js - El corazón del sistema (versión 2):
// - Copias por NODO agrupadas en "fechas de copia" (snapshots)
// - Copias de la BD de VARIOS paneles, guardadas por separado
// - Excluye node_modules, package-lock.json, .npm, .cache, .git, tmp y logs
//   de los .zip (pesan mucho y no aportan a una copia de seguridad)
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
const PAYMENTER_DIR = path.join(BACKUP_DIR, 'paymenter');
const PAYMENTER_ENV_DIR = path.join(PAYMENTER_DIR, 'env'); // copias sueltas del .env de Paymenter
[SERVER_DIR, PANEL_DIR, ENV_DIR, PAYMENTER_DIR, PAYMENTER_ENV_DIR].forEach((d) => fs.mkdirSync(d, { recursive: true }));

const VOLUMES_PATH = '/var/lib/pterodactyl/volumes';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Lo que NUNCA entra en los .zip: se regenera solo y pesa muchísimo
const ZIP_EXCLUDES = [
  '-x "node_modules/*"', '-x "*/node_modules/*"',
  '-x "package-lock.json"', '-x "*/package-lock.json"',
  '-x ".npm/*"', '-x "*/.npm/*"', '-x ".npm"',
  '-x ".cache/*"', '-x "*/.cache/*"',
  '-x ".git/*"', '-x "*/.git/*"',
  '-x "tmp/*"', '-x "*/tmp/*"',
  '-x "*.log"'
].join(' ')

// zip comprime desde "." asi que las rutas internas empiezan con "./".
// Duplicamos cada patron con ese prefijo para que las exclusiones apliquen
// tanto en la raiz como en subcarpetas (asi .npm, .git, etc. se excluyen bien).
const ZIP_EXCLUDES_DOT = [
  '-x "./node_modules/*"',
  '-x "./package-lock.json"',
  '-x "./.npm/*"',
  '-x "./.cache/*"',
  '-x "./.git/*"',
  '-x "./tmp/*"'
].join(' ')

const ZIP_EXCLUDE_ALL = `${ZIP_EXCLUDES} ${ZIP_EXCLUDES_DOT}`;

// ---------------------------------------------------------------------------
// Estado de la tarea actual (se emite en tiempo real por Socket.IO)
// ---------------------------------------------------------------------------
const job = { active: false, name: null, message: '', current: 0, total: 0, cancelRequested: false, target_uuid: null };

function setJob(patch) {
  Object.assign(job, patch);
  bus.emit('progress', job);
}

// Pide cancelar la tarea en curso (se detiene al terminar el servidor actual)
function requestCancel() {
  if (!job.active) return false;
  job.cancelRequested = true;
  setJob({ message: 'Canceling... it will stop after the current server finishes.' });
  logger.warn('Task cancellation requested by an administrator.');
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
    .slice(0, 60) || 'unnamed';
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

function getPaymenters() {
  return db.prepare('SELECT * FROM paymenters ORDER BY id').all();
}

function getPaymenter(id) {
  return db.prepare('SELECT * FROM paymenters WHERE id = ?').get(id) || null;
}

function backupFilePath(b) {
  if (b.type === 'panel_db') return path.join(PANEL_DIR, b.filename);
  if (b.type === 'paymenter_db') return path.join(PAYMENTER_DIR, b.filename);
  return path.join(SERVER_DIR, b.filename);
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
      logger.warn(`Node "${node.name}": no servers found in ${VOLUMES_PATH}.`);
      return;
    }

    const snap = db.prepare("INSERT INTO snapshots (node_id, status) VALUES (?, 'running')").run(node.id);
    const snapshotId = snap.lastInsertRowid;
    setJob({ total: job.total + uuids.length });
    logger.info(`Node "${node.name}": ${uuids.length} servers found. Creating backup date...`);

    let i = 0;
    let saved = 0;
    for (const uuid of uuids) {
      if (job.cancelRequested) break;
      i++;
      const m = meta[uuid] || { server_name: uuid, owner_name: 'Unknown', owner_email: 'unknown' };
      setJob({ message: `Node ${node.name}: backing up "${m.server_name}" (${i}/${uuids.length})` });
      try {
        const remoteZip = `/tmp/pb_${uuid}_${Date.now()}.zip`;
        const vol = `${VOLUMES_PATH}/${uuid}`;
        const result = await exec(
          conn,
          `cd ${sq(vol)} && (zip -ryq ${sq(remoteZip)} . ${ZIP_EXCLUDE_ALL} >/dev/null 2>&1; if [ -f ${sq(remoteZip)} ]; then echo OK; else echo VACIO; fi)`
        );
        if (result.trim() !== 'OK') {
          logger.warn(`Server "${m.server_name}" (${uuid}) is empty, skipping.`);
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
        logger.error(`Error backing up "${m.server_name}" (${uuid}) on node "${node.name}": ${e.message}`);
      }
      setJob({ current: job.current + 1 });
    }

    if (saved === 0) {
      db.prepare('DELETE FROM snapshots WHERE id = ?').run(snapshotId);
      logger.warn(`Node "${node.name}": the backup date ended up empty and was discarded.`);
    } else {
      db.prepare('UPDATE snapshots SET status = ? WHERE id = ?').run(job.cancelRequested ? 'canceled' : 'complete', snapshotId);
      logger.info(`Node "${node.name}": backup date ${job.cancelRequested ? 'CANCELED with' : 'completed with'} ${saved} servers saved.`);
    }
  });
}

// ---------------------------------------------------------------------------
// Copia de la base de datos de UN panel (mysqldump) + su archivo .env
// ---------------------------------------------------------------------------
async function backupPanelDb(p) {
  setJob({ message: `Backing up the database of panel "${p.name}"...` });
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
      logger.warn(`Panel "${p.name}": .env file not found at ${p.env_path}.`);
    }
    await exec(conn, `rm -f ${sq(remoteSql)} ${sq(remoteEnv)} ${sq(remoteZip)}`).catch(() => {});

    const size = fs.statSync(path.join(PANEL_DIR, filename)).size;
    db.prepare(`
      INSERT INTO backups (type, panel_id, server_name, owner_name, owner_email, filename, size)
      VALUES ('panel_db', ?, ?, '—', '—', ?, ?)
    `).run(p.id, `Panel DB: ${p.name}`, filename, size);
    logger.info(`Panel database backup for "${p.name}" created (${filename}).`);
  });
}

// ---------------------------------------------------------------------------
// Copia de la base de datos de UN Paymenter (mysqldump) + su archivo .env
// (misma mecánica que la BD del panel, pero en su propia carpeta y tipo)
// ---------------------------------------------------------------------------
async function backupPaymenterDb(pm) {
  setJob({ message: `Backing up the Paymenter database "${pm.name}"...` });
  const base = `pb_paymenter_${Date.now()}`;
  const remoteSql = `/tmp/${base}.sql`;
  const remoteEnv = `/tmp/${base}.env`;
  const remoteZip = `/tmp/${base}.zip`;
  const dbPass = decrypt(pm.db_password);

  await withConn(panelSsh(pm), async (conn) => {
    await exec(
      conn,
      `mysqldump -h 127.0.0.1 -u ${sq(pm.db_user)} -p${sq(dbPass)} --single-transaction --routines --triggers ${sq(pm.db_name)} > ${sq(remoteSql)}`
    );
    const hasEnv = (await exec(conn, `if cp ${sq(pm.env_path)} ${sq(remoteEnv)} 2>/dev/null; then echo OK; else echo NO; fi`)).trim() === 'OK';
    await exec(conn, `cd /tmp && zip -jq ${sq(remoteZip)} ${sq(remoteSql)} ${hasEnv ? sq(remoteEnv) : ''}`);

    const filename = `paymenter_db__${sanitize(pm.name)}__${stamp()}.zip`;
    await download(conn, remoteZip, path.join(PAYMENTER_DIR, filename));
    if (hasEnv) {
      await download(conn, remoteEnv, path.join(PAYMENTER_ENV_DIR, `env_${sanitize(pm.name)}_${stamp()}.env`)).catch(() => {});
    } else {
      logger.warn(`Paymenter "${pm.name}": .env file not found at ${pm.env_path}.`);
    }
    await exec(conn, `rm -f ${sq(remoteSql)} ${sq(remoteEnv)} ${sq(remoteZip)}`).catch(() => {});

    const size = fs.statSync(path.join(PAYMENTER_DIR, filename)).size;
    db.prepare(`
      INSERT INTO backups (type, paymenter_id, server_name, owner_name, owner_email, filename, size)
      VALUES ('paymenter_db', ?, ?, '—', '—', ?, ?)
    `).run(pm.id, `Paymenter DB: ${pm.name}`, filename, size);
    logger.info(`Paymenter database backup for "${pm.name}" created (${filename}).`);
  });
}

// ---------------------------------------------------------------------------
// Tarea principal: hacer copias (manual o automática)
// target: 'all' | 'both' | 'nodes' | 'panel' | 'paymenter'
// ('both' se mantiene como nodos + BD de paneles; 'all' añade también Paymenter)
// opts.nodeId / opts.panelId / opts.paymenterId opcionales
// ---------------------------------------------------------------------------
async function runBackup(opts = {}) {
  if (job.active) throw new Error('A task is already running. Wait for it to finish or cancel it.');
  const target = opts.target || getSetting('backup_target', 'both');
  setJob({ active: true, name: 'Backup', message: 'Starting...', current: 0, total: 0, cancelRequested: false, target_uuid: null });
  try {
    // 1) Bases de datos de los paneles (cada una por separado)
    if (target === 'panel' || target === 'both' || target === 'all') {
      const panels = opts.panelId ? [getPanel(opts.panelId)].filter(Boolean) : getPanels();
      if (!panels.length) logger.warn('No panels configured to back up their database.');
      setJob({ total: job.total + panels.length });
      for (const p of panels) {
        if (job.cancelRequested) break;
        try {
          await backupPanelDb(p);
        } catch (e) {
          logger.error(`Error backing up the database of panel "${p.name}": ${e.message}`);
        }
        setJob({ current: job.current + 1 });
      }
    }

    // 1b) Bases de datos de Paymenter (cada una por separado). No interfiere
    //     con la lógica del panel ni de los nodos: es un bloque aparte.
    if (target === 'paymenter' || target === 'all') {
      const paymenters = opts.paymenterId ? [getPaymenter(opts.paymenterId)].filter(Boolean) : getPaymenters();
      if (!paymenters.length) logger.warn('No Paymenter installations configured to back up their database.');
      setJob({ total: job.total + paymenters.length });
      for (const pm of paymenters) {
        if (job.cancelRequested) break;
        try {
          await backupPaymenterDb(pm);
        } catch (e) {
          logger.error(`Error backing up the Paymenter database "${pm.name}": ${e.message}`);
        }
        setJob({ current: job.current + 1 });
      }
    }

    // 2) Archivos de los servidores de cada nodo (una fecha de copia por nodo)
    if (target === 'nodes' || target === 'both' || target === 'all') {
      const nodes = opts.nodeId
        ? [db.prepare('SELECT * FROM nodes WHERE id = ?').get(opts.nodeId)].filter(Boolean)
        : db.prepare('SELECT * FROM nodes').all();
      if (!nodes.length) logger.warn('No nodes configured to back up.');

      const metaCache = {}; // panel_id -> meta (para no consultar el mismo panel dos veces)
      for (const node of nodes) {
        if (job.cancelRequested) break;
        let meta = {};
        const panelId = node.panel_id || (getPanels()[0] || {}).id || null;
        if (panelId) {
          if (!(panelId in metaCache)) {
            const p = getPanel(panelId);
            setJob({ message: `Reading users and servers from panel "${p ? p.name : panelId}"...` });
            try {
              metaCache[panelId] = p ? await getPanelMeta(p) : {};
            } catch (e) {
              metaCache[panelId] = {};
              logger.warn(`Could not read the panel database (backups will be named by UUID): ${e.message}`);
            }
          }
          meta = metaCache[panelId];
        } else {
          logger.warn(`Node "${node.name}" has no linked panel: backups will be named by UUID.`);
        }
        try {
          await backupNode(node, meta);
        } catch (e) {
          logger.error(`Error on node "${node.name}": ${e.message}`);
        }
      }
    }

    logger.info(job.cancelRequested ? 'Task CANCELED by the administrator.' : 'Backup task finished.');
  } finally {
    setJob({ active: false, message: 'Finished', current: 0, total: 0, name: null, cancelRequested: false });
  }
}

// ---------------------------------------------------------------------------
// Restaurar la copia de UN servidor a su nodo
// ---------------------------------------------------------------------------
async function restoreServer(backupId, wipe = false) {
  const b = db.prepare("SELECT * FROM backups WHERE id = ? AND type = 'server'").get(backupId);
  if (!b) throw new Error('That backup does not exist.');
  if (job.active) throw new Error('A task is already running. Wait for it to finish.');
  setJob({ active: true, name: 'Restore', message: `Restoring "${b.server_name}"...`, current: 0, total: 1, cancelRequested: false, target_uuid: b.server_uuid });
  try {
    await restoreServerRow(b, wipe);
    setJob({ current: 1 });
  } finally {
    setJob({ active: false, message: 'Finished', current: 0, total: 0, name: null, cancelRequested: false, target_uuid: null });
  }
}

async function restoreServerRow(b, wipe) {
  const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(b.node_id);
  if (!node) throw new Error(`The node of the "${b.server_name}" backup no longer exists in the system.`);
  const localPath = backupFilePath(b);
  if (!fs.existsSync(localPath)) throw new Error(`The file ${b.filename} no longer exists on disk.`);

  await withConn(nodeSsh(node), async (conn) => {
    const vol = `${VOLUMES_PATH}/${b.server_uuid}`;
    const exists = (await exec(conn, `if [ -d ${sq(vol)} ]; then echo OK; else echo NO; fi`)).trim() === 'OK';
    if (!exists) {
      // El volumen no existe. Pasa cuando se borraron servidores y luego se
      // restauró la BD del panel: Wings eliminó la carpeta al borrar el servidor.
      // En vez de fallar, creamos la carpeta y restauramos dentro.
      await exec(conn, `mkdir -p ${sq(vol)}`);
      logger.warn(`The volume for "${b.server_name}" did not exist on the node: it was created again. Restart Wings on that node (systemctl restart wings) so the panel reconnects to the server.`);
    }

    const remoteZip = `/tmp/pb_restore_${Date.now()}.zip`;
    await upload(conn, localPath, remoteZip);
    if (wipe) await exec(conn, `find ${sq(vol)} -mindepth 1 -delete`);
    await exec(conn, `unzip -oq ${sq(remoteZip)} -d ${sq(vol)}`);
    await exec(conn, `chown -R pterodactyl:pterodactyl ${sq(vol)} 2>/dev/null || true; rm -f ${sq(remoteZip)}`).catch(() => {});
  });
  logger.info(`Restored "${b.server_name}" (${b.owner_email}).`);
}

// ---------------------------------------------------------------------------
// Restaurar TODOS los servidores de UNA fecha de copia (solo archivos de
// servidores: la BD del panel NUNCA se toca aquí).
// ---------------------------------------------------------------------------
async function restoreSnapshot(snapshotId, wipe = false) {
  const snap = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(snapshotId);
  if (!snap) throw new Error('That backup date does not exist.');
  const rows = db.prepare("SELECT * FROM backups WHERE snapshot_id = ? AND type = 'server'").all(snapshotId);
  if (!rows.length) throw new Error('This backup date has no saved servers.');
  if (job.active) throw new Error('A task is already running. Wait for it to finish.');

  setJob({ active: true, name: 'Date restore', message: 'Starting...', current: 0, total: rows.length, cancelRequested: false, target_uuid: null });
  try {
    for (const b of rows) {
      if (job.cancelRequested) break;
      setJob({ message: `Restoring "${b.server_name}" (${job.current + 1}/${rows.length})` });
      try {
        await restoreServerRow(b, wipe);
      } catch (e) {
        logger.error(`Could not restore "${b.server_name}": ${e.message}`);
      }
      setJob({ current: job.current + 1 });
    }
    logger.info(job.cancelRequested
      ? 'Date restore CANCELED by the administrator.'
      : `Restore of the ${snap.created_at} date finished (${rows.length} servers).`);
  } finally {
    setJob({ active: false, message: 'Finished', current: 0, total: 0, name: null, cancelRequested: false });
  }
}

// ---------------------------------------------------------------------------
// Restaurar la BD de un panel (al panel de la copia o a otro VPS)
// ---------------------------------------------------------------------------
async function restorePanelDb(backupId, target = null) {
  const b = db.prepare("SELECT * FROM backups WHERE id = ? AND type = 'panel_db'").get(backupId);
  if (!b) throw new Error('That database backup does not exist.');
  const localPath = backupFilePath(b);
  if (!fs.existsSync(localPath)) throw new Error('The .zip file no longer exists on disk.');
  if (job.active) throw new Error('A task is already running. Wait for it to finish.');

  let cfg, dbUser, dbPass, dbName, label;
  if (target && target.host) {
    cfg = { host: target.host, port: target.ssh_port || 22, user: target.ssh_user || 'root', password: target.ssh_password };
    dbUser = target.db_user || 'pterodactyl';
    dbPass = target.db_password;
    dbName = target.db_name || 'panel';
    label = target.host;
  } else {
    const p = (b.panel_id && getPanel(b.panel_id)) || getPanels()[0];
    if (!p) throw new Error('The panel of this backup is no longer configured. Use the "Another VPS" option with its details.');
    cfg = panelSsh(p);
    dbUser = p.db_user;
    dbPass = decrypt(p.db_password);
    dbName = p.db_name;
    label = `${p.name} (${p.host})`;
  }

  setJob({ active: true, name: 'Database restore', message: `Restoring database on ${label}...`, current: 0, total: 1, cancelRequested: false });
  try {
    await withConn(cfg, async (conn) => {
      const dir = `/tmp/pb_dbrestore_${Date.now()}`;
      const remoteZip = `${dir}.zip`;
      await upload(conn, localPath, remoteZip);
      await exec(conn, `mkdir -p ${sq(dir)} && unzip -oq ${sq(remoteZip)} -d ${sq(dir)}`);
      await exec(
        conn,
        `f=$(ls ${sq(dir)}/*.sql 2>/dev/null | head -n1); [ -n "$f" ] || { echo "The zip does not contain a .sql file" >&2; exit 1; }; mysql -h 127.0.0.1 -u ${sq(dbUser)} -p${sq(dbPass)} ${sq(dbName)} < "$f"`
      );
      await exec(conn, `rm -rf ${sq(dir)} ${sq(remoteZip)}`).catch(() => {});
    });
    setJob({ current: 1 });
    logger.info(`Database restored on ${label}. If you had deleted servers, restart Wings on every node (systemctl restart wings) so the panel reconnects to them, then restore their files. The .zip also includes the .env file in case you need to restore it manually.`);
  } finally {
    setJob({ active: false, message: 'Finished', current: 0, total: 0, name: null, cancelRequested: false });
  }
}

// ---------------------------------------------------------------------------
// Restaurar la BD de un Paymenter (al Paymenter de la copia o a otro VPS)
// ---------------------------------------------------------------------------
async function restorePaymenterDb(backupId, target = null) {
  const b = db.prepare("SELECT * FROM backups WHERE id = ? AND type = 'paymenter_db'").get(backupId);
  if (!b) throw new Error('That Paymenter database backup does not exist.');
  const localPath = backupFilePath(b);
  if (!fs.existsSync(localPath)) throw new Error('The .zip file no longer exists on disk.');
  if (job.active) throw new Error('A task is already running. Wait for it to finish.');

  let cfg, dbUser, dbPass, dbName, label;
  if (target && target.host) {
    cfg = { host: target.host, port: target.ssh_port || 22, user: target.ssh_user || 'root', password: target.ssh_password };
    dbUser = target.db_user || 'paymenter';
    dbPass = target.db_password;
    dbName = target.db_name || 'paymenter';
    label = target.host;
  } else {
    const pm = (b.paymenter_id && getPaymenter(b.paymenter_id)) || getPaymenters()[0];
    if (!pm) throw new Error('The Paymenter of this backup is no longer configured. Use the "Another VPS" option with its details.');
    cfg = panelSsh(pm);
    dbUser = pm.db_user;
    dbPass = decrypt(pm.db_password);
    dbName = pm.db_name;
    label = `${pm.name} (${pm.host})`;
  }

  setJob({ active: true, name: 'Paymenter DB restore', message: `Restoring Paymenter database on ${label}...`, current: 0, total: 1, cancelRequested: false });
  try {
    await withConn(cfg, async (conn) => {
      const dir = `/tmp/pb_pmrestore_${Date.now()}`;
      const remoteZip = `${dir}.zip`;
      await upload(conn, localPath, remoteZip);
      await exec(conn, `mkdir -p ${sq(dir)} && unzip -oq ${sq(remoteZip)} -d ${sq(dir)}`);
      await exec(
        conn,
        `f=$(ls ${sq(dir)}/*.sql 2>/dev/null | head -n1); [ -n "$f" ] || { echo "The zip does not contain a .sql file" >&2; exit 1; }; mysql -h 127.0.0.1 -u ${sq(dbUser)} -p${sq(dbPass)} ${sq(dbName)} < "$f"`
      );
      await exec(conn, `rm -rf ${sq(dir)} ${sq(remoteZip)}`).catch(() => {});
    });
    setJob({ current: 1 });
    logger.info(`Paymenter database restored on ${label}. The .zip also includes Paymenter's .env file in case you need to restore it manually (for example to /var/www/paymenter/.env). Remember to clear Paymenter's caches if something looks off: php artisan optimize:clear.`);
  } finally {
    setJob({ active: false, message: 'Finished', current: 0, total: 0, name: null, cancelRequested: false });
  }
}

// ---------------------------------------------------------------------------
// Eliminar copias y fechas de copia
// ---------------------------------------------------------------------------
function deleteBackup(id) {
  const b = db.prepare('SELECT * FROM backups WHERE id = ?').get(id);
  if (!b) throw new Error('That backup does not exist.');
  try { fs.unlinkSync(backupFilePath(b)); } catch (e) { /* el archivo ya no estaba */ }
  db.prepare('DELETE FROM backups WHERE id = ?').run(id);
  // Si era la última copia de su fecha, la fecha vacía se elimina también
  if (b.snapshot_id) {
    const left = db.prepare('SELECT COUNT(*) AS c FROM backups WHERE snapshot_id = ?').get(b.snapshot_id).c;
    if (left === 0) db.prepare('DELETE FROM snapshots WHERE id = ?').run(b.snapshot_id);
  }
  logger.info(`Backup deleted: ${b.filename}`);
}

function deleteSnapshot(id) {
  const snap = db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id);
  if (!snap) throw new Error('That backup date does not exist.');
  const rows = db.prepare('SELECT * FROM backups WHERE snapshot_id = ?').all(id);
  for (const b of rows) {
    try { fs.unlinkSync(backupFilePath(b)); } catch (e) { /* ignorar */ }
  }
  db.prepare('DELETE FROM backups WHERE snapshot_id = ?').run(id);
  db.prepare('DELETE FROM snapshots WHERE id = ?').run(id);
  logger.info(`Backup date ${snap.created_at} deleted (${rows.length} files).`);
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
  if (rows.length) logger.info(`Automatic cleanup: ${rows.length} old backups deleted (older than ${hours} hours).`);
}

module.exports = {
  job,
  BACKUP_DIR,
  backupFilePath,
  getPanels,
  getPanel,
  getPaymenters,
  getPaymenter,
  runBackup,
  requestCancel,
  restoreServer,
  restoreSnapshot,
  restorePanelDb,
  restorePaymenterDb,
  deleteBackup,
  deleteSnapshot,
  cleanupOld,
};
