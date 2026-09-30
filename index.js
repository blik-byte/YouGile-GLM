// index.js
// HTTP-сервер (вебхуки + служебные эндпоинты) и точка запуска всех воркеров.
//
// Исправлено:
//  C2 — вебхук больше НЕ обрабатывает задачу внутри HTTP-запроса. Раньше агент
//       запускался синхронно и мог работать минуты; YouGile не дожидался ответа,
//       рвал соединение и присылал событие повторно → дубли ответов в чате.
//       Теперь сразу отдаём 200, обработка идёт в фоне, дедупликация — в MongoDB
//       (прежняя in-memory на 10 секунд не переживала ретраи и рестарты).
//  H6 — служебные эндпоинты закрыты токеном. Прежде POST /assistant позволял
//       любому человеку из интернета создавать задачи в вашем YouGile и тратить
//       токены GLM, а GET /find-glm-user отдавал наружу email пользователей.
//  H7 — везде используется один ключ YouGile (через lib/yougile-client).
//       Раньше /columns и /find-glm-user брали YOUGILE_API_KEY, остальной код —
//       YOUGILE_GLM_API_KEY, и при незаполненной переменной отдавали 401.
//  H8 — ежедневный отчёт считается по реальному часовому поясу (REPORT_TZ),
//       а не по UTC, в котором живут контейнеры Render.
//  H9 — graceful shutdown: SIGTERM/SIGINT корректно останавливают воркеров.
//  M29 — увеличен лимит тела запроса для крупных вебхуков.
//  M31 — воркеры стартуют только после успешного подключения к базе.

require('dotenv').config();

const path = require('path');

const express = require('express');
const cors = require('cors');

const { config, validate } = require('./lib/config');
const dashboard = require('./lib/dashboard');
const db = require('./db');
const yougile = require('./lib/yougile-client');
const { chatJson } = require('./lib/glm-client');
const { escapeTelegram } = require('./lib/text');

const { startEmailWorker, stopEmailWorker, processMail, createYougileTask } = require('./email-worker');
const { startTaskExecutorWorker, stopTaskExecutorWorker } = require('./task-executor-worker');
const { initBot, stopBot, sendNotification } = require('./telegram-bot');
const { runAgentForQuestion } = require('./ai-agent');

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(cors());

/* ------------------------------------------------------------------ */
/* Авторизация служебных эндпоинтов                                    */
/* ------------------------------------------------------------------ */

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function requireAdmin(req, res, next) {
  if (!config.adminToken) {
    return res.status(503).json({
      success: false,
      error: 'ADMIN_TOKEN не задан в переменных окружения — служебные эндпоинты отключены',
    });
  }

  const provided = req.get('x-admin-token') || req.query.token || '';
  if (!timingSafeEqual(provided, config.adminToken)) {
    return res.status(401).json({ success: false, error: 'Неверный токен' });
  }

  return next();
}

/* ------------------------------------------------------------------ */
/* Публичные эндпоинты                                                 */
/* ------------------------------------------------------------------ */

// Дашборд. Отдаётся без авторизации — сам по себе HTML не содержит данных,
// всё запрашивается через /api/* с токеном. Важно, что маршрут всегда отвечает
// 200: его пингует cron-job.org, чтобы бесплатный dyno Render не засыпал.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check для мониторинга — лёгкий, без обращения к внешним сервисам
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'yougile-glm',
    uptimeSec: Math.round(process.uptime()),
    node: process.version,
    timestamp: new Date().toISOString(),
  });
});

// Полный снимок состояния системы для дашборда
app.get('/api/dashboard', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 15, 100);
    res.json(await dashboard.collect({ limit }));
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/* ------------------------------------------------------------------ */
/* Служебные эндпоинты (закрыты ADMIN_TOKEN)                           */
/* ------------------------------------------------------------------ */

