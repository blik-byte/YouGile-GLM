// lib/review-poller.js
// Резервный канал петли приёмки: сервис сам проверяет чаты задач на решения.
//
// Зачем: вебхук YouGile не доходит до сервиса (с 2026-10-23 все доставки падают,
// входящий счётчик /health показывает 0). Вместо того чтобы зависеть от входящих
// соединений, раз в две минуты просматриваем чаты незакрытых задач, назначенных
// человеку, и ищем там «ок» / «не ок».
//
// Что проверяем: только задачи, где есть исполнитель и которые не закрыты —
// обычно это одна-две карточки, а не все 60.

'use strict';

const review = require('./review-loop');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} options
 * @param {object} options.admin — lib/yougile-admin
 * @param {object} options.yougile — lib/yougile-client
 * @param {string} options.projectTitle — какой проект смотреть
 * @param {object} options.deps — completeTask / addComment / notify
 */
function createReviewPoller({ admin, yougile, projectTitle = 'AI агенты и YG', deps = {}, pauseMs = 300 }) {
  const seen = new Map(); // taskId -> id последнего обработанного сообщения
  let running = false;

  async function pollOnce() {
    const project = (await admin.listProjects()).find((item) => item.title === projectTitle);
    if (!project) return { tasks: 0, decisions: 0, handled: 0 };

    let tasks = 0;
    let decisions = 0;
    let handled = 0;

    const boards = await admin.listBoards(project.id);
    for (const board of boards) {
      const columns = await admin.listColumns(board.id);
      for (const column of columns) {
        const items = await admin.listTasks(column.id);
        for (const task of items) {
          if (task.completed) continue;
          if (!Array.isArray(task.assigned) || task.assigned.length === 0) continue;

          tasks += 1;
          const messages = await yougile.getChatMessages(task.id);
          if (pauseMs) await sleep(pauseMs);

          const last = [...(messages || [])].reverse().find((message) => String(message.text || '').trim());
          if (!last || review.isAiMessage(last)) continue;
          if (!review.classify(last.text)) continue;

          decisions += 1;
          // Сравниваем только при наличии id: у сообщений без id сравнение
          // undefined === undefined ложно считало бы решение уже обработанным.
          if (last.id && seen.get(task.id) === last.id) continue;

          const result = await review.handleReviewMessage({
            taskId: task.id,
            taskTitle: task.title,
            completed: Boolean(task.completed),
            text: last.text,
            messages,
            deps,
          });

          seen.set(task.id, last.id);
          if (result.handled) handled += 1;
        }
      }
    }

    return { tasks, decisions, handled };
  }

  /** Опрос по таймеру; повторный запуск не наслаивается на предыдущий. */
  function start({ intervalMs = 120000, logger = console } = {}) {
    const timer = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        const stats = await pollOnce();
        if (stats.handled) {
          logger.log(`✅ петля приёмки: решений обработано ${stats.handled} (задач проверено ${stats.tasks})`);
        }
      } catch (error) {
        logger.warn(`⚠️ петля приёмки: ${error.message}`);
      } finally {
        running = false;
      }
    }, intervalMs);

    if (timer.unref) timer.unref();
    return timer;
  }

  return { pollOnce, start, seen };
}

/** Запуск из index.js: настройки берём из переменных окружения. */
function startReviewPoller({ notify } = {}) {
  const intervalMs = Number(process.env.REVIEW_POLL_INTERVAL_MS || 120000);
  if (!intervalMs || intervalMs < 15000) {
    console.log('ℹ️ петля приёмки: опрос отключён (REVIEW_POLL_INTERVAL_MS)');
    return null;
  }

  const admin = require('./yougile-admin');
  const yougile = require('./yougile-client');

  const poller = createReviewPoller({
    admin,
    yougile,
    projectTitle: process.env.REVIEW_POLL_PROJECT || 'AI агенты и YG',
    deps: {
      completeTask: (taskId) =>
        yougile.request('PUT', `/tasks/${encodeURIComponent(taskId)}`, { body: { completed: true } }),
      addComment: (taskId, text) => require('../tool-executors').addComment(taskId, text),
      notify: notify || (async () => {}),
    },
  });

  console.log(`👀 Петля приёмки: опрос чатов каждые ${Math.round(intervalMs / 1000)} с`);
  return poller.start({ intervalMs });
}

module.exports = { createReviewPoller, startReviewPoller };
