// src/scheduler.js - Copias automáticas con temporizadores SEPARADOS para los
// nodos y para la base de datos del panel, así no se hacen al mismo tiempo.
// Cada 2 minutos comprueba si toca cada una según su propio intervalo, y
// ejecuta la limpieza de copias antiguas.
//
// Compatibilidad: si existe el ajuste viejo 'schedule_hours', se usa como
// valor inicial para ambos nuevos ajustes la primera vez.
const cron = require('node-cron');
const { getSetting, setSetting } = require('./db');
const backup = require('./backup');
const logger = require('./logger');

function intervalFor(kind) {
  // kind: 'nodes' | 'panel'
  const key = kind === 'panel' ? 'schedule_hours_panel' : 'schedule_hours_nodes';
  let hours = getSetting(key, null);
  if (hours === null) {
    // Migración desde el ajuste único anterior
    hours = getSetting('schedule_hours', '0');
    setSetting(key, hours);
  }
  return parseInt(hours, 10) || 0;
}

function lastRunFor(kind) {
  const key = kind === 'panel' ? 'last_auto_run_panel' : 'last_auto_run_nodes';
  let last = getSetting(key, null);
  if (last === null) {
    last = getSetting('last_auto_run', String(Date.now()));
    setSetting(key, last);
  }
  return parseInt(last, 10) || 0;
}

async function runKind(kind) {
  const hours = intervalFor(kind);
  if (!hours) return;
  if (backup.job.active) return; // nunca solapar una copia con otra

  const last = lastRunFor(kind);
  if (Date.now() - last < hours * 3600 * 1000) return;

  const key = kind === 'panel' ? 'last_auto_run_panel' : 'last_auto_run_nodes';
  setSetting(key, String(Date.now()));

  const target = kind === 'panel' ? 'panel' : 'nodes';
  logger.info(`Iniciando copia automática de ${kind === 'panel' ? 'la base de datos del panel' : 'los nodos'} (cada ${hours} horas)...`);
  try {
    await backup.runBackup({ target });
  } catch (e) {
    logger.error(`Copia automática (${kind}): ${e.message}`);
  }
}

async function tick() {
  try {
    backup.cleanupOld();
  } catch (e) {
    logger.error(`Limpieza automática: ${e.message}`);
  }

  // Se comprueban por separado. Si ambas tocan a la vez, primero corren los
  // nodos y, como no se solapan copias, el panel entrará en el siguiente tick.
  await runKind('nodes');
  await runKind('panel');
}

function start() {
  cron.schedule('*/2 * * * *', tick);
  setTimeout(tick, 15 * 1000);
}

module.exports = { start };
