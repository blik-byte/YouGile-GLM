// task-executor-worker.js
const { runAgent } = require('./ai-agent');
const executors = require('./tool-executors');

// Защита от повторного выполнения одной задачи в течение сессии
const processedTasks = new Set();

async function checkTasksForExecution() {
  if (!process.env.COLUMN_TO_EXECUTE) {
    console.warn('⚠️ COLUMN_TO_EXECUTE не установлен');
    return;
  }

  try {
    const response = await fetch(
      `https://rocketup.yougile.com/api-v2/tasks?columnId=${process.env.COLUMN_TO_EXECUTE}`,
      {
        headers: {
          'Authorization': `Bearer ${process.env.YOUGILE_GLM_API_KEY}`
        }
      }
    );

    if (!response.ok) {
      console.error(`❌ YouGile error: ${response.status}`);
      return;
    }

    const tasks = await response.json();

    if (!tasks.items || tasks.items.length === 0) {
      return;
    }

    console.log(`📬 Найдено ${tasks.items.length} задач для выполнения`);

    for (const task of tasks.items) {
      // Защита от повторов
      if (processedTasks.has(task.id)) {
        console.log(`⏭️ Задача ${task.id} уже обрабатывается, пропускаем`);
        continue;
      }
      
      processedTasks.add(task.id);
      
      console.log(`▶️ Выполняю задачу: ${task.title}`);

      try {
        // Перемещаем в "Выполняется"
        const statusResult = await executors.updateTaskStatus(task.id, 'Выполняется');
        if (!statusResult.success) {
          console.warn(`⚠️ Не удалось обновить статус: ${statusResult.error}`);
        }
        
        await executors.addComment(task.id, '🤖 AI-агент начал выполнение задачи...');

        // Запускаем агента
        const result = await runAgent(task.id, task.title, task.description || '');
        
        await executors.addComment(task.id, `✅ Задача выполнена:\n\n${result}`);
        console.log(`✅ Задача ${task.id} выполнена`);
        
      } catch (error) {
        console.error(`❌ Ошибка выполнения задачи ${task.id}:`, error.message);
        await executors.updateTaskStatus(task.id, 'Ошибка');
        await executors.addComment(task.id, `❌ Ошибка: ${error.message}`);
      }
    }
  } catch (error) {
    console.error(`❌ Ошибка checkTasksForExecution: ${error.message}`);
  }
}

function startTaskExecutorWorker() {
  console.log('🤖 Task executor worker запущен (проверка каждые 30 сек)');
  
  setInterval(checkTasksForExecution, 30 * 1000);
  checkTasksForExecution();
}

module.exports = { startTaskExecutorWorker };
