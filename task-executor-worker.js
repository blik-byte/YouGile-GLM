// task-executor-worker.js
const { ImapFlow } = require('imapflow');
const { runAgent } = require('./ai-agent');
const executors = require('./tool-executors');

async function checkTasksForExecution() {
  // Получаем задачи из колонки "К выполнению"
  const response = await fetch(
    `https://rocketup.yougile.com/api-v2/tasks?columnId=${process.env.COLUMN_TO_EXECUTE}`,
    {
      headers: {
        'Authorization': `Bearer ${process.env.YOUGILE_API_KEY}`
      }
    }
  );

  const tasks = await response.json();

  if (!tasks.items || tasks.items.length === 0) {
    // ❌ Убрали console.log — тишина в логах
    return;
  }

  console.log(`📬 Найдено ${tasks.items.length} задач для выполнения`);

  for (const task of tasks.items) {
    console.log(`▶️ Выполняю задачу: ${task.title}`);

    // Перемещаем в "Выполняется"
    await executors.updateTaskStatus(task.id, 'Выполняется');
    await executors.addComment(task.id, '🤖 AI-агент начал выполнение задачи...');

    try {
      // Запускаем агента
      const result = await runAgent(task.id, task.title, task.description);
      
      await executors.addComment(task.id, `✅ Задача выполнена:\n\n${result}`);
      console.log(`✅ Задача ${task.id} выполнена`);
    } catch (error) {
      console.error(`❌ Ошибка выполнения задачи ${task.id}:`, error);
      await executors.updateTaskStatus(task.id, 'Ошибка');
      await executors.addComment(task.id, `❌ Ошибка: ${error.message}`);
    }
  }
}

function startTaskExecutorWorker() {
  console.log('🤖 Task executor worker запущен (проверка каждые 30 сек)');
  
  // Проверка каждые 30 секунд
  setInterval(checkTasksForExecution, 30 * 1000);
  
  // Первая проверка сразу
  checkTasksForExecution();
}

module.exports = { startTaskExecutorWorker };
