// task-executor-worker.js
// Забирает задачи из колонки «К выполнению» и запускает агента.
//
// Исправлено:
//  H3 — защита от повторного выполнения переехала из `new Set()` в MongoDB.
//       Прежний Set: (а) обнулялся при рестарте Render → все задачи из колонки
//       выполнялись заново; (б) навсегда блокировал упавшую задачу → повтор был
//       невозможен; (в) рос без ограничения → утечка памяти.
//       Теперь состояние персистентно, есть счётчик попыток и cooldown.
//  M4 — ответ агента больше не трактуется как успех по факту непустоты.
//       Строка «Превышен лимит шагов» раньше публиковалась как «✅ Задача выполнена».
//  M25 — защита от наложения интервалов: следующий опрос не стартует,
//        пока не завершился предыдущий.
//  M27 — задачи читаются с пагинацией, а не только первой страницей.

const { runAgent } = require('./ai-agent');
const executors = require('./tool-executors');
const db = require('./db');
const yougile = require('./lib/yougile-client');
const { config } = require('./lib/config');
const { notify } = require('./telegram-bot');

let timer = null;
let running = false;
let stopping = false;

/** Сколько задач берём в работу за один проход — защита от «съесть весь лимит API». */
const BATCH_SIZE = Number(process.env.TASK_BATCH_SIZE || 3);

async function executeTask(task) {
  const taskId = String(task.id);
  const title = task.title || '(без названия)';

  console.log(`▶️ Выполняю задачу ${taskId}: ${title}`);
  await notify.taskStarted({ title, taskId }).catch(() => {});

  try {
    await yougile.setStatus(taskId, 'Выполняется').catch((error) => {
      console.warn(`⚠️ Не удалось перевести в «Выполняется»: ${error.message}`);
    });

    await executors.addComment(taskId, '🤖 AI-агент начал выполнение задачи...').catch(() => {});

    const outcome = await runAgent(taskId, title, task.description || '');

    if (outcome.completed && outcome.text && outcome.text.trim()) {
      await executors.addComment(taskId, `✅ Задача выполнена:\n\n${outcome.text}`).catch(() => {});
      await yougile.setStatus(taskId, 'Готово').catch((error) => {
        console.warn(`⚠️ Не удалось перевести в «Готово»: ${error.message}`);
      });
      await db.finishTaskRun(taskId, 'done', { title });
      await notify.taskDone({ title, taskId, summary: outcome.text }).catch(() => {});
      console.log(`✅ Задача ${taskId} выполнена за ${outcome.steps} шагов`);
      return;
    }

    // Агент не довёл задачу до конца: лимит шагов, ошибка GLM, пустой ответ.
    // Раньше в этом случае всё равно писалось «✅ Задача выполнена».
    const reason = outcome.error || 'Агент не вернул содержательного результата';

    if (outcome.text && outcome.text.trim()) {
      await executors.addComment(taskId, `⚠️ Частичный результат:\n\n${outcome.text}\n\n❗ ${reason}`).catch(() => {});
    } else {
      await executors.addComment(taskId, `⚠️ Задача не завершена: ${reason}`).catch(() => {});
    }

    await yougile.setStatus(taskId, 'Ошибка').catch(() => {});
    await db.finishTaskRun(taskId, 'error', { title, error: reason });
    await notify.taskIncomplete({ title, taskId, reason }).catch(() => {});
    console.warn(`⚠️ Задача ${taskId} не завершена: ${reason}`);
  } catch (error) {
    console.error(`❌ Ошибка выполнения задачи ${taskId}: ${error.message}`);

    await executors.addComment(taskId, `❌ Ошибка: ${error.message}`).catch(() => {});
    await yougile.setStatus(taskId, 'Ошибка').catch(() => {});
    await db.finishTaskRun(taskId, 'error', { title, error: error.message });
    await notify.taskError({ title, taskId, error: error.message }).catch(() => {});
  }
}

async function checkTasksForExecution() {
  if (!config.columnToExecute) {
    console.warn('⚠️ COLUMN_TO_EXECUTE не задан — task-executor пропускает опрос');
    return;
  }

  if (!config.yougileApiKey) {
    console.warn('⚠️ YouGile API-ключ не задан — task-executor пропускает опрос');
    return;
  }

  let tasks;
  try {
    tasks = await yougile.listTasks({ columnId: config.columnToExecute }, { pageSize: 50, maxPages: 4 });
  } catch (error) {
    console.error(`❌ Не удалось получить список задач: ${error.message}`);
    return;
  }

  if (!tasks || tasks.length === 0) return;
  console.log(`📬 В колонке «К выполнению»: ${tasks.length} задач`);

  let started = 0;

  for (const task of tasks) {
    if (stopping) break;
    if (started >= BATCH_SIZE) {
      console.log(`⏸️ Достигнут лимит пачки (${BATCH_SIZE}), остальные — в следующем проходе`);
      break;
    }

    const taskId = String(task.id);

    const lock = await db.acquireTaskRun(taskId);
    if (!lock.allowed) {
      console.log(`⏭️ Задача ${taskId}: ${lock.reason}`);
      continue;
    }

    started++;
    // Последовательно: параллельные запуски агента упираются в rate limit GLM
    await executeTask(task);
  }
}

async function tick() {
  // Защита от наложения: опрос каждые 30 с, а выполнение задачи может идти минуты
  if (running) {
    console.log('⏳ Предыдущий проход ещё не завершился, пропускаем тик');
    return;
  }

  running = true;
  try {
    await checkTasksForExecution();
  } catch (error) {
    console.error(`❌ checkTasksForExecution: ${error.message}`);
  } finally {
    running = false;
  }
}

function startTaskExecutorWorker() {
  console.log(`🤖 Task executor worker запущен (каждые ${config.taskPollIntervalMs / 1000}с)`);
  console.log(`🔧 COLUMN_TO_EXECUTE: ${config.columnToExecute || '❌ НЕ ЗАДАН'}`);
  // Проверяем наличие ключа, но никогда не подставляем его значение в лог
  const hasKey = Boolean(config.yougileApiKey);
  console.log(`🔧 YouGile API-ключ: ${hasKey ? '✓ установлен' : '❌ НЕ УСТАНОВЛЕН'}`);

  timer = setInterval(tick, config.taskPollIntervalMs);
  tick().catch((error) => console.error(`❌ Первый проход task-executor: ${error.message}`));
}

function stopTaskExecutorWorker() {
  stopping = true;
  if (timer) clearInterval(timer);
}

module.exports = {
  startTaskExecutorWorker,
  stopTaskExecutorWorker,
  checkTasksForExecution,
  executeTask,
};
