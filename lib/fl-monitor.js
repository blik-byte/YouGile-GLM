// lib/fl-monitor.js
// Регулярный сбор заказов FL.ru.
//
// Интервал — LEADS_FETCH_INTERVAL_MS (по умолчанию 20 минут). Первый сбор
// откладывается: сервис только что поднялся, база и сеть ещё «прогреваются».

'use strict';

const { fetchOrders } = require('./fl-ru');
const { saveLeads } = require('./leads-store');

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
      const orders = await fetchOrders();
      const stats = await saveLeads(orders);
      logger.log(`📡 FL.ru: получено ${orders.length}, новых ${stats.added}, обновлено ${stats.updated}`);
      return stats;
    } catch (error) {
      logger.warn(`⚠️ FL.ru: сбор не удался — ${error.message}`);
      return null;
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

module.exports = { startFlMonitor };
