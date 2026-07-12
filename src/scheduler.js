// src/scheduler.js - Copias automáticas con temporizadores SEPARADOS para los
// nodos, la base de datos del panel y la base de datos de Paymenter, así no
// se hacen al mismo tiempo. Cada 2 minutos comprueba si toca cada una según
// su propio intervalo, y ejecuta la limpieza de copias antiguas.
//
// Compatibilidad: si existe el ajuste viejo 'schedule_hours', se usa como
// valor inicial para los ajustes de nodos y panel la primera vez. Paymenter
// arranca desactivado hasta que lo actives en Configuración.
const cron = require('node-cron');
const { getSetting, setSetting } = require('./db');
const backup = require('./backup');
const logger = require('./logger');

const KINDS = {
  nodes: { scheduleKey: 'schedule_hours_nodes', lastKey: 'last_auto_run_nodes', target: 'nodes', label: 'the nodes' },
  panel: { scheduleKey: 'schedule_hours_panel', lastKey: 'last_auto_run_panel', target: 'panel', label: 'the panel database' },
  paymenter: { scheduleKey: 'schedule_hours_paymenter', lastKey: 'last_auto_run_paymenter', target: 'paymenter', label: 'the Paymenter database' },
};

function intervalFor(kind) {
  const k = KINDS[kind];
  let hours = getSetting(k.scheduleKey, null);
  if (hours === null) {
    // Migración desde el ajuste único anterior (solo nodos y panel;
    // Paymenter es nuevo y empieza desactivado).
    hours = kind === 'paymenter' ? '0' : getSetting('schedule_hours', '0');
    setSetting(k.scheduleKey, hours);
  }
  return parseInt(hours, 10) || 0;
}

function lastRunFor(kind) {
  const k = KINDS[kind];
  let last = getSetting(k.lastKey, null);
  if (last === null) {
    last = kind === 'paymenter' ? String(Date.now()) : getSetting('last_auto_run', String(Date.now()));
    setSetting(k.lastKey, last);
  }
  return parseInt(last, 10) || 0;
}

async function runKind(kind) {
  const hours = intervalFor(kind);
  if (!hours) return;
  if (backup.job.active) return; // nunca solapar una copia con otra

  const last = lastRunFor(kind);
  if (Date.now() - last < hours * 3600 * 1000) return;

  const k = KINDS[kind];
  setSetting(k.lastKey, String(Date.now()));

  logger.info(`Starting automatic backup of ${k.label} (every ${hours} hours)...`);
  try {
    await backup.runBackup({ target: k.target });
  } catch (e) {
    logger.error(`Automatic backup (${kind}): ${e.message}`);
  }
}

async function tick() {
  try {
    backup.cleanupOld();
  } catch (e) {
    logger.error(`Automatic cleanup: ${e.message}`);
  }

  // Se comprueban por separado. Si varias tocan a la vez, corre la primera
  // y, como no se solapan copias, las demás entrarán en los siguientes ticks.
  await runKind('nodes');
  await runKind('panel');
  await runKind('paymenter');
}

function start() {
  cron.schedule('*/2 * * * *', tick);
  setTimeout(tick, 15 * 1000);
}

module.exports = { start };
