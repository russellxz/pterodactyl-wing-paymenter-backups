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

// ---------------------------------------------------------------------------
// Paymenter: qué se copia además de la base de datos
// ---------------------------------------------------------------------------
// Paymenter es una aplicación Laravel. Al reinstalarla (o al clonarla en un
// VPS nuevo) vuelve todo el código, pero NO vuelve nada de esto:
//
//   storage/app  -> archivos subidos desde el panel: logo, favicon, imágenes
//                   de productos, facturas... (el "disco public" de Laravel
//                   es storage/app/public, que se publica con storage:link)
//   extensions   -> las extensiones instaladas (pasarelas de pago, módulos
//                   de servidores, etc.). Son carpetas extensions/<Tipo>/<Nombre>
//                   y están en el .gitignore de Paymenter: si no se copian,
//                   se pierden al migrar.
//   themes       -> los temas propios (el .gitignore solo conserva "default")
//
// Las TABLAS que crean esas extensiones no hay que detectarlas a mano: el
// mysqldump de la base de datos vuelca todas las tablas que existan, sean de
// Paymenter o de una extensión. Aun así las inventariamos para dejar
// constancia en el manifiesto de la copia.
const PAYMENTER_DATA_DIRS = ['storage/app', 'extensions', 'themes'];

// Claves sueltas de storage/ (APP_KEY va en el .env, pero Passport/OAuth
// guarda sus claves como storage/oauth-*.key y también están en el .gitignore).
const PAYMENTER_KEY_GLOB = 'storage/*.key';

// Lo que nunca entra aunque esté dentro de esas carpetas.
const PAYMENTER_EXCLUDES = [
  '-x "*/node_modules/*"', '-x "*/vendor/*"',
  '-x "*.log"', '-x "*/.git/*"',
  '-x "storage/app/livewire-tmp/*"', // subidas a medias de Livewire
].join(' ');

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
  const cmd = `MYSQL_PWD=${sq(decrypt(p.db_password))} mysql -N -B -h 127.0.0.1 -u ${sq(p.db_user)} ${sq(p.db_name)} -e ${sq(query)}`;
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
      `MYSQL_PWD=${sq(dbPass)} mysqldump -h 127.0.0.1 -u ${sq(p.db_user)} --single-transaction --routines --triggers ${sq(p.db_name)} > ${sq(remoteSql)}`
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
// Paymenter: utilidades
// ---------------------------------------------------------------------------
// Carpeta donde está instalado Paymenter. Si el registro es antiguo y no la
// tiene guardada, se deduce del .env (/var/www/paymenter/.env -> /var/www/paymenter).
function paymenterInstallPath(pm) {
  const saved = (pm.install_path || '').trim();
  if (saved) return saved.replace(/\/+$/, '');
  const env = (pm.env_path || '/var/www/paymenter/.env').trim();
  return path.posix.dirname(env) || '/var/www/paymenter';
}

