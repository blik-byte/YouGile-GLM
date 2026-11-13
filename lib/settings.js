// lib/settings.js
// Настройки ленты: порог «горячего», дни follow-up, часы простоя источника.
// Хранятся одним документом в Mongo, чтобы переживать перезапуск Render.

'use strict';

const db = require('../db');

const COLLECTION = 'settings';
const DOC_ID = 'leads';

const DEFAULTS = {
  hotScore: 80,
  hotAgeHours: 2,
  followUpDays: 3,
  sourceDownHours: 6,
};

function normalize(patch = {}) {
  const result = {};
  const limits = {
    hotScore: [0, 100],
    hotAgeHours: [1, 168],
    followUpDays: [1, 60],
    sourceDownHours: [1, 72],
  };

  for (const [key, [min, max]] of Object.entries(limits)) {
    if (patch[key] === undefined || patch[key] === null || patch[key] === '') continue;
    const value = Number(patch[key]);
    if (Number.isFinite(value)) result[key] = Math.min(max, Math.max(min, Math.round(value)));
  }
  return result;
}

async function get() {
  const database = await db.getDb();
  const doc = await database.collection(COLLECTION).findOne({ _id: DOC_ID });
  return { ...DEFAULTS, ...(doc ? doc.values : {}) };
}

async function set(patch) {
  const database = await db.getDb();
  const values = { ...(await get()), ...normalize(patch) };
  await database
    .collection(COLLECTION)
    .updateOne({ _id: DOC_ID }, { $set: { values, updatedAt: new Date() } }, { upsert: true });
  return values;
}

async function reset() {
  const database = await db.getDb();
  await database.collection(COLLECTION).deleteOne({ _id: DOC_ID });
  return { ...DEFAULTS };
}

module.exports = { COLLECTION, DEFAULTS, normalize, get, set, reset };
