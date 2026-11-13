// lib/source-health.js
// Здоровье источника: когда последний раз успешно собирали, когда пытались,
// чем закончилась последняя попытка. На этих данных строится баннер в ленте
// и кнопка «Собрать сейчас».

'use strict';

const db = require('../db');

const COLLECTION = 'source_health';

function emptyState(source) {
  return {
    source,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastCount: 0,
    consecutiveFailures: 0,
  };
}

async function read(source) {
  const database = await db.getDb();
  const doc = await database.collection(COLLECTION).findOne({ source });
  return doc || emptyState(source);
}

async function write(source, patch) {
  const database = await db.getDb();
  await database.collection(COLLECTION).updateOne(
    { source },
    { $set: { ...patch, source, updatedAt: new Date() } },
    { upsert: true }
  );
}

async function recordAttempt(source) {
  await write(source, { lastAttemptAt: new Date() });
}

async function recordSuccess(source, count = 0) {
  const now = new Date();
  await write(source, {
    lastAttemptAt: now,
    lastSuccessAt: now,
    lastError: null,
    lastCount: count,
    consecutiveFailures: 0,
  });
}

async function recordFailure(source, error) {
  const current = await read(source);
  await write(source, {
    lastAttemptAt: new Date(),
    lastError: String(error || 'неизвестная ошибка').slice(0, 300),
    consecutiveFailures: (current.consecutiveFailures || 0) + 1,
  });
}

/**
 * Состояние для интерфейса.
 * @param {string} source
 * @param {number} downAlertHours порог, после которого показываем тревогу (из настроек)
 */
function describe(state, { downAlertHours = 6, now = new Date() } = {}) {
  const lastSuccess = state.lastSuccessAt ? new Date(state.lastSuccessAt) : null;
  const hoursSinceSuccess = lastSuccess ? (now.getTime() - lastSuccess.getTime()) / 3600000 : null;

  const down = !lastSuccess || hoursSinceSuccess > downAlertHours;

  return {
    ...state,
    hoursSinceSuccess: hoursSinceSuccess === null ? null : Math.round(hoursSinceSuccess * 10) / 10,
    down,
    downAlertHours,
  };
}

async function getHealth(source, options) {
  return describe(await read(source), options);
}

module.exports = {
  COLLECTION,
  emptyState,
  read,
  recordAttempt,
  recordSuccess,
  recordFailure,
  describe,
  getHealth,
};
