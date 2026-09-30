// db.js
// Доступ к MongoDB.
//
// Исправлено относительно прежней версии:
//  1. Убран `new MongoClient(process.env.MONGODB_URI)` на уровне модуля — он
//     выполнялся при require() и ронял всё приложение, если MONGODB_URI не задан,
//     причём переменная нигде не использовалась.
//  2. Подключение кэшируется как Promise — устранена гонка, из-за которой
//     параллельные вызовы (вебхук + поллинг + воркер) создавали по несколько клиентов.
//  3. getTaskResults() больше не открывает отдельное соединение на каждый запрос.
//  4. search_cache получил TTL-индекс — коллекция больше не растёт вечно.
//  5. Добавлены коллекции для персистентной дедупликации (вебхуки, запуски задач)
//     и для whitelist'а Telegram-бота.

const { MongoClient } = require('mongodb');
const { config } = require('./lib/config');

const COLLECTIONS = {
  results: 'task_results',
  history: 'task_history',
  searchCache: 'search_cache',
  webhookEvents: 'webhook_events',
  taskRuns: 'task_runs',
  botAccess: 'bot_access',
  botRequests: 'bot_requests',
  agentRuns: 'agent_runs',
};

/** Сколько минут задача считается «ещё выполняется» после рестарта процесса. */
const RUNNING_TTL_MS = Number(process.env.TASK_RUNNING_TTL_MIN || 30) * 60 * 1000;
/** Сколько раз подряд можно повторить упавшую задачу. */
const MAX_TASK_ATTEMPTS = Number(process.env.TASK_MAX_ATTEMPTS || 3);
/** Пауза перед повтором упавшей задачи, мс. */
const TASK_RETRY_COOLDOWN_MS = Number(process.env.TASK_RETRY_COOLDOWN_MIN || 5) * 60 * 1000;

let connectPromise = null;
let clientRef = null;

/**
 * Определения индексов.
 *
 * Каждому индексу задано ЯВНОЕ имя. Прежний вариант полагался на автоматически
 * генерируемые имена и падал на старте в проде:
 *   "An existing index has the same name as the requested index...
 *    Requested: {unique:true, key:{taskId:1}, name:'taskId_1'},
 *    existing:  {key:{taskId:1}, name:'taskId_1'}"
 * — то есть неуникальный индекс task_history.taskId, созданный старой версией,
 * конфликтовал с новым уникальным, и подключение к базе не выполнялось вовсе.
 */
const INDEX_DEFINITIONS = [
  { collection: COLLECTIONS.results, keys: { taskId: 1, timestamp: -1 }, name: 'taskId_timestamp' },
  { collection: COLLECTIONS.history, keys: { taskId: 1 }, name: 'uniq_taskId', options: { unique: true } },
  {
    collection: COLLECTIONS.searchCache,
    keys: { timestamp: 1 },
    name: 'ttl_timestamp',
    options: { expireAfterSeconds: 7 * 24 * 3600 },
  },
  { collection: COLLECTIONS.searchCache, keys: { query: 1 }, name: 'uniq_query', options: { unique: true } },
  { collection: COLLECTIONS.webhookEvents, keys: { messageId: 1 }, name: 'uniq_messageId', options: { unique: true } },
  {
    collection: COLLECTIONS.webhookEvents,
    keys: { createdAt: 1 },
    name: 'ttl_createdAt',
    options: { expireAfterSeconds: 3600 },
  },
  { collection: COLLECTIONS.taskRuns, keys: { taskId: 1 }, name: 'uniq_taskId', options: { unique: true } },
  { collection: COLLECTIONS.botAccess, keys: { chatId: 1 }, name: 'uniq_chatId', options: { unique: true } },
  { collection: COLLECTIONS.botRequests, keys: { chatId: 1 }, name: 'uniq_chatId', options: { unique: true } },
  { collection: COLLECTIONS.agentRuns, keys: { startedAt: -1 }, name: 'startedAt_desc' },
  { collection: COLLECTIONS.agentRuns, keys: { taskId: 1, startedAt: -1 }, name: 'taskId_startedAt' },
];

/**
 * Создание индексов.
 * Сбой одного индекса не мешает подключиться к базе: приложение должно подниматься
 * даже на «грязной» коллекции, а не падать на старте.
 *
 * @param {import('mongodb').Db} db
 */
