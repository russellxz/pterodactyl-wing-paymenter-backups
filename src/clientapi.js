// src/clientapi.js - API externa para consultar y descargar backups por
// correo del cliente. La puede usar cualquier sistema propio (un bot, un
// script, otra web): solo necesita la clave.
//
// Permite:
//   1) ver qué servidores/backups tiene disponibles un correo,
//   2) pedir la copia MÁS RECIENTE de cada servidor (lo normal: "mi backup
//      actual"),
//   3) pedir el HISTORIAL completo (todas las fechas) para que el cliente
//      elija una fecha concreta,
//   4) descargar el archivo .zip de una copia puntual.
//
// La clave se genera sola (Configuración -> "API externa") y SOLO la
// conocen los dueños del sistema: la pegan en el sistema que la vaya a usar.
// Nadie más tiene acceso.
//
// Regla de oro para que nunca haya un error de "se ve el backup de otro
// cliente": TODAS las rutas exigen el parámetro `email` y el filtrado por
// dueño (owner_email) se hace siempre en el propio SQL, nunca confiando en
// que quien llama ya haya filtrado antes. La comparación ignora mayúsculas,
// minúsculas y espacios sobrantes.
const express = require('express');
const crypto = require('crypto');
const { db, getSetting, setSetting } = require('./db');
const backup = require('./backup');
const logger = require('./logger');

function ensureKey() {
  let key = getSetting('client_api_key', '');
  if (!key) {
    key = crypto.randomBytes(24).toString('hex');
    setSetting('client_api_key', key);
    logger.info('Clave de la API externa generada (ver Configuración).');
  }
  return key;
}

