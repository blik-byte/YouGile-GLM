// lib/fl-monitor.js
// Сбор заказов FL.ru по расписанию: снапшот сырья, оценка по правилам,
// отметки здоровья источника для баннера в ленте.

'use strict';

const { fetchOrders } = require('./fl-ru');
const { saveLeads } = require('./leads-store');
const rawStore = require('./leads-raw');
const health = require('./source-health');

const SOURCE = 'fl';

/**
 * Один проход сбора. Возвращает статистику либо null при ошибке.
 * Ошибки не пробрасываются: монитор должен переживать недоступность площадки.
 */
async function collectOnce({ logger = console } = {}) {
  try {
    await health.recordAttempt(SOURCE);

    const orders = await fetchOrders();
    const raw = await rawStore.saveRawBatch(orders);
    const stats = await saveLeads(orders);

    await health.recordSuccess(SOURCE, orders.length);

    logger.log(
      `📡 FL.ru: получено ${orders.length}, новых ${stats.added}, обновлено ${stats.updated}, снапшотов ${raw.saved}`
    );

    return { fetched: orders.length, ...stats, raw: raw.saved };
  } catch (error) {
    await health.recordFailure(SOURCE, error.message).catch(() => {});
    logger.warn(`⚠️ FL.ru: сбор не удался — ${error.message}`);
    return null;
  }
}

function startFlMonitor({ intervalMs, logger = console } = {}) {
  const period = Number(intervalMs || process.env.LEADS_FETCH_INTERVAL_MS || 1200000);
  if (!period || period < 60000) {
    logger.log('ℹ️ FL.ru: сбор отключён (LEADS_FETCH_INTERVAL_MS)');
    return null;
  }

  let busy = false;

  async function run() {
    if (busy) return null;
    busy = true;
    try {
      return await collectOnce({ logger });
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(run, period);
  if (timer.unref) timer.unref();

  const first = setTimeout(run, 15000);
  if (first.unref) first.unref();

  logger.log(`📡 FL.ru: сбор каждые ${Math.round(period / 60000)} мин`);
  return { timer, run };
}

module.exports = { startFlMonitor, collectOnce, SOURCE };
