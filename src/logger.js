// src/logger.js - Registro de eventos: guarda en la BD, imprime en consola
// y lo emite en tiempo real a la página de Logs.
const { db } = require('./db');
const bus = require('./bus');

function write(level, message) {
  try {
    db.prepare("INSERT INTO logs (level, message) VALUES (?, ?)").run(level, message);
  } catch (e) { /* nunca romper la app por un log */ }
  const stamp = new Date().toLocaleString('es-ES');
  console.log(`[${stamp}] [${level}] ${message}`);
  bus.emit('log', { level, message, created_at: stamp });
}

module.exports = {
  info: (m) => write('INFO', m),
  warn: (m) => write('WARN', m),
  error: (m) => write('ERROR', m),
};
