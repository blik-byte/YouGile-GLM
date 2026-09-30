// telegram-bot.js
// Telegram-бот: управление агентом + уведомления.
//
// Исправлено:
//  C3 — добавлен обработчик polling_error. Без него любая сетевая ошибка
//       Telegram эмитилась как unhandled 'error' event и убивала ВЕСЬ процесс
//       (вместе с почтовым воркером, task-executor'ом и вебхуками).
//  H5 — весь динамический текст экранируется перед отправкой с parse_mode: 'HTML'.
//       Раньше символ '<' в заголовке задачи приводил к "Can't parse entities",
//       и уведомление молча терялось.
//  M18 — добавлен whitelist: бот больше не принимает команды от посторонних.
//  M19 — текстовое сообщение без доступа не создаёт задачу.

const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');
const { config } = require('./lib/config');
const { escapeTelegram, toStr } = require('./lib/text');
const yougile = require('./lib/yougile-client');

let bot = null;

/* ------------------------------------------------------------------ */
/* Доступ (whitelist)                                                  */
/* ------------------------------------------------------------------ */

/**
 * Как устроен whitelist — см. также README.
 *
 * Есть два источника прав:
 *   1. TELEGRAM_ADMIN_IDS — переменная окружения, список chat ID через запятую.
 *      Это «неотзываемые» администраторы: даже если случайно удалить всех из базы,
 *      доступ по этому списку останется. Заодно он защищает от блокировки самого себя.
 *   2. Коллекция bot_access в MongoDB — её можно править командами бота,
 *      без передеплоя: /allow, /deny, /who.
 *
 * Режимы:
 *   STRICT — включается автоматически, как только задан TELEGRAM_ADMIN_IDS
 *            ИЛИ в базе появился хотя бы один разрешённый пользователь.
 *            Все остальные получают отказ и видят свой ID, чтобы его можно было
 *            разрешить одной командой.
 *   OPEN   — пока ни админов, ни записей в базе нет (первый запуск).
 *            Бот работает для всех, но loudly предупреждает в логах и присылает
 *            уведомление. Сделано специально, чтобы нельзя было заблокировать
 *            себя сразу после деплоя.
 */
const ADMIN_IDS = new Set(config.telegramAdminIds);

let strictMode = ADMIN_IDS.size > 0;

function isAdmin(chatId) {
  return ADMIN_IDS.has(String(chatId));
}

async function resolveAccess(chatId) {
  const id = String(chatId);

  if (ADMIN_IDS.has(id)) return { allowed: true, role: 'admin', source: 'env' };

  try {
    const record = await db.getAccess(id);
    if (record) return { allowed: true, role: record.role || 'user', source: 'db' };

    // Определяем режим: если в базе кто-то уже есть — режим строгий
    const total = await db.countAccess();
    if (total > 0) {
      strictMode = true;
      return { allowed: false, role: null, source: null, strict: true };
    }
  } catch (error) {
    console.warn(`⚠️ Не удалось проверить whitelist (БД недоступна): ${error.message}`);
    // При недоступной базе не блокируем владельца, но и не открываем всем:
    // разрешаем только если админов нет вовсе (режим OPEN)
    if (ADMIN_IDS.size > 0) return { allowed: false, role: null, source: null, degraded: true };
  }

  if (!strictMode) return { allowed: true, role: 'user', source: 'open-mode' };
  return { allowed: false, role: null, source: null, strict: true };
}

/** Уведомить всех администраторов. */
async function notifyAdmins(message) {
  if (!bot) return;
  const targets = new Set(ADMIN_IDS);
  if (config.telegramChatId) targets.add(config.telegramChatId);

  for (const chatId of targets) {
    try {
      await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
    } catch (error) {
      console.warn(`⚠️ Не удалось уведомить админа ${chatId}: ${error.message}`);
    }
  }
}