app.get('/task-results/:taskId', requireAdmin, async (req, res) => {
  try {
    const results = await db.getTaskResults(req.params.taskId);
    res.json({ success: true, count: results.length, results });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/columns', requireAdmin, async (req, res) => {
  try {
    res.json({ success: true, columns: await yougile.listColumns() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/** Отладочный: помогает найти ID пользователя-агента в YouGile. */
app.get('/find-glm-user', requireAdmin, async (req, res) => {
  try {
    const tasks = await yougile.listTasks({}, { pageSize: 50, maxPages: 1 });
    const users = new Map();

    for (const task of tasks) {
      const person = task.responsible;
      if (person?.email && /ai\.assistant|ai@/i.test(person.email)) {
        users.set(person.id, { id: person.id, name: person.name, email: person.email });
      }
      for (const assignee of task.assigned || []) {
        if (assignee?.email && /ai\.assistant|ai@/i.test(assignee.email)) {
          users.set(assignee.id, { id: assignee.id, name: assignee.name, email: assignee.email });
        }
      }
    }

    res.json({ success: true, glmUsers: [...users.values()] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/assistant', requireAdmin, async (req, res) => {
  try {
    const userInput = String(req.body?.text || '').trim();
    if (!userInput) {
      return res.status(400).json({ success: false, error: 'Пустое поле text' });
    }

    const taskData = await chatJson(
      `Верни ТОЛЬКО JSON без пояснений.
Формат:
{
  "title": "краткое название задачи",
  "task_type": "тип",
  "result": "что получится в итоге",
  "estimated_time": "оценка времени",
  "steps": ["шаг 1", "шаг 2", "шаг 3"]
}`,
      userInput
    );

    if (!taskData.title) {
      return res.status(422).json({ success: false, error: 'Модель не вернула title', analysis: taskData });
    }

    const task = await createYougileTask(taskData);
    console.log(`✅ Задача создана: «${taskData.title}» → YouGile ID ${task.id}`);

    res.json({ success: true, taskId: task.id, analysis: taskData });
  } catch (error) {
    console.error(`❌ /assistant: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/process-mail', requireAdmin, async (req, res) => {
  try {
    const created = await processMail();
    res.json({ success: true, created });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/db-check', requireAdmin, async (req, res) => {
  try {
    await db.connectToMongo();
    res.json({ success: true, stats: await db.getStats() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/stats', requireAdmin, async (req, res) => {
  try {
    res.json({ success: true, stats: await db.getStats() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/runs', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    res.json({ success: true, runs: await db.listTaskRuns(limit) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Снять блокировку с задачи, чтобы агент взял её заново
// (например, если процесс перезапустился посреди выполнения)
async function resetRunHandler(req, res) {
  try {
    const removed = await db.resetTaskRun(req.params.taskId);
    res.json({ success: true, removed });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

app.post('/runs/:taskId/reset', requireAdmin, resetRunHandler);
app.post('/api/runs/:taskId/reset', requireAdmin, resetRunHandler);

/* ------------------------------------------------------------------ */
/* Вебхук YouGile                                                      */
/* ------------------------------------------------------------------ */

/**
 * Обработка сообщения в чате задачи — выполняется В ФОНЕ.
 * YouGile ждёт ответа несколько секунд, а агент работает минуты, поэтому
 * ждать завершения внутри обработчика нельзя: сервер рвёт соединение
 * и присылает событие повторно.
 */
async function handleChatMessage(event) {
  const { text, chatId, id: messageId } = event;

  try {
    const task = await yougile.getTask(chatId);
    if (!task) {
      console.warn(`⚠️ Задача ${chatId} не найдена, пропускаем`);
      return;
    }

    if (!task.completed) {
      console.log(`⏭️ Задача ${chatId} ещё не выполнена — на вопросы не отвечаем`);
      return;
    }

    const messages = await yougile.getChatMessages(chatId);

    const userMessages = messages.filter((msg) => {
      const isAi =
        msg.label === 'AI' ||
        String(msg.text || '').includes('🤖 AI-агент') ||
        String(msg.text || '').includes('💡 Ответ:') ||
        /ai\.assistant|ai@/i.test(String(msg.author?.email || ''));
      return !isAi && String(msg.text || '').trim();
    });

    if (userMessages.length === 0) {
      console.log(`⚠️ В чате ${chatId} нет пользовательских сообщений`);
      return;
    }

    const chatContext = userMessages
      .slice(-10)
      .map((msg) => `${msg.author?.name || msg.sender?.name || 'Пользователь'}: ${msg.text}`)
      .join('\n');

    console.log(`🤖 Отвечаю на вопрос в задаче ${chatId} (контекст ${chatContext.length} симв.)`);

    await executorsAddComment(chatId, '🤖 AI-агент обрабатывает ваш вопрос...');

    const answer = await runAgentForQuestion(chatId, task.title, task.description || '', chatContext);

    await executorsAddComment(chatId, `💡 Ответ:\n\n${answer}`);
    console.log(`✅ Ответ отправлен в чат задачи ${chatId}`);
  } catch (error) {
    console.error(`❌ Обработка сообщения в задаче ${chatId}: ${error.message}`);
    try {
      await executorsAddComment(chatId, `⚠️ Не удалось подготовить ответ: ${error.message}`);
    } catch {
      /* уже не важно */
    }
  }
}

// Импортируем лениво, чтобы не замыкать цикл зависимостей на старте
async function executorsAddComment(taskId, text) {
  const executors = require('./tool-executors');
  return executors.addComment(taskId, text);
}

app.post('/webhook/yougile', async (req, res) => {
  const event = req.body || {};

  // Отвечаем СРАЗУ — до всякой обработки
  res.json({ success: true });

  if (event.event !== 'chat_message-created') return;

  const payload = event.payload || {};
  const { text, chatId, label, id: messageId, properties } = payload;

  try {
    // Дедупликация в MongoDB: переживает рестарты и любые интервалы ретраев
    const isNew = await db.markWebhookEvent(messageId);
    if (!isNew) {
      console.log(`⏭️ Вебхук ${messageId} уже обработан, пропускаем`);
      return;
    }

    if (properties?.fromSystem || properties?.move) return;

    // Не отвечаем сами себе
    if (label === 'AI' || String(text || '').includes('🤖 AI-агент') || String(text || '').includes('💡 Ответ:')) {
      return;
    }

    if (!String(text || '').trim() || text === '.') return;

    console.log(`💬 Сообщение в чате ${chatId}: ${String(text).slice(0, 100)}`);
    await handleChatMessage(payload);
  } catch (error) {
    console.error(`❌ Обработка вебхука: ${error.message}`);
  }
});

/* ------------------------------------------------------------------ */
/* Ежедневный отчёт                                                    */
/* ------------------------------------------------------------------ */

const REPORT_TZ = process.env.REPORT_TZ || 'Europe/Moscow';
const REPORT_HOUR = Number(process.env.REPORT_HOUR || 9);
let lastReportDate = null;

function partsInTimezone(date = new Date(), timeZone = REPORT_TZ) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parts = Object.fromEntries(formatter.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    display: `${parts.day}.${parts.month}.${parts.year}`,
  };
}

async function sendDailyReport() {
  const { display } = partsInTimezone();

  const columns = {
    '🔄 К выполнению': config.columnToExecute,
    '⚙️ Выполняется': config.columnExecuting,
    '⏳ Ждут подтверждения': config.columnAwaitingConfirmation,
    '✅ Готово': config.columnDone,
    '❌ Ошибка': config.columnError,
  };

  const counts = await yougile.countByColumn(columns);

  let report = `📊 <b>Ежедневный отчёт</b>\n📅 ${escapeTelegram(display)}\n\n`;
  for (const [name, value] of Object.entries(counts)) {
    if (typeof value === 'number') report += `${escapeTelegram(name)}: ${value}\n`;
  }

  try {
    const stats = await db.getStats();
    report +=
      `\n🗄️ <b>База агента</b>\n` +
      `Выполнено задач: ${stats.runs.done}\n` +
      `С ошибками: ${stats.runs.error}\n` +
      `Сохранено шагов: ${stats.stepsCount}`;
  } catch {
    /* база недоступна — отчёт всё равно отправим */
  }

  await sendNotification(report);
}

function startReportScheduler() {
  setInterval(() => {
    const { hour, minute, dateKey } = partsInTimezone();

    if (hour === REPORT_HOUR && minute < 5 && lastReportDate !== dateKey) {
      lastReportDate = dateKey;
      sendDailyReport().catch((error) => console.error(`❌ Ошибка ежедневного отчёта: ${error.message}`));
    }
  }, 60 * 1000);

  console.log(`📅 Ежедневный отчёт в ${REPORT_HOUR}:00 (${REPORT_TZ})`);
}

/* ------------------------------------------------------------------ */
/* Запуск                                                              */
/* ------------------------------------------------------------------ */

let server = null;
let shuttingDown = false;

async function start() {
  console.log('🚀 Запуск YouGile AI Agent...');

  const { missing, warnings } = validate();
  for (const warning of warnings) console.warn(`⚠️ ${warning}`);
  if (missing.length > 0) {
    console.error(`❌ Отсутствуют обязательные переменные: ${missing.join(', ')}`);
    console.error('   Сервер будет запущен в ограниченном режиме.');
  }

  // База нужна всем: дедупликация вебхуков, блокировки задач, whitelist бота
  try {
    await db.connectToMongo();
  } catch (error) {
    console.error(`❌ Не удалось подключиться к MongoDB: ${error.message}`);
    console.error('   Продолжаю без базы — дедупликация и whitelist будут деградировать.');
  }

  server = app.listen(config.port, () => {
    console.log(`✅ HTTP-сервер на порту ${config.port}`);
  });

  server.on('error', (error) => {
    console.error(`❌ Ошибка HTTP-сервера: ${error.message}`);
  });

  initBot();
  await startEmailWorker();
  startTaskExecutorWorker();
  startReportScheduler();

  // Подписка на вебхуки — идемпотентная, дубли больше не создаются
  yougile
    .ensureWebhook('chat_message-created')
    .catch((error) => console.error(`❌ Подписка на вебхуки: ${error.message}`));

  console.log('✅ Все воркеры запущены');
}

/**
 * Graceful shutdown.
 * Render отправляет SIGTERM при каждом деплое и при уходе в спячку.
 * Без обработчика процесс убивался мгновенно: задачи обрывались на середине,
 * соединения MongoDB не закрывались, письма оставались в промежуточном состоянии.
 */
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n🛑 Получен ${signal}, останавливаюсь...`);

  const forceExit = setTimeout(() => {
    console.error('⚠️ Принудительный выход по истечении 25с');
    process.exit(1);
  }, 25000);
  forceExit.unref();

  try {
    stopTaskExecutorWorker();
    await stopEmailWorker();
    stopBot();

    if (server) {
      await new Promise((resolve) => server.close(resolve));
      console.log('🔌 HTTP-сервер остановлен');
    }

    await db.close();
  } catch (error) {
    console.error(`⚠️ Ошибка при остановке: ${error.message}`);
  }

  clearTimeout(forceExit);
  console.log('👋 Завершено');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Последняя линия защиты: раньше любое необработанное исключение
// (например, polling_error Telegram-бота) молча роняло процесс.
process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled rejection:', reason instanceof Error ? reason.stack : reason);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught exception:', error.stack || error.message);
  // Не выходим сразу: даём فرصة отправить ошибку и завершить текущую задачу
  setTimeout(() => process.exit(1), 1000).unref();
});

start().catch((error) => {
  console.error(`❌ Критическая ошибка запуска: ${error.stack || error.message}`);
  process.exit(1);
});

module.exports = { app, start, shutdown };