// Inventario de la instalación: qué tablas tiene la base de datos (incluidas
// las que añaden las extensiones), qué extensiones y temas hay instalados y
// cuánto ocupa cada carpeta. Se guarda dentro del .zip (manifest.json) y en la
// base de datos local, para poder ver de un vistazo qué contiene cada copia.
async function paymenterInventory(conn, pm, install, dbPass) {
  const inv = {
    version: null,
    install_path: install,
    db_name: pm.db_name,
    tables: [],
    extensions: [],
    themes: [],
    keys: [],
    dirs: {},
    generated_at: new Date().toISOString(),
  };

  // 1) Tablas de la base de datos. mysqldump las vuelca TODAS, así que esto es
  //    solo para dejar constancia de las que añaden las extensiones.
  try {
    const out = await exec(
      conn,
      `MYSQL_PWD=${sq(dbPass)} mysql -N -B -h 127.0.0.1 -u ${sq(pm.db_user)} ${sq(pm.db_name)} ` +
      `-e ${sq('SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name')}`
    );
    inv.tables = out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    logger.warn(`Paymenter "${pm.name}": could not list the database tables (${e.message}).`);
  }

  // 2) Extensiones, temas, claves y tamaños. Todo en un solo comando para no
  //    abrir cinco canales SSH por copia.
  try {
    const out = await exec(conn, `cd ${sq(install)} 2>/dev/null || exit 0
echo "@@version"
sed -n "s/.*'version'[^']*'\\([^']*\\)'.*/\\1/p" config/app.php 2>/dev/null | head -n1
echo "@@extensions"
ls -d extensions/*/*/ 2>/dev/null | sed 's:/*$::'
echo "@@themes"
ls -d themes/*/ 2>/dev/null | sed 's:/*$::'
echo "@@keys"
ls ${PAYMENTER_KEY_GLOB} 2>/dev/null
echo "@@sizes"
du -sk ${PAYMENTER_DATA_DIRS.join(' ')} 2>/dev/null
echo "@@end"`);

    let section = null;
    out.split('\n').forEach((raw) => {
      const line = raw.trim();
      if (!line) return;
      if (line.startsWith('@@')) { section = line.slice(2); return; }
      if (section === 'version') inv.version = line;
      else if (section === 'extensions') inv.extensions.push(line.replace(/^extensions\//, ''));
      else if (section === 'themes') inv.themes.push(line.replace(/^themes\//, ''));
      else if (section === 'keys') inv.keys.push(line.replace(/^storage\//, ''));
      else if (section === 'sizes') {
        const [kb, dir] = line.split(/\s+/);
        if (dir) inv.dirs[dir] = Math.round((parseInt(kb, 10) || 0) / 1024); // MB
      }
    });
  } catch (e) {
    logger.warn(`Paymenter "${pm.name}": could not inspect the installation at ${install} (${e.message}).`);
  }

  return inv;
}

// ---------------------------------------------------------------------------
// Copia COMPLETA de UN Paymenter:
//   - base de datos entera (mysqldump, incluye las tablas de las extensiones)
//   - archivo .env
//   - archivos subidos (storage/app: logo, imágenes...), extensiones y temas
//   - manifest.json con el inventario de todo lo anterior
// El .zip queda con esta forma, para que restaurarlo sea descomprimir encima:
//   database.sql · paymenter.env · manifest.json · storage/… · extensions/… · themes/…
// ---------------------------------------------------------------------------
async function backupPaymenter(pm) {
  const withFiles = pm.backup_files === undefined ? true : !!pm.backup_files;
  const install = paymenterInstallPath(pm);
  setJob({ message: `Backing up Paymenter "${pm.name}"${withFiles ? ' (database + files)' : ' (database only)'}...` });

  const base = `pb_paymenter_${Date.now()}`;
  const stage = `/tmp/${base}`;          // aquí se preparan database.sql, .env y manifest.json
  const remoteZip = `/tmp/${base}.zip`;
  const dbPass = decrypt(pm.db_password);
  const localName = `paymenter_${withFiles ? 'full' : 'db'}__${sanitize(pm.name)}__${stamp()}.zip`;
  const localPath = path.join(PAYMENTER_DIR, localName);

  await withConn(panelSsh(pm), async (conn) => {
    try {
      await exec(conn, `mkdir -p ${sq(stage)}`);

      // 1) Base de datos completa.
      setJob({ message: `Paymenter "${pm.name}": dumping the database...` });
      await exec(
        conn,
        `MYSQL_PWD=${sq(dbPass)} mysqldump -h 127.0.0.1 -u ${sq(pm.db_user)} ` +
        `--single-transaction --routines --triggers --events --add-drop-table ` +
        `${sq(pm.db_name)} > ${sq(`${stage}/database.sql`)}`
      );

      // 2) Archivo .env.
      const hasEnv = (await exec(
        conn,
        `if cp ${sq(pm.env_path)} ${sq(`${stage}/paymenter.env`)} 2>/dev/null; then echo OK; else echo NO; fi`
      )).trim() === 'OK';
      if (!hasEnv) logger.warn(`Paymenter "${pm.name}": .env file not found at ${pm.env_path}.`);

      // 3) Inventario (tablas, extensiones, temas...).
      setJob({ message: `Paymenter "${pm.name}": inspecting extensions and themes...` });
      const inv = await paymenterInventory(conn, pm, install, dbPass);
      inv.has_files = withFiles;
      const invJson = JSON.stringify(inv, null, 2);
      await exec(
        conn,
        `echo ${sq(Buffer.from(invJson, 'utf8').toString('base64'))} | base64 -d > ${sq(`${stage}/manifest.json`)}`
      );

      // 4) Metadatos al .zip (quedan en la raíz del archivo).
      await exec(
        conn,
        `cd ${sq(stage)} && zip -qX ${sq(remoteZip)} database.sql manifest.json ${hasEnv ? 'paymenter.env' : ''}`
      );

      // 5) Archivos de la instalación, conservando su ruta relativa.
      if (withFiles) {
        setJob({ message: `Paymenter "${pm.name}": adding uploaded files, extensions and themes...` });
        // El "exit 0" del final es importante: el código de salida del bucle es
        // el de su última vuelta, así que sin él una instalación sin carpeta
        // "themes" haría fallar la copia entera.
        const present = (await exec(
          conn,
          `cd ${sq(install)} 2>/dev/null || exit 0; for d in ${PAYMENTER_DATA_DIRS.join(' ')}; do [ -d "$d" ] && echo "$d"; done; exit 0`
        )).split('\n').map((s) => s.trim()).filter(Boolean);

        if (!present.length) {
          logger.warn(`Paymenter "${pm.name}": no data folders found in ${install}. Only the database and the .env were saved. Check the installation path.`);
        } else {
          // zip devuelve 12 ("nothing to do") si una carpeta está vacía: no es
          // un error, así que solo abortamos con otros códigos.
          await exec(
            conn,
            `cd ${sq(install)} && zip -ryqX ${sq(remoteZip)} ${present.map(sq).join(' ')} ${PAYMENTER_EXCLUDES}; ` +
            `rc=$?; [ $rc -eq 0 ] || [ $rc -eq 12 ] || exit $rc`
          );
          // Claves de storage/ (oauth-*.key). Van aparte porque son un patrón.
          await exec(
            conn,
            `cd ${sq(install)} && if ls ${PAYMENTER_KEY_GLOB} >/dev/null 2>&1; then zip -yqX ${sq(remoteZip)} ${PAYMENTER_KEY_GLOB}; fi`
          ).catch(() => {});
        }
      }

      // 6) Descargar y registrar.
      await download(conn, remoteZip, localPath);
      if (hasEnv) {
        await download(conn, `${stage}/paymenter.env`, path.join(PAYMENTER_ENV_DIR, `env_${sanitize(pm.name)}_${stamp()}.env`)).catch(() => {});
      }

      const size = fs.statSync(localPath).size;
      db.prepare(`
        INSERT INTO backups (type, paymenter_id, server_name, owner_name, owner_email, filename, size, has_files, manifest)
        VALUES ('paymenter_db', ?, ?, '—', '—', ?, ?, ?, ?)
      `).run(pm.id, `Paymenter: ${pm.name}`, localName, size, withFiles ? 1 : 0, invJson);

      const extra = withFiles
        ? ` — ${inv.tables.length} tables, ${inv.extensions.length} extensions, ${inv.themes.length} themes`
        : ` — ${inv.tables.length} tables (database only)`;
      logger.info(`Paymenter backup for "${pm.name}" created (${localName})${extra}.`);
    } finally {
      await exec(conn, `rm -rf ${sq(stage)} ${sq(remoteZip)}`).catch(() => {});
    }
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
          await backupPaymenter(pm);
        } catch (e) {
          logger.error(`Error backing up Paymenter "${pm.name}": ${e.message}`);
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
        `f=$(ls ${sq(dir)}/*.sql 2>/dev/null | head -n1); [ -n "$f" ] || { echo "The zip does not contain a .sql file" >&2; exit 1; }; MYSQL_PWD=${sq(dbPass)} mysql -h 127.0.0.1 -u ${sq(dbUser)} ${sq(dbName)} < "$f"`
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
// Restaurar un Paymenter (al mismo VPS o a otro nuevo).
// opts.files -> además de la base de datos, devuelve los archivos subidos,
//               las extensiones y los temas que trae el .zip.
// opts.env   -> sobrescribe también el archivo .env del destino. Al migrar a
//               otro VPS normalmente NO interesa (sus datos de base de datos
//               y su APP_URL son distintos), por eso va desactivado por defecto.
// ---------------------------------------------------------------------------
async function restorePaymenterDb(backupId, target = null, opts = {}) {
  const b = db.prepare("SELECT * FROM backups WHERE id = ? AND type = 'paymenter_db'").get(backupId);
  if (!b) throw new Error('That Paymenter backup does not exist.');
  const localPath = backupFilePath(b);
  if (!fs.existsSync(localPath)) throw new Error('The .zip file no longer exists on disk.');
  if (job.active) throw new Error('A task is already running. Wait for it to finish.');

  const wantFiles = !!opts.files;
  const wantEnv = !!opts.env;

  let cfg, dbUser, dbPass, dbName, install, label;
  if (target && target.host) {
    cfg = { host: target.host, port: target.ssh_port || 22, user: target.ssh_user || 'root', password: target.ssh_password };
    dbUser = target.db_user || 'paymenter';
    dbPass = target.db_password;
    dbName = target.db_name || 'paymenter';
    install = (target.install_path || '/var/www/paymenter').replace(/\/+$/, '');
    label = target.host;
  } else {
    const pm = (b.paymenter_id && getPaymenter(b.paymenter_id)) || getPaymenters()[0];
    if (!pm) throw new Error('The Paymenter of this backup is no longer configured. Use the "Another VPS" option with its details.');
    cfg = panelSsh(pm);
    dbUser = pm.db_user;
    dbPass = decrypt(pm.db_password);
    dbName = pm.db_name;
    install = paymenterInstallPath(pm);
    label = `${pm.name} (${pm.host})`;
  }

  setJob({ active: true, name: 'Paymenter restore', message: `Restoring Paymenter on ${label}...`, current: 0, total: 1, cancelRequested: false });
  const done = [];
  try {
    await withConn(cfg, async (conn) => {
      const dir = `/tmp/pb_pmrestore_${Date.now()}`;
      const remoteZip = `${dir}.zip`;
      try {
        setJob({ message: `Uploading the backup to ${label}...` });
        await upload(conn, localPath, remoteZip);
        await exec(conn, `mkdir -p ${sq(dir)} && unzip -oq ${sq(remoteZip)} -d ${sq(dir)}`);

        // 1) Base de datos (incluidas las tablas de las extensiones).
        setJob({ message: `Importing the database on ${label}...` });
        await exec(
          conn,
          `f=$(ls ${sq(dir)}/*.sql 2>/dev/null | head -n1); ` +
          `[ -n "$f" ] || { echo "The zip does not contain a .sql file" >&2; exit 1; }; ` +
          `MYSQL_PWD=${sq(dbPass)} mysql -h 127.0.0.1 -u ${sq(dbUser)} ${sq(dbName)} < "$f"`
        );
        done.push('database');

        // 2) Archivos subidos, extensiones y temas.
        if (wantFiles) {
          // Igual que al hacer la copia: sin el "exit 0" final, una copia sin
          // carpetas dentro (las antiguas, que solo llevan la base de datos)
          // haría fallar la restauración en vez de avisar.
          const present = (await exec(
            conn,
            `cd ${sq(dir)} && for d in storage extensions themes; do [ -d "$d" ] && echo "$d"; done; exit 0`
          )).split('\n').map((s) => s.trim()).filter(Boolean);

          if (!present.length) {
            logger.warn('This backup only contains the database and the .env (it was made before full backups, or with files disabled). Nothing to restore in files.');
          } else {
            setJob({ message: `Restoring files on ${label}...` });
            const exists = (await exec(conn, `if [ -d ${sq(install)} ]; then echo OK; else echo NO; fi`)).trim() === 'OK';
            if (!exists) throw new Error(`Paymenter is not installed at ${install} on the destination. Install it first (or fix the installation path) and restore again.`);

            // El dueño de la carpeta de instalación es el usuario del servidor
            // web (normalmente www-data): copiamos como root y le devolvemos
            // la propiedad al final para no romper permisos.
            const owner = (await exec(conn, `stat -c '%U:%G' ${sq(install)} 2>/dev/null || echo 'www-data:www-data'`)).trim() || 'www-data:www-data';

            for (const d of present) {
              // Se fusiona con lo que ya hay (no se borra nada del destino):
              // así una migración no se lleva por delante archivos nuevos.
              await exec(conn, `mkdir -p ${sq(`${install}/${d}`)} && cp -a ${sq(`${dir}/${d}/.`)} ${sq(`${install}/${d}/`)}`);
              done.push(d);
            }

            // Enlace público de storage y limpieza de cachés de Laravel, para
            // que las imágenes se vean y no queden rutas viejas cacheadas.
            await exec(
              conn,
              `cd ${sq(install)} && (php artisan storage:link --force >/dev/null 2>&1 || php artisan storage:link >/dev/null 2>&1 || true) && ` +
              `(php artisan optimize:clear >/dev/null 2>&1 || true)`
            ).catch(() => {});

            await exec(conn, `chown -R ${sq(owner)} ${sq(install)} 2>/dev/null || true`).catch(() => {});
          }
        }

        // 3) Archivo .env (opcional: solo si el admin lo pide).
        if (wantEnv) {
          const hasEnv = (await exec(conn, `if [ -f ${sq(`${dir}/paymenter.env`)} ]; then echo OK; else echo NO; fi`)).trim() === 'OK';
          if (hasEnv) {
            const envDest = `${install}/.env`;
            // Antes de pisarlo se guarda una copia con fecha, por si acaso.
            await exec(conn, `[ -f ${sq(envDest)} ] && cp ${sq(envDest)} ${sq(`${envDest}.pb-backup-${stamp()}`)} || true`).catch(() => {});
            await exec(conn, `cp ${sq(`${dir}/paymenter.env`)} ${sq(envDest)}`);
            await exec(conn, `cd ${sq(install)} && php artisan optimize:clear >/dev/null 2>&1 || true`).catch(() => {});
            done.push('.env');
          } else {
            logger.warn('This backup does not include a .env file: it was not restored.');
          }
        }
      } finally {
        await exec(conn, `rm -rf ${sq(dir)} ${sq(remoteZip)}`).catch(() => {});
      }
    });
    setJob({ current: 1 });
    logger.info(
      `Paymenter restored on ${label} (${done.join(', ')}). ` +
      (wantFiles
        ? 'Uploaded files, extensions and themes are back in place. If something looks off, run "php artisan optimize:clear" on that VPS.'
        : 'Only the database was restored. To also bring back logos, images, extensions and themes, restore again with the "files" option enabled.') +
      (wantEnv ? ' The .env was replaced (the previous one was saved next to it with a .pb-backup- suffix).' : '')
    );
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
  paymenterInstallPath,
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
