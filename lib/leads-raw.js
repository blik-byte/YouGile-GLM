// lib/leads-raw.js
// Сырые снапшоты заказов: что именно пришло от площадки в момент сбора.
//
// Зачем: через месяц заказ на FL.ru может исчезнуть, а пересчитать балл по новым
// правилам нужно. Снапшот — это текст заказа и его метаданные, не файлы.
// Срок хранения 21 день: TTL-индекс чистит сам, без планировщика.

'use strict';

const db = require('../db');

const COLLECTION = 'orders_raw';
const RETENTION_DAYS = 21;

let indexesReady = false;

async function ensureIndexes() {
  if (indexesReady) return;
  const database = await db.getDb();
  const collection = database.collection(COLLECTION);
  await collection.createIndex({ createdAt: 1 }, { expireAfterSeconds: RETENTION_DAYS * 86400 });
  await collection.createIndex({ source: 1, externalId: 1 }, { unique: true });
  indexesReady = true;
}

/**
 * Сохраняет снапшоты пачки заказов. Повторный сбор обновляет текст,
 * но не создаёт дублей.
 * @returns {Promise<{saved:number}>}
 */
async function saveRawBatch(orders, { fetchedAt = new Date() } = {}) {
  if (!Array.isArray(orders) || orders.length === 0) return { saved: 0 };
  await ensureIndexes();

  const database = await db.getDb();
  const collection = database.collection(COLLECTION);

  const operations = orders.map((order) => ({
    updateOne: {
      filter: { source: order.source || 'fl', externalId: String(order.externalId) },
      update: {
        $set: {
          source: order.source || 'fl',
          externalId: String(order.externalId),
          title: order.title || '',
          description: order.description || '',
          category: order.category || '',
          budget: order.budget || '',
          budgetValue: order.budgetValue || 0,
          url: order.url || '',
          publishedAt: order.publishedAt || null,
          fetchedAt,
          updatedAt: fetchedAt,
        },
        $setOnInsert: { createdAt: fetchedAt },
      },
      upsert: true,
    },
  }));

  const result = await collection.bulkWrite(operations, { ordered: false });
  return { saved: (result.upsertedCount || 0) + (result.modifiedCount || 0) };
}

async function countRaw() {
  const database = await db.getDb();
  return database.collection(COLLECTION).countDocuments({});
}

module.exports = { COLLECTION, RETENTION_DAYS, ensureIndexes, saveRawBatch, countRaw };