function regenerateKey() {
  const key = crypto.randomBytes(24).toString('hex');
  setSetting('client_api_key', key);
  return key;
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

// Normaliza un correo para comparar siempre igual: sin espacios y en minúsculas.
function normEmail(v) {
  return String(v || '').trim().toLowerCase();
}

const router = express.Router();

// ---------------------------------------------------------------------------
// Autenticación por clave Bearer en TODAS las rutas de esta API.
router.use((req, res, next) => {
  const key = getSetting('client_api_key', '');
  const header = req.get('authorization') || '';
  const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (key && given && safeEqual(key, given)) return next();
  res.status(401).json({ ok: false, message: 'Clave de API inválida.' });
});

// Exige el correo del cliente en TODAS las consultas (por query o por body).
// Sin correo no se devuelve nada: así no hay forma de "listar todo".
router.use((req, res, next) => {
  const email = normEmail((req.query && req.query.email) || (req.body && req.body.email));
  if (!email || !email.includes('@')) {
    return res.status(400).json({ ok: false, message: 'Falta o es inválido el parámetro "email".' });
  }
  req.clientEmail = email;
  next();
});

router.get('/ping', (req, res) => res.json({ ok: true, name: 'PteroBackups API' }));

// ---------------------------------------------------------------------------
// Servidores que pertenecen a ese correo, con la fecha de su última copia.
// Útil para armar un menú cuando el cliente tiene varios servidores.
router.get('/servers', (req, res) => {
  const rows = db.prepare(`
    SELECT b.server_uuid, b.server_name, b.owner_name, b.owner_email,
           MAX(b.created_at) AS last_backup_at,
           COUNT(*) AS backups_count
    FROM backups b
    WHERE b.type = 'server' AND LOWER(TRIM(b.owner_email)) = ?
    GROUP BY b.server_uuid
    ORDER BY last_backup_at DESC
  `).all(req.clientEmail);
  res.json({ ok: true, email: req.clientEmail, servers: rows });
});

// ---------------------------------------------------------------------------
// La copia MÁS RECIENTE de cada servidor de ese correo (o de uno en concreto
// si se manda ?server_uuid=...). ESTO es lo que se debe pedir por defecto
// cuando el cliente solo quiere "su backup", sin más vueltas.
router.get('/backups/latest', (req, res) => {
  const uuid = req.query.server_uuid ? String(req.query.server_uuid) : null;
  const params = uuid
    ? [req.clientEmail, req.clientEmail, uuid]
    : [req.clientEmail, req.clientEmail];
  const rows = db.prepare(`
    SELECT b.id, b.server_uuid, b.server_name, b.owner_name, b.owner_email,
           b.filename, b.size, b.created_at, n.name AS node_name
    FROM backups b
    LEFT JOIN nodes n ON n.id = b.node_id
    WHERE b.type = 'server' AND LOWER(TRIM(b.owner_email)) = ?
      AND b.id IN (
        SELECT MAX(id) FROM backups
        WHERE type = 'server' AND LOWER(TRIM(owner_email)) = ?
        GROUP BY server_uuid
      )
      ${uuid ? 'AND b.server_uuid = ?' : ''}
    ORDER BY b.created_at DESC
  `).all(...params);
  res.json({ ok: true, email: req.clientEmail, backups: rows });
});

// ---------------------------------------------------------------------------
// HISTORIAL completo (todas las fechas de copia) de ese correo, o de un solo
// servidor si se manda ?server_uuid=. Para cuando el cliente pide "todas mis
// fechas" y quiere elegir cuál descargar. Con paginación por si son muchas.
router.get('/backups/history', (req, res) => {
  const uuid = req.query.server_uuid ? String(req.query.server_uuid) : null;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  const whereExtra = uuid ? 'AND b.server_uuid = ?' : '';
  const listParams = uuid
    ? [req.clientEmail, uuid, limit, offset]
    : [req.clientEmail, limit, offset];
  const rows = db.prepare(`
    SELECT b.id, b.server_uuid, b.server_name, b.owner_name, b.owner_email,
           b.filename, b.size, b.created_at, n.name AS node_name
    FROM backups b
    LEFT JOIN nodes n ON n.id = b.node_id
    WHERE b.type = 'server' AND LOWER(TRIM(b.owner_email)) = ? ${whereExtra}
    ORDER BY b.id DESC
    LIMIT ? OFFSET ?
  `).all(...listParams);

  const countParams = uuid ? [req.clientEmail, uuid] : [req.clientEmail];
  const total = db.prepare(`
    SELECT COUNT(*) AS c FROM backups b
    WHERE b.type = 'server' AND LOWER(TRIM(b.owner_email)) = ? ${whereExtra}
  `).get(...countParams).c;

  res.json({ ok: true, email: req.clientEmail, total, limit, offset, backups: rows });
});

// ---------------------------------------------------------------------------
// Info de UNA copia puntual. Verifica que sea de ese correo antes de mostrar
// nada (si no coincide, responde igual que si no existiera).
router.get('/backups/:id', (req, res) => {
  const row = db.prepare(`
    SELECT b.id, b.server_uuid, b.server_name, b.owner_name, b.owner_email,
           b.filename, b.size, b.created_at, n.name AS node_name
    FROM backups b
    LEFT JOIN nodes n ON n.id = b.node_id
    WHERE b.id = ? AND b.type = 'server'
  `).get(req.params.id);
  if (!row || normEmail(row.owner_email) !== req.clientEmail) {
    return res.status(404).json({ ok: false, message: 'La copia no existe o no pertenece a ese correo.' });
  }
  res.json({ ok: true, backup: row });
});

// ---------------------------------------------------------------------------
// Descarga de UNA copia puntual. Igual que arriba: si el id existe pero es
// de OTRO correo, se trata como si no existiera (nunca se filtra info de un
// cliente a otro, ni por error de quien consulta).
router.get('/backups/:id/download', (req, res) => {
  let row;
  try {
    row = db.prepare("SELECT * FROM backups WHERE id = ? AND type = 'server'").get(req.params.id);
  } catch (e) {
    logger.error(`API externa: error leyendo la copia ${req.params.id}: ${e.message}`);
    return res.status(500).json({ ok: false, message: 'Error interno al buscar la copia.' });
  }
  if (!row || normEmail(row.owner_email) !== req.clientEmail) {
    return res.status(404).json({ ok: false, message: 'La copia no existe o no pertenece a ese correo.' });
  }

  let filePath;
  try {
    filePath = backup.backupFilePath(row);
  } catch (e) {
    logger.error(`API externa: no se pudo resolver la ruta de la copia ${row.id}: ${e.message}`);
    return res.status(500).json({ ok: false, message: 'Error interno al preparar la descarga.' });
  }

  res.download(filePath, row.filename, (err) => {
    if (err && !res.headersSent) {
      logger.error(`API externa: el archivo de la copia ${row.id} ya no existe en disco.`);
      res.status(404).json({ ok: false, message: 'El archivo ya no existe en el disco (pudo haberse eliminado o expirado).' });
    }
  });
});

// ---------------------------------------------------------------------------
// Cualquier otra ruta dentro de /api/client que no exista: respuesta JSON
// clara en vez de dejar que caiga al 404 general de la web.
router.use((req, res) => {
  res.status(404).json({ ok: false, message: 'Ruta de la API no encontrada.' });
});

module.exports = { router, ensureKey, regenerateKey };
