// src/ssh.js - Conexiones SSH y transferencia de archivos (SFTP) usando la librería ssh2.
// No hace falta instalar "sshpass": la app se conecta por SSH directamente desde Node.js.
const { Client } = require('ssh2');

// Escapa un texto para usarlo de forma segura dentro de un comando de shell.
function sq(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function connect(cfg) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn
      .on('ready', () => resolve(conn))
      .on('error', (err) => reject(new Error(`SSH ${cfg.host}: ${err.message}`)))
      .connect({
        host: cfg.host,
        port: Number(cfg.port) || 22,
        username: cfg.user || 'root',
        password: cfg.password,
        readyTimeout: 25000,
        keepaliveInterval: 10000,
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

function download(conn, remotePath, localPath) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.fastGet(remotePath, localPath, (e) => (e ? reject(e) : resolve()));
    });
  });
}

function upload(conn, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.fastPut(localPath, remotePath, (e) => (e ? reject(e) : resolve()));
    });
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
