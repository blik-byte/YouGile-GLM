// tool-executors.js
const { MongoClient } = require('mongodb');

const mongoClient = new MongoClient(process.env.MONGODB_URI);
let db;

async function initMongo() {
  await mongoClient.connect();
  db = mongoClient.db('ai_tasks');
}

// Поиск в интернете (используем бесплатный API)
async function webSearch(query) {
  // Вариант 1: DuckDuckGo Instant Answer API (бесплатно)
  const response = await fetch(
    `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json`
  );
  const data = await response.json();
  
  return {
    query,
    abstract: data.Abstract || 'Нет краткого описания',
    related: data.RelatedTopics?.slice(0, 5).map(t => t.Text) || []
  };
}

// Сохранение результата в MongoDB
async function saveResult(taskId, step, data) {
  if (!db) await initMongo();
  
  await db.collection('task_results').insertOne({
    taskId,
    step,
    data,
    timestamp: new Date()
  });
  
  return { success: true, message: `Результат шага "${step}" сохранён` };
}

// Обновление статуса задачи в YouGile
async function updateTaskStatus(taskId, status) {
  // ID колонок (замените на ваши)
  const COLUMN_IDS = {
    'Выполняется': 'id-column-executing',
    'Готово': 'id-column-done',
    'Ошибка': 'id-column-error'
  };
  
  const response = await fetch(
    `https://rocketup.yougile.com/api-v2/tasks/${taskId}`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.YOUGILE_API_KEY}`
      },
      body: JSON.stringify({
        columnId: COLUMN_IDS[status]
      })
    }
  );
  
  return { success: response.ok };
}

// Добавление комментария к задаче
async function addComment(taskId, text) {
  const response = await fetch(
    `https://rocketup.yougile.com/api-v2/tasks/${taskId}/chat`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.YOUGILE_API_KEY}`
      },
      body: JSON.stringify({ text })
    }
  );
  
  return { success: response.ok };
}

module.exports = {
  webSearch,
  saveResult,
  updateTaskStatus,
  addComment
};