/** Обработка запроса от пользователя без доступа. */
async function handleUnauthorized(msg) {
  const chatId = String(msg.chat.id);
  const username = msg.from?.username ? `@${msg.from.username}` : 'без username';
  const name = toStr(msg.from?.first_name) || 'Неизвестный';

  try {
    await db.registerRequest({
      chatId,
      username: msg.from?.username || null,
      firstName: msg.from?.first_name || null,
      text: msg.text,
    });
  } catch (error) {
    console.warn(`⚠️ Не удалось записать запрос доступа: ${error.message}`);
  }

  await safeSendMessage(
    chatId,
    `🔒 <b>Доступ запрещён</b>\n\n` +
      `Этот бот приватный. Ваш chat ID: <code>${escapeTelegram(chatId)}</code>\n\n` +
      `Передайте администратору команду:\n<code>/allow ${escapeTelegram(chatId)}</code>\n\n` +
      `${escapeTelegram(name)} ${escapeTelegram(username)}`
  );

  await notifyAdmins(
    `🔒 <b>Запрос доступа к боту</b>\n\n` +
      `👤 ${escapeTelegram(name)} ${escapeTelegram(username)}\n` +
      `🆔 <code>${escapeTelegram(chatId)}</code>\n` +
      `💬 ${escapeTelegram(toStr(msg.text).slice(0, 120))}\n\n` +
      `Разрешить: <code>/allow ${escapeTelegram(chatId)}</code>`
  );
}

/* ------------------------------------------------------------------ */
/* Отправка сообщений                                                  */
/* ------------------------------------------------------------------ */

async function safeSendMessage(chatId, text, options = {}) {
  if (!bot) return null;
  try {
    return await bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...options });
  } catch (error) {
    // Повтор без разметки — если Telegram не смог разобрать HTML
    if (/can't parse|parse entities/i.test(error.message)) {
      try {
        return await bot.sendMessage(chatId, text.replace(/<[^>]*>/g, ''));
      } catch (retryError) {
        console.error(`❌ Telegram (без разметки): ${retryError.message}`);
      }
    } else {
      console.error(`❌ Telegram sendMessage: ${error.message}`);
    }
    return null;
  }
}

/**
 * Публичное уведомление (используется другими модулями).
 * Динамические значения ОБЯЗАТЕЛЬНО экранируются — иначе Telegram отклоняет
 * сообщение с parse_mode: 'HTML' и уведомление теряется.
 */
async function sendNotification(message) {
  if (!bot || !config.telegramChatId) {
    console.log('⚠️ Telegram-бот не инициализирован или TELEGRAM_CHAT_ID не задан');
    return null;
  }
  return safeSendMessage(config.telegramChatId, message);
}

/** Готовые шаблоны уведомлений с автоматическим экранированием. */
const notify = {
  taskCreatedFromEmail: ({ title, count }) =>
    sendNotification(
      `📧 <b>Новая задача из email!</b>\n\n📝 ${escapeTelegram(title)}\n📊 Создано задач: ${escapeTelegram(count)}`
    ),

  taskStarted: ({ title, taskId }) =>
    sendNotification(
      `▶️ <b>Задача запущена</b>\n\n📝 ${escapeTelegram(title)}\n🆔 <code>${escapeTelegram(taskId)}</code>`
    ),

  taskDone: ({ title, taskId, summary }) =>
    sendNotification(
      `✅ <b>Задача выполнена!</b>\n\n📝 ${escapeTelegram(title)}\n🆔 <code>${escapeTelegram(taskId)}</code>` +
        (summary ? `\n\n${escapeTelegram(String(summary).slice(0, 900))}` : '')
    ),

  taskIncomplete: ({ title, taskId, reason }) =>
    sendNotification(
      `⚠️ <b>Задача не завершена полностью</b>\n\n📝 ${escapeTelegram(title)}\n` +
        `🆔 <code>${escapeTelegram(taskId)}</code>\n❗ ${escapeTelegram(reason)}`
    ),

  taskError: ({ title, taskId, error }) =>
    sendNotification(
      `❌ <b>Ошибка выполнения задачи!</b>\n\n📝 ${escapeTelegram(title)}\n` +
        `🆔 <code>${escapeTelegram(taskId)}</code>\n⚠️ ${escapeTelegram(error)}`
    ),

  dailyReport: (text) => sendNotification(text),
};

/* ------------------------------------------------------------------ */
/* Команды                                                             */
/* ------------------------------------------------------------------ */

const HELP_TEXT =
  `📚 <b>Команды</b>\n\n` +
  `/task &lt;текст&gt; — создать задачу\n` +
  `/status — статус задач\n` +
  `/reset &lt;taskId&gt; — снять блокировку с задачи и разрешить повтор\n` +
  `/who — кто имеет доступ к боту\n` +
  `/allow &lt;chatId&gt; — разрешить доступ\n` +
  `/deny &lt;chatId&gt; — запретить доступ\n` +
  `/help — эта справка\n\n` +
  `💡 Можно просто написать задачу текстом — она создастся автоматически.`;

