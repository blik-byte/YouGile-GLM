// db.js
const { MongoClient } = require('mongodb');

let client;
let db;

async function connectToMongo() {
  if (db) return db; // уже подключены
  
  client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  db = client.db('ai_tasks');
  
  console.log('✅ MongoDB подключена');
  
  // Создаём индексы для быстрого поиска
  await db.collection('task_results').createIndex({ taskId: 1, timestamp: -1 });
  await db.collection('task_history').createIndex({ taskId: 1 });
  await db.collection('search_cache').createIndex({ query: 1 }, { unique: true });
  
  return db;
}

// Сохранение результата шага агента
async function saveTaskStep(taskId, step, data, metadata = {}) {
  const db = await connectToMongo();
  
  const result = await db.collection('task_results').insertOne({
    taskId,
    step,
    data,
    metadata,
    timestamp: new Date()
  });
  
  console.log(`💾 Шаг "${step}" сохранён для задачи ${taskId}`);
  return result.insertedId;
}

// Получить все шаги задачи
async function getTaskSteps(taskId) {
  const db = await connectToMongo();
  
  return await db.collection('task_results')
    .find({ taskId })
    .sort({ timestamp: 1 })
    .toArray();
}

// Сохранение истории переписки с GLM
async function saveChatHistory(taskId, messages) {
  const db = await connectToMongo();
  
  await db.collection('task_history').updateOne(
    { taskId },
    { 
      $set: { 
        messages, 
        updatedAt: new Date() 
      },
      $setOnInsert: { 
        taskId, 
        createdAt: new Date() 
      }
    },
    { upsert: true }
  );
}

// Кэширование поисковых запросов (чтобы не искать одно и то же)
async function getCachedSearch(query) {
  const db = await connectToMongo();
  
  const cached = await db.collection('search_cache').findOne({
    query: query.toLowerCase(),
    timestamp: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } // кэш на 7 дней
  });
  
  return cached?.result || null;
}

async function cacheSearch(query, result) {
  const db = await connectToMongo();
  
  await db.collection('search_cache').updateOne(
    { query: query.toLowerCase() },
    { 
      $set: { 
        query: query.toLowerCase(), 
        result, 
        timestamp: new Date() 
      }
    },
    { upsert: true }
  );
}

// Получить статистику
async function getStats() {
  const db = await connectToMongo();
  
  const tasksCount = await db.collection('task_results').distinct('taskId').length;
  const stepsCount = await db.collection('task_results').countDocuments();
  const searchesCount = await db.collection('search_cache').countDocuments();
  
  return { tasksCount, stepsCount, searchesCount };
}

module.exports = {
  connectToMongo,
  saveTaskStep,
  getTaskSteps,
  saveChatHistory,
  getCachedSearch,
  cacheSearch,
  getStats
};
