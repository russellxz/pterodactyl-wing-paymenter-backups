// src/scheduler.js - Copias automáticas: cada 10 minutos comprueba si toca hacer
// una copia según el intervalo configurado (1h, 1 día, 7, 15 o 30 días) y
// ejecuta la limpieza de copias antiguas.
const cron = require('node-cron');
const { getSetting, setSetting } = require('./db');
const backup = require('./backup');
const logger = require('./logger');

async function tick() {
  try {
    backup.cleanupOld();
  } catch (e) {
    logger.error(`Limpieza automática: ${e.message}`);
  }

  const hours = parseInt(getSetting('schedule_hours', '0'), 10);
  if (!hours || backup.job.active) return;

  const lastRun = parseInt(getSetting('last_auto_run', '0'), 10);
  if (Date.now() - lastRun >= hours * 3600 * 1000) {
    setSetting('last_auto_run', Date.now());
    logger.info(`Iniciando copia automática programada (cada ${hours} horas)...`);
    try {
      await backup.runBackup({});
    } catch (e) {
      logger.error(`Copia automática: ${e.message}`);
    }
  }
}

function start() {
  cron.schedule('*/10 * * * *', tick);
  setTimeout(tick, 15 * 1000); // primera comprobación a los 15 segundos de arrancar
}

module.exports = { start };