async function createIndexes(db) {
  for (const definition of INDEX_DEFINITIONS) {
    const collection = db.collection(definition.collection);
    const options = { name: definition.name, ...(definition.options || {}) };
    const label = `${definition.collection}.${definition.name}`;

    try {
      await collection.createIndex(definition.keys, options);
      continue;
    } catch (error) {
      // 85 = IndexOptionsConflict, 86 = IndexKeySpecsConflict
      const isConflict =
        error.code === 85 || error.code === 86 || /same name as the requested index/i.test(error.message);

      if (!isConflict) {
        console.warn(`⚠️ Индекс ${label}: ${error.message}`);
        continue;
      }
    }

    // Конфликт с индексом от предыдущей версии схемы: удаляем старый и создаём нужный.
    // Данные коллекции при этом не затрагиваются.
    try {
      const legacyName = Object.keys(definition.keys)
        .map((key) => `${key}_${definition.keys[key]}`)
        .join('_');

      await collection.dropIndex(definition.name).catch(() => {});
      if (legacyName !== definition.name) {
        await collection.dropIndex(legacyName).catch(() => {});
      }

      await collection.createIndex(definition.keys, options);
      console.log(`♻️ Индекс ${label} пересоздан (конфликт со старой схемой)`);
    } catch (error) {
      // Уникальный индекс может не создаться, если в коллекции уже есть дубликаты.
      // Это не повод ронять приложение — логируем и работаем дальше.
      console.warn(
        `⚠️ Не удалось создать индекс ${label}: ${error.message}` +
          (definition.options?.unique ? ' (возможно, в коллекции есть дубликаты)' : '')
      );
    }
  }
}

/**
 * Подключение к MongoDB (идемпотентное, без гонок).
 * @returns {Promise<import('mongodb').Db>}
 */
function connectToMongo() {
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    if (!config.mongodbUri) {
      throw new Error(
        'MONGODB_URI не задан. Без него не работают сохранение результатов, кэш поиска, ' +
          'дедупликация вебхуков и whitelist Telegram-бота.'
      );
    }

    const client = new MongoClient(config.mongodbUri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
    });

    await client.connect();
    clientRef = client;

    const db = client.db(config.mongoDbName);

    await createIndexes(db);

    console.log('✅ MongoDB подключена');
    return db;
  })().catch((error) => {
    // Сбрасываем, чтобы следующая попытка не получила закэшированный реджект
    connectPromise = null;
    throw error;
  });

  return connectPromise;
}

async function getDb() {
  return connectToMongo();
}

async function close() {
  if (clientRef) {
    await clientRef.close().catch(() => {});
    clientRef = null;
    connectPromise = null;
    console.log('🔌 MongoDB: соединение закрыто');
  }
}

/* ------------------------------------------------------------------ */
/* Результаты шагов агента                                             */
/* ------------------------------------------------------------------ */

async function saveTaskStep(taskId, step, data, metadata = {}) {
  const db = await getDb();
  const result = await db.collection(COLLECTIONS.results).insertOne({
    taskId: String(taskId),
    step: String(step || 'без названия'),
    data,
    metadata,
    timestamp: new Date(),
  });

  console.log(`💾 Шаг "${step}" сохранён для задачи ${taskId}`);
  return result.insertedId;
}

async function getTaskSteps(taskId) {
  const db = await getDb();
  return db
    .collection(COLLECTIONS.results)
    .find({ taskId: String(taskId) })
    .sort({ timestamp: 1 })
    .toArray();
}

/** Алиас для совместимости со старым index.js */
const getTaskResults = getTaskSteps;

async function saveChatHistory(taskId, messages) {
  const db = await getDb();
  await db.collection(COLLECTIONS.history).updateOne(
    { taskId: String(taskId) },
    {
      $set: { messages, updatedAt: new Date() },
      $setOnInsert: { taskId: String(taskId), createdAt: new Date() },
    },
    { upsert: true }
  );
}

/* ------------------------------------------------------------------ */
/* Кэш поиска                                                          */
/* ------------------------------------------------------------------ */

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function getCachedSearch(query) {
  const db = await getDb();
  const cached = await db.collection(COLLECTIONS.searchCache).findOne({
    query: String(query || '').toLowerCase(),
    timestamp: { $gte: new Date(Date.now() - CACHE_TTL_MS) },
  });
  return cached?.result || null;
}

async function cacheSearch(query, result) {
  const db = await getDb();
  await db.collection(COLLECTIONS.searchCache).updateOne(
    { query: String(query || '').toLowerCase() },
    { $set: { result, timestamp: new Date() } },
    { upsert: true }
  );
}

/* ------------------------------------------------------------------ */
/* Дедупликация вебхуков                                               */
/* ------------------------------------------------------------------ */

/**
 * Отмечает событие как обработанное.
 * @returns {Promise<boolean>} true — событие новое; false — дубликат
 */
