// task-executor-worker.js
const { runAgent } = require('./ai-agent');
const executors = require('./tool-executors');

// Защита от повторного выполнения одной задачи в течение сессии
const processedTasks = new Set();

async function checkTasksForExecution() {
  console.log(`🔍 Проверка задач... COLUMN_TO_EXECUTE: ${process.env.COLUMN_TO_EXECUTE}`);
  
  if (!process.env.COLUMN_TO_EXECUTE) {
    console.warn('⚠️ COLUMN_TO_EXECUTE не установлен!');
    return;
  }

  try {
    const url = `https://rocketup.yougile.com/api-v2/tasks?columnId=${process.env.COLUMN_TO_EXECUTE}`;
    console.log(`🌐 Запрос: ${url}`);
    
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${process.env.YOUGILE_GLM_API_KEY}`
      }
    });

    console.log(`📡 Статус ответа: ${response.status}`);
    
    const data = await response.json();
    console.log(`📦 Ответ API:`, JSON.stringify(data, null, 2).substring(0, 500));

    // Проверяем разные варианты структуры ответа
    const tasks = data.items || data.tasks || data || [];
    
    if (!Array.isArray(tasks) || tasks.length === 0) {
      console.log(`📭 Нет задач в колонке`);
      return;
    }

    console.log(`📬 Найдено ${tasks.length} задач для выполнения`);

    for (const task of tasks) {
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
  console.log('🤖 Task executor worker ЗАПУЩЕН (проверка каждые 30 сек)');
  console.log(`🔧 COLUMN_TO_EXECUTE: ${process.env.COLUMN_TO_EXECUTE}`);
  console.log(`🔧 YOUGILE_GLM_API_KEY: ${process.env.YOUGILE_GLM_API_KEY ? '✓ установлен' : '❌ НЕ УСТАНОВЛЕН'}`);
  
  setInterval(checkTasksForExecution, 30 * 1000);
  checkTasksForExecution();
}

module.exports = { startTaskExecutorWorker };
