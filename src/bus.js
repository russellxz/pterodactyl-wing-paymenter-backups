// src/bus.js - Puente para emitir eventos en tiempo real (Socket.IO) desde cualquier módulo
let io = null;

module.exports = {
  setIO: (instance) => { io = instance; },
  emit: (event, data) => { if (io) io.emit(event, data); },
};
