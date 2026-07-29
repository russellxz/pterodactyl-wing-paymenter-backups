// src/ssh.js - Conexiones SSH y transferencia de archivos (SFTP) usando la librería ssh2.
// No hace falta instalar "sshpass": la app se conecta por SSH directamente desde Node.js.
const crypto = require('crypto');
const { Client } = require('ssh2');
const { getSetting, setSetting, clearHostKey } = require('./db');
const logger = require('./logger');

// Escapa un texto para usarlo de forma segura dentro de un comando de shell.
function sq(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

// Verificación de host key (TOFU: trust-on-first-use). La primera vez que nos
// conectamos a un VPS guardamos la huella (SHA-256) de su clave; en las
// siguientes conexiones comprobamos que no haya cambiado.
//
// Si la huella cambia (lo normal cuando se reinstala, migra o reconstruye el
// VPS, o cuando el proveedor le regenera las claves de SSH), NO bloqueamos la
// conexión: borramos la huella vieja, guardamos la nueva y seguimos. Antes se
// rechazaba y las copias se quedaban paradas hasta que un administrador
// limpiara la huella a mano, que era justo lo que rompía las copias
// automáticas. El cambio queda registrado en los Logs con la huella vieja y la
// nueva, para poder revisarlo si no se esperaba.
function hostKeyId(host, port) {
  return `hostkey_${host}_${Number(port) || 22}`;
}

function makeHostVerifier(host, port) {
  return (key) => {
    try {
      const fp = crypto.createHash('sha256').update(key).digest('base64');
      const settingKey = hostKeyId(host, port);
      const known = getSetting(settingKey, '');
      if (!known) {
        // Primera vez: confiamos y guardamos la huella.
        setSetting(settingKey, fp);
      } else if (known !== fp) {
        // La huella cambió: la borramos, guardamos la nueva y dejamos pasar la
        // conexión para que las copias no se detengan.
        clearHostKey(host, port);
        setSetting(settingKey, fp);
        logger.warn(
          `SSH ${host}:${Number(port) || 22}: the server's host key changed ` +
          `(old SHA256:${known} — new SHA256:${fp}). The saved fingerprint was cleared and the new key ` +
          `trusted automatically so backups keep running. This is normal if you rebuilt, migrated or ` +
          `reinstalled this VPS; if you did not, check the server.`
        );
      }
    } catch (e) {
      // Guardar la huella es solo para dejar constancia: si la base de datos
      // falla, no vale la pena cortar la copia por ello.
      logger.warn(`SSH ${host}: could not save the host fingerprint (${e.message}).`);
    }
    return true;
  };
}

function connect(cfg) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn
      .on('ready', () => resolve(conn))
      .on('error', (err) => {
        // El cambio de huella ya no bloquea la conexión (se acepta la clave
        // nueva automáticamente), así que un error de host key aquí significa
        // que el servidor y esta app no tienen ningún algoritmo de clave en
        // común, no que la huella haya cambiado.
        if (/host.?key|verification/i.test(err.message)) {
          reject(new Error(`SSH ${cfg.host}: could not agree on a host key with the server (${err.message}). Check that its SSH service is up to date and reachable on port ${Number(cfg.port) || 22}.`));
        } else {
          reject(new Error(`SSH ${cfg.host}: ${err.message}`));
        }
      })
      .connect({
        host: cfg.host,
        port: Number(cfg.port) || 22,
        username: cfg.user || 'root',
        password: cfg.password,
        readyTimeout: 25000,
        keepaliveInterval: 10000,
        hostVerifier: makeHostVerifier(cfg.host, cfg.port),
      });
  });
}

function exec(conn, command) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      let errOut = '';
      stream
        .on('close', (code) => {
          if (code !== 0) reject(new Error(errOut.trim() || `El comando falló (código ${code})`));
          else resolve(out);
        })
        .on('data', (d) => { out += d; });
      stream.stderr.on('data', (d) => { errOut += d; });
    });
  });
}

// Abre UNA sola sesión SFTP por conexión y la reutiliza para todas las
// descargas y subidas. (Antes se abría una nueva por cada archivo y nunca se
// cerraba: los VPS permiten ~10 canales por conexión SSH, así que en nodos
// con más de 10 servidores las copias fallaban con "Channel open failure".)
function sftpFor(conn) {
  if (conn._pbSftp) return Promise.resolve(conn._pbSftp);
  if (!conn._pbSftpPromise) {
    conn._pbSftpPromise = new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => {
        if (err) {
          conn._pbSftpPromise = null;
          return reject(err);
        }
        sftp.on('close', () => { conn._pbSftp = null; conn._pbSftpPromise = null; });
        conn._pbSftp = sftp;
        resolve(sftp);
      });
    });
  }
  return conn._pbSftpPromise;
}

async function download(conn, remotePath, localPath) {
  const sftp = await sftpFor(conn);
  return new Promise((resolve, reject) => {
    sftp.fastGet(remotePath, localPath, (e) => (e ? reject(e) : resolve()));
  });
}

async function upload(conn, localPath, remotePath) {
  const sftp = await sftpFor(conn);
  return new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, (e) => (e ? reject(e) : resolve()));
  });
}

// Abre una conexión, ejecuta la función y SIEMPRE cierra la conexión al final.
async function withConn(cfg, fn) {
  const conn = await connect(cfg);
  try {
    return await fn(conn);
  } finally {
    try { conn.end(); } catch (e) { /* ignorar */ }
  }
}

module.exports = { sq, connect, exec, download, upload, withConn };