async function requireAdmin(msg) {
  const chatId = String(msg.chat.id);
  const access = await resolveAccess(chatId);

  if (!access.allowed) {
    await handleUnauthorized(msg);
    return false;
  }

  const isRecordAdmin = access.role === 'admin';
  if (!isAdmin(chatId) && !isRecordAdmin) {
    await safeSendMessage(chatId, `🔒 Команда доступна только администраторам.`);
    return false;
  }
  return true;
}

function registerHandlers() {
  bot.onText(/\/start(?:@\w+)?$/, async (msg) => {
    const chatId = String(msg.chat.id);
    const access = await resolveAccess(chatId);

    await safeSendMessage(
      chatId,
      `👋 Привет! Я AI-агент YouGile.\n\n` +
        `🆔 Ваш chat ID: <code>${escapeTelegram(chatId)}</code>\n` +
        `🔐 Доступ: ${access.allowed ? `разрешён (${access.role})` : 'запрещён'}\n` +
        `🛡️ Режим whitelist: ${strictMode ? 'строгий' : 'открыт (никто не настроен)'}\n\n` +
        HELP_TEXT
    );

    // Сразу регистрируем владельца как админа, если он указан в окружении
    if (isAdmin(chatId)) {
      try {
        await db.grantAccess({
          chatId,
          username: msg.from?.username,
          firstName: msg.from?.first_name,
          role: 'admin',
          grantedBy: 'env:TELEGRAM_ADMIN_IDS',
          notes: 'Автоматически из TELEGRAM_ADMIN_IDS',
        });
      } catch (error) {
        console.warn(`⚠️ Не удалось закрепить админа в БД: ${error.message}`);
      }
    }
  });

  bot.onText(/\/help(?:@\w+)?/, async (msg) => {
    const chatId = String(msg.chat.id);
    if (!(await resolveAccess(chatId)).allowed) return handleUnauthorized(msg);
    await safeSendMessage(chatId, HELP_TEXT);
  });

  bot.onText(/\/who(?:@\w+)?/, async (msg) => {
    if (!(await requireAdmin(msg))) return;
    const chatId = String(msg.chat.id);

    let lines = [`👥 <b>Доступ к боту</b>\n`];

    if (ADMIN_IDS.size > 0) {
      lines.push(`🛡️ Админы из TELEGRAM_ADMIN_IDS: ${[...ADMIN_IDS].map((id) => `<code>${escapeTelegram(id)}</code>`).join(', ')}`);
    }

    try {
      const access = await db.listAccess();
      if (access.length === 0) lines.push(`\nВ базе нет записей.`);
      for (const entry of access) {
        lines.push(
          `• <code>${escapeTelegram(entry.chatId)}</code> — ${escapeTelegram(entry.firstName || '?')} ` +
            `${entry.username ? '@' + escapeTelegram(entry.username) : ''} (${escapeTelegram(entry.role)})`
        );
      }

      const requests = await db.listRequests();
      if (requests.length > 0) {
        lines.push(`\n⏳ <b>Запросы доступа (${requests.length}):</b>`);
        for (const req of requests.slice(0, 10)) {
          lines.push(
            `• ${escapeTelegram(req.firstName || '?')} ${req.username ? '@' + escapeTelegram(req.username) : ''} ` +
              `→ <code>/allow ${escapeTelegram(req.chatId)}</code> (${req.hits || 1} обращ.)`
          );
        }
      }
    } catch (error) {
      lines.push(`\n⚠️ Ошибка чтения БД: ${escapeTelegram(error.message)}`);
    }

    lines.push(`\n🛡️ Режим: ${strictMode ? 'строгий' : 'открыт'}`);
    await safeSendMessage(chatId, lines.join('\n'));
  });

  bot.onText(/\/allow(?:@\w+)?\s+(\S+)?/, async (msg, match) => {
    if (!(await requireAdmin(msg))) return;
    const chatId = String(msg.chat.id);
    const target = (match?.[1] || '').replace(/^@/, '').trim();

    if (!target) {
      return safeSendMessage(
        chatId,
        `Использование: <code>/allow 123456789</code>\n\nЗапросы доступа:\n/who`
      );
    }

    // /allow @username — ищем в заявках
    let targetId = target;
    let username = null;
    if (!/^-?\d+$/.test(target)) {
      try {
        const requests = await db.listRequests();
        const found = requests.find(
          (r) => r.username?.toLowerCase() === target.toLowerCase() || r.firstName === target
        );
        if (!found) {
          return safeSendMessage(
            chatId,
            `❓ Не нашёл "${escapeTelegram(target)}" среди запросов доступа.\n` +
              `По числовому ID: <code>/allow 123456789</code>\nСписок запросов: /who`
          );
        }
        targetId = String(found.chatId);
        username = found.username;
      } catch (error) {
        return safeSendMessage(chatId, `⚠️ Ошибка: ${escapeTelegram(error.message)}`);
      }
    }

    try {
      await db.grantAccess({
        chatId: targetId,
        username,
        role: 'user',
        grantedBy: chatId,
      });
      strictMode = true;
      await safeSendMessage(chatId, `✅ Доступ разрешён для <code>${escapeTelegram(targetId)}</code>`);
      await safeSendMessage(
        targetId,
        `✅ Вам разрешён доступ к AI-агенту YouGile.\n\n${HELP_TEXT}`
      );
    } catch (error) {
      await safeSendMessage(chatId, `❌ Ошибка: ${escapeTelegram(error.message)}`);
    }
  });

  bot.onText(/\/deny(?:@\w+)?\s+(\S+)/, async (msg, match) => {
    if (!(await requireAdmin(msg))) return;
    const chatId = String(msg.chat.id);
    const target = match[1].replace(/^@/, '').trim();

    if (isAdmin(target)) {
      return safeSendMessage(
        chatId,
        `🛡️ <code>${escapeTelegram(target)}</code> задан через TELEGRAM_ADMIN_IDS — ` +
          `отозвать можно только изменив переменную окружения на Render.`
      );
    }

    try {
      const removed = await db.revokeAccess(target);
      await safeSendMessage(
        chatId,
        removed
          ? `✅ Доступ отозван у <code>${escapeTelegram(target)}</code>`
          : `❓ <code>${escapeTelegram(target)}</code> не найден в списке доступа`
      );
    } catch (error) {
      await safeSendMessage(chatId, `❌ Ошибка: ${escapeTelegram(error.message)}`);
    }
  });

  bot.onText(/\/reset(?:@\w+)?\s+(\S+)/, async (msg, match) => {
    if (!(await requireAdmin(msg))) return;
    const chatId = String(msg.chat.id);
    const taskId = match[1].trim();

    try {
      const removed = await db.resetTaskRun(taskId);
      await safeSendMessage(
        chatId,
        removed
          ? `✅ Блокировка снята с задачи <code>${escapeTelegram(taskId)}</code>. Она будет подхвачена снова.`
          : `❓ Задача <code>${escapeTelegram(taskId)}</code> не найдена в реестре запусков.`
      );
    } catch (error) {
      await safeSendMessage(chatId, `❌ Ошибка: ${escapeTelegram(error.message)}`);
    }
  });

  bot.onText(/\/task(?:@\w+)?\s+([\s\S]+)/, async (msg, match) => {
    const chatId = String(msg.chat.id);
    if (!(await resolveAccess(chatId)).allowed) return handleUnauthorized(msg);

    const taskText = match[1].trim();
    if (!taskText) return safeSendMessage(chatId, `Использование: <code>/task Проведи SEO-аудит example.ru</code>`);

    await safeSendMessage(chatId, '🤖 Создаю задачу...');

    try {
      const task = await createTaskFromText(taskText);
      await safeSendMessage(
        chatId,
        `✅ <b>Задача создана!</b>\n\n🆔 <code>${escapeTelegram(task.id)}</code>\n` +
          `📝 ${escapeTelegram(task.title)}\n\n` +
          `Задача в YouGile. Переместите её в колонку «К выполнению», чтобы агент взялся за работу.`
      );
    } catch (error) {
      await safeSendMessage(chatId, `❌ Ошибка создания задачи: ${escapeTelegram(error.message)}`);
    }
  });

  bot.onText(/\/status(?:@\w+)?/, async (msg) => {
    const chatId = String(msg.chat.id);
    if (!(await resolveAccess(chatId)).allowed) return handleUnauthorized(msg);

    await safeSendMessage(chatId, '📊 Запрашиваю статус...');

    try {
      const columns = {
        'К выполнению': config.columnToExecute,
        'Выполняется': config.columnExecuting,
        'Ждут подтверждения': config.columnAwaitingConfirmation,
        Готово: config.columnDone,
        Ошибка: config.columnError,
      };

      const counts = await yougile.countByColumn(columns);
      const lines = [`📊 <b>Задачи по колонкам</b>\n`];
      for (const [name, value] of Object.entries(counts)) {
        lines.push(`${escapeTelegram(name)}: <b>${typeof value === 'number' ? value : '⚠️'}</b>`);
      }

      const stats = await db.getStats();
      lines.push(
        `\n🗄️ <b>База агента</b>\n` +
          `Задач обработано: ${stats.runs.done || 0}\n` +
          `С ошибками: ${stats.runs.error || 0}\n` +
          `Шагов сохранено: ${stats.stepsCount}\n` +
          `Запросов в кэше поиска: ${stats.searchesCount}`
      );

      await safeSendMessage(chatId, lines.join('\n'));
    } catch (error) {
      await safeSendMessage(chatId, `❌ Ошибка получения статуса: ${escapeTelegram(error.message)}`);
    }
  });

  // Любое текстовое сообщение (не команда) — создание задачи
  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    if (msg.chat.type !== 'private') return;

    const chatId = String(msg.chat.id);
    if (!(await resolveAccess(chatId)).allowed) return handleUnauthorized(msg);

    await safeSendMessage(chatId, '🤖 Создаю задачу из твоего сообщения...');

    try {
      const task = await createTaskFromText(msg.text);
      await safeSendMessage(
        chatId,
        `✅ <b>Задача создана!</b>\n\n🆔 <code>${escapeTelegram(task.id)}</code>\n📝 ${escapeTelegram(task.title)}`
      );
    } catch (error) {
      await safeSendMessage(chatId, `❌ Ошибка: ${escapeTelegram(error.message)}`);
    }
  });
}