async function markWebhookEvent(messageId) {
  if (!messageId) return true;
  const db = await getDb();
  try {
    await db.collection(COLLECTIONS.webhookEvents).insertOne({
      messageId: String(messageId),
      createdAt: new Date(),
    });
    return true;
  } catch (error) {
    // 11000 = duplicate key
    if (error.code === 11000) return false;
    // Если база недоступна — не блокируем обработку, но сообщаем
    console.warn(`⚠️ Дедупликация вебхуков недоступна: ${error.message}`);
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* Запуски задач (персистентная защита от повторов)                    */
/* ------------------------------------------------------------------ */

/**
 * Пытается занять задачу на выполнение.
 * Заменяет прежний `processedTasks = new Set()` в памяти процесса, который:
 *   - обнулялся при рестарте Render → задачи выполнялись повторно;
 *   - навсегда блокировал упавшие задачи → повтор был невозможен;
 *   - рос без ограничения → утечка памяти.
 *
 * @returns {Promise<{allowed: boolean, reason?: string, attempts?: number}>}
 */
async function acquireTaskRun(taskId) {
  const db = await getDb();
  const now = Date.now();

  try {
    const existing = await db.collection(COLLECTIONS.taskRuns).findOne({ taskId: String(taskId) });

    if (existing) {
      const age = now - new Date(existing.updatedAt || existing.startedAt || 0).getTime();

      if (existing.status === 'done') {
        return { allowed: false, reason: 'Задача уже выполнена. Сброс: /reset ' + taskId };
      }

      if (existing.status === 'running' && age < RUNNING_TTL_MS) {
        return { allowed: false, reason: `Уже выполняется (запущена ${Math.round(age / 1000)}с назад)` };
      }

      if (existing.status === 'error') {
        if ((existing.attempts || 0) >= MAX_TASK_ATTEMPTS) {
          return {
            allowed: false,
            reason: `Исчерпаны попытки (${existing.attempts}/${MAX_TASK_ATTEMPTS}). Сброс: /reset ${taskId}`,
          };
        }
        if (age < TASK_RETRY_COOLDOWN_MS) {
          return { allowed: false, reason: `Повтор через ${Math.round((TASK_RETRY_COOLDOWN_MS - age) / 1000)}с` };
        }
      }
      // status === 'running' && age >= TTL → процесс умер на середине, разрешаем перезапуск
    }

    const attempts = (existing?.attempts || 0) + 1;

    await db.collection(COLLECTIONS.taskRuns).updateOne(
      { taskId: String(taskId) },
      {
        $set: { status: 'running', attempts, startedAt: new Date(), updatedAt: new Date() },
        $setOnInsert: { taskId: String(taskId), createdAt: new Date() },
      },
      { upsert: true }
    );

    return { allowed: true, attempts };
  } catch (error) {
    // База недоступна — не блокируем работу, но логируем
    console.warn(`⚠️ acquireTaskRun: ${error.message}`);
    return { allowed: true, attempts: 1, degraded: true };
  }
}

async function finishTaskRun(taskId, status, extra = {}) {
  try {
    const db = await getDb();
    await db.collection(COLLECTIONS.taskRuns).updateOne(
      { taskId: String(taskId) },
      {
        $set: {
          status, // 'done' | 'error'
          updatedAt: new Date(),
          finishedAt: new Date(),
          ...extra,
        },
      },
      { upsert: true }
    );
  } catch (error) {
    console.warn(`⚠️ finishTaskRun: ${error.message}`);
  }
}

async function resetTaskRun(taskId) {
  const db = await getDb();
  const result = await db.collection(COLLECTIONS.taskRuns).deleteOne({ taskId: String(taskId) });
  return result.deletedCount > 0;
}

async function listTaskRuns(limit = 50) {
  const db = await getDb();
  return db.collection(COLLECTIONS.taskRuns).find({}).sort({ updatedAt: -1 }).limit(limit).toArray();
}

async function getTaskRun(taskId) {
  const db = await getDb();
  return db.collection(COLLECTIONS.taskRuns).findOne({ taskId: String(taskId) });
}

/* ------------------------------------------------------------------ */
/* Журнал запусков агента (для дашборда)                               */
/* ------------------------------------------------------------------ */

async function logAgentRun(entry) {
  try {
    const db = await getDb();
    const { insertedId } = await db.collection(COLLECTIONS.agentRuns).insertOne({
      startedAt: new Date(),
      ...entry,
    });
    return insertedId;
  } catch (error) {
    console.warn(`⚠️ logAgentRun: ${error.message}`);
    return null;
  }
}

async function updateAgentRun(runId, patch) {
  if (!runId) return;
  try {
    const db = await getDb();
    await db.collection(COLLECTIONS.agentRuns).updateOne(
      { _id: runId },
      { $set: { ...patch, finishedAt: new Date() } }
    );
  } catch (error) {
    console.warn(`⚠️ updateAgentRun: ${error.message}`);
  }
}

async function recentAgentRuns(limit = 20) {
  const db = await getDb();
  return db.collection(COLLECTIONS.agentRuns).find({}).sort({ startedAt: -1 }).limit(limit).toArray();
}

/* ------------------------------------------------------------------ */
/* Статистика                                                          */
/* ------------------------------------------------------------------ */

async function getStats() {
  const db = await getDb();

  const [tasksAgg, stepsCount, searchesCount, runs] = await Promise.all([
    db
      .collection(COLLECTIONS.results)
      .aggregate([{ $group: { _id: '$taskId' } }, { $count: 'n' }])
      .toArray(),
    db.collection(COLLECTIONS.results).countDocuments(),
    db.collection(COLLECTIONS.searchCache).estimatedDocumentCount(),
    db
      .collection(COLLECTIONS.taskRuns)
      .aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }])
      .toArray(),
  ]);

  const byStatus = runs.reduce((acc, row) => {
    acc[row._id || 'unknown'] = row.n;
    return acc;
  }, {});

  const totalRuns = Object.values(byStatus).reduce((a, b) => a + b, 0);

  return {
    tasksCount: tasksAgg[0]?.n || 0,
    stepsCount,
    searchesCount,
    runs: {
      total: totalRuns,
      done: byStatus.done || 0,
      running: byStatus.running || 0,
      error: byStatus.error || 0,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Whitelist Telegram-бота                                             */
/* ------------------------------------------------------------------ */

async function listAccess() {
  const db = await getDb();
  return db.collection(COLLECTIONS.botAccess).find({}).sort({ grantedAt: 1 }).toArray();
}

async function getAccess(chatId) {
  const db = await getDb();
  return db.collection(COLLECTIONS.botAccess).findOne({ chatId: String(chatId) });
}

async function grantAccess({ chatId, username, firstName, role = 'user', grantedBy = 'system', notes = '' }) {
  const db = await getDb();
  await db.collection(COLLECTIONS.botAccess).updateOne(
    { chatId: String(chatId) },
    {
      $set: {
        username: username || null,
        firstName: firstName || null,
        role,
        grantedBy: String(grantedBy),
        grantedAt: new Date(),
        notes,
      },
      $setOnInsert: { chatId: String(chatId) },
    },
    { upsert: true }
  );
  await db.collection(COLLECTIONS.botRequests).deleteOne({ chatId: String(chatId) });
  return getAccess(chatId);
}

async function revokeAccess(chatId) {
  const db = await getDb();
  const result = await db.collection(COLLECTIONS.botAccess).deleteOne({ chatId: String(chatId) });
  return result.deletedCount > 0;
}

async function listRequests() {
  const db = await getDb();
  return db.collection(COLLECTIONS.botRequests).find({}).sort({ firstSeenAt: -1 }).toArray();
}

async function registerRequest({ chatId, username, firstName, text }) {
  const db = await getDb();
  await db.collection(COLLECTIONS.botRequests).updateOne(
    { chatId: String(chatId) },
    {
      $set: {
        username: username || null,
        firstName: firstName || null,
        lastText: String(text || '').slice(0, 200),
        lastSeenAt: new Date(),
      },
      $inc: { hits: 1 },
      $setOnInsert: { chatId: String(chatId), firstSeenAt: new Date() },
    },
    { upsert: true }
  );
}

async function countAccess() {
  const db = await getDb();
  return db.collection(COLLECTIONS.botAccess).estimatedDocumentCount();
}

module.exports = {
  COLLECTIONS,
  INDEX_DEFINITIONS,
  createIndexes,
  connectToMongo,
  getDb,
  close,

  saveTaskStep,
  getTaskSteps,
  getTaskResults,
  saveChatHistory,

  getCachedSearch,
  cacheSearch,

  markWebhookEvent,

  acquireTaskRun,
  finishTaskRun,
  resetTaskRun,
  listTaskRuns,
  getTaskRun,

  logAgentRun,
  updateAgentRun,
  recentAgentRuns,

  getStats,

  listAccess,
  getAccess,
  grantAccess,
  revokeAccess,
  listRequests,
  registerRequest,
  countAccess,
};