/**
 * Создание задачи в YouGile из произвольного текста пользователя.
 * Вынесено из двух одинаковых блоков (/task и обработчик сообщений).
 */
async function createTaskFromText(text) {
  const { createYougileTask } = require('./email-worker');
  return createYougileTask({
    title: String(text).slice(0, 100),
    can_execute: true,
    execution_plan: ['Проанализировать запрос', 'Выполнить необходимые действия', 'Сохранить результат'],
    tools_needed: ['web_search', 'web_analysis'],
  });
}

/* ------------------------------------------------------------------ */
/* Инициализация                                                       */
/* ------------------------------------------------------------------ */

function initBot() {
  if (!config.telegramBotToken) {
    console.log('⚠️ TELEGRAM_BOT_TOKEN не задан — Telegram-бот отключён');
    return null;
  }

  bot = new TelegramBot(config.telegramBotToken, { polling: true });

  // КРИТИЧНО: без этого обработчика любая сетевая ошибка поллинга приводит к
  // unhandled 'error' event и process.exit(1) — падает всё приложение целиком.
  bot.on('polling_error', (error) => {
    console.error(`⚠️ Telegram polling_error: ${error.code || ''} ${error.message}`.trim());
  });

  bot.on('error', (error) => {
    console.error(`⚠️ Telegram error: ${error.message}`);
  });

  bot.on('webhook_error', (error) => {
    console.error(`⚠️ Telegram webhook_error: ${error.message}`);
  });

  registerHandlers();

  console.log(
    `🤖 Telegram-бот запущен | whitelist: ${
      strictMode ? `СТРОГИЙ (админов из env: ${ADMIN_IDS.size})` : 'ОТКРЫТ — задайте TELEGRAM_ADMIN_IDS!'
    }`
  );

  if (!strictMode) {
    console.warn(
      '⚠️ TELEGRAM_ADMIN_IDS не задан и список доступа пуст — бот принимает команды от ЛЮБОГО пользователя.\n' +
        '   Укажите свой chat ID в переменной TELEGRAM_ADMIN_IDS на Render, чтобы включить whitelist.'
    );
    notifyAdmins(
      `⚠️ <b>Бот работает без whitelist</b>\n\nTELEGRAM_ADMIN_IDS не задан — команды принимаются от всех.\n` +
        `Ваш chat ID: <code>${escapeTelegram(config.telegramChatId || 'не задан')}</code>\n` +
        `Добавьте его в TELEGRAM_ADMIN_IDS на Render.`
    ).catch(() => {});
  }

  return bot;
}

function stopBot() {
  if (!bot) return;
  try {
    bot.stopPolling();
    console.log('🔌 Telegram-бот остановлен');
  } catch (error) {
    console.warn(`⚠️ Ошибка остановки бота: ${error.message}`);
  }
}

function getBot() {
  return bot;
}

module.exports = {
  initBot,
  stopBot,
  getBot,
  sendNotification,
  notify,
  notifyAdmins,
  safeSendMessage,
  resolveAccess,
  isAdmin,
};
