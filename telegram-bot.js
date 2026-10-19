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

// Счётчики для восстановления поллинга после 409 Conflict (см. polling_error)
let conflictTimer = null;
let conflictRetries = 0;
let consecutivePollErrors = 0;

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

/**
 * Уведомить всех администраторов.
 * Возвращает список доставленных сообщений [{chatId, messageId}] — нужен,
 * чтобы привязать ответ (reply) на уведомление к конкретному черновику.
 */
async function notifyAdmins(message, options = {}) {
  if (!bot) return [];
  const targets = new Set(ADMIN_IDS);
  if (config.telegramChatId) targets.add(config.telegramChatId);

  const sent = [];
  for (const chatId of targets) {
    try {
      const result = await bot.sendMessage(chatId, message, { parse_mode: 'HTML', ...options });
      if (result && result.message_id) sent.push({ chatId: String(chatId), messageId: result.message_id });
    } catch (error) {
      console.warn(`⚠️ Не удалось уведомить админа ${chatId}: ${error.message}`);
    }
  }
  return sent;
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
async function sendNotification(message, options = {}) {
  if (!bot || !config.telegramChatId) {
    console.log('⚠️ Telegram-бот не инициализирован или TELEGRAM_CHAT_ID не задан');
    return null;
  }
  return safeSendMessage(config.telegramChatId, message, options);
}

/* ------------------------------------------------------------------ */
/* Импорт частотностей владельца                                       */
/* ------------------------------------------------------------------ */

/** Скачать файл из Telegram по file_id (file_id повторно используем). */
async function downloadTelegramFile(fileId) {
  const file = await bot.getFile(fileId);
  const link = await bot.getFileLink(file.file_path);
  const response = await fetch(link);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Импорт .xlsx в конкретный черновик и отчёт о результате.
 * Единая точка для всех путей: подпись, reply на уведомление, кнопка.
 */
async function importFrequenciesFile(chatId, draftId, fileId, fileName) {
  const semantics = require('./lib/semantics');

  await safeSendMessage(
    chatId,
    `📥 Принял файл ${escapeTelegram(toStr(fileName) || 'без имени')}, читаю частотности...`
  );

  const buffer = await downloadTelegramFile(fileId);
  const result = await semantics.mergeOwnerFrequencies(draftId, buffer);

  if (!result.success) {
    return safeSendMessage(chatId, `❌ Не удалось импортировать частотности: ${escapeTelegram(result.error)}`);
  }

  await db.clearPendingState(chatId).catch(() => {});

  return safeSendMessage(
    chatId,
    `✅ Частотности импортированы в черновик <code>${escapeTelegram(draftId)}</code>:\n` +
      `обновлено запросов: ${result.updated}\nдобавлено новых: ${result.added}\n` +
      `групп в файле: ${result.groups}` +
      (result.unmatchedGroups && result.unmatchedGroups.length
        ? `\n⚠️ пустые группы: ${escapeTelegram(result.unmatchedGroups.join(', '))}`
        : '') +
      '\n\nЧерновик с твоими частотностями готов к одобрению: команда /approve и id заявки ' +
      'пришли в уведомлении о заявке (или посмотри /approvals).'
  );
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

  taskDone: async ({ title, taskId, summary, draftId }) => {
    // Если выполнена задача конвейера семантики — добавляем кнопку загрузки
    // частотностей и запоминаем сообщение: ответ файлом на него однозначно
    // определит черновик (без подписи и угадываний).
    const options = {};
    if (draftId) {
      options.reply_markup = {
        inline_keyboard: [
          [{ text: `📤 Загрузить частотности (${draftId})`, callback_data: `freq:${draftId}` }],
        ],
      };
    }

    const sent = await sendNotification(
      `✅ <b>Задача выполнена!</b>\n\n📝 ${escapeTelegram(title)}\n🆔 <code>${escapeTelegram(taskId)}</code>` +
        (summary ? `\n\n${escapeTelegram(String(summary).slice(0, 900))}` : ''),
      options
    );

    if (draftId && sent && sent.message_id && config.telegramChatId) {
      await db
        .bindDraftMessage(config.telegramChatId, sent.message_id, draftId)
        .catch((error) => console.warn(`⚠️ Не удалось привязать уведомление к черновику: ${error.message}`));
    }
    return sent;
  },

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
  `/approvals — заявки на согласование, ожидающие решения\n` +
  `/approve <id> — разрешить заявленное действие\n` +
  `/deny <id> — отклонить заявку\n` +
  `/drafts — черновики семантики: id, статус и id заявки на одобрение\n` +
  `/modx — состояние коннектора публикации MODX\n` +
  'Пришли .xlsx с частотностями — ответом (reply) на уведомление о черновике или через кнопку под ним; можно и просто файлом (если черновиков несколько — спрошу, куда отнести)\n' +
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
  // Любое входящее обновление доказывает, что поллинг жив — сбрасываем счётчики
  bot.on('polling_message', () => {
    conflictRetries = 0;
    consecutivePollErrors = 0;
  });

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

  bot.onText(/\/approve(?:@\w+)?\s+(\S+)/, async (msg, match) => {
    if (!(await requireAdmin(msg))) return;
    const chatId = String(msg.chat.id);
    const id = match[1].trim().toLowerCase();

    try {
      const approvals = require('./lib/approvals');
      const decision = await approvals.decide(id, 'approved', chatId);

      if (!decision.ok) {
        return safeSendMessage(chatId, `❌ ${escapeTelegram(decision.error)}`);
      }

      const request = decision.request;
      await safeSendMessage(
        chatId,
        `✅ Заявка <code>${escapeTelegram(request.id)}</code> одобрена.\n` +
          `Действие: ${escapeTelegram(request.kindLabel)}\nОбъект: <code>${escapeTelegram(request.target)}</code>\n\n` +
          'Агент выполнит его при следующем шаге задачи. Заявка одноразовая.'
      );
    } catch (error) {
      await safeSendMessage(chatId, `❌ Ошибка: ${escapeTelegram(error.message)}`);
    }
  });

  bot.onText(/\/deny(?:@\w+)?\s+(\S+)/, async (msg, match) => {
    if (!(await requireAdmin(msg))) return;
    const chatId = String(msg.chat.id);
    const id = match[1].trim().toLowerCase();

    try {
      const approvals = require('./lib/approvals');
      const decision = await approvals.decide(id, 'denied', chatId);

      if (!decision.ok) {
        return safeSendMessage(chatId, `❌ ${escapeTelegram(decision.error)}`);
      }

      await safeSendMessage(
        chatId,
        `🚫 Заявка <code>${escapeTelegram(decision.request.id)}</code> отклонена. Действие не будет выполнено.`
      );
    } catch (error) {
      await safeSendMessage(chatId, `❌ Ошибка: ${escapeTelegram(error.message)}`);
    }
  });

  bot.onText(/\/approvals(?:@\w+)?/, async (msg) => {
    if (!(await requireAdmin(msg))) return;
    const chatId = String(msg.chat.id);

    try {
      const approvals = require('./lib/approvals');
      const pending = await approvals.listPending(10);

      if (pending.length === 0) {
        return safeSendMessage(chatId, '✅ Ожидающих заявок нет.');
      }

      const lines = pending.map(
        (request) =>
          `• <code>${escapeTelegram(request.id)}</code> — ${escapeTelegram(request.kindLabel)}\n` +
          `  объект: <code>${escapeTelegram(request.target)}</code>\n` +
          `  причина: ${escapeTelegram(String(request.reason).slice(0, 160))}\n` +
          `  <code>/approve ${escapeTelegram(request.id)}</code> или <code>/deny ${escapeTelegram(request.id)}</code>`
      );

      await safeSendMessage(chatId, `🔐 <b>Ожидают решения (${pending.length}):</b>\n\n${lines.join('\n\n')}`);
    } catch (error) {
      await safeSendMessage(chatId, `❌ Ошибка: ${escapeTelegram(error.message)}`);
    }
  });

  bot.onText(/\/drafts(?:@\w+)?/, async (msg) => {
    if (!(await requireAdmin(msg))) return;
    const chatId = String(msg.chat.id);

    try {
      const semantics = require('./lib/semantics');
      const drafts = await semantics.listDrafts(8);

      if (drafts.length === 0) {
        return safeSendMessage(
          chatId,
          'Черновиков семантики пока нет. Создаётся командой-задачей: ' +
            '«собери черновик семантики по группе seo-wordpress».'
        );
      }

      const lines = [];
      for (const draft of drafts) {
        const status = await semantics.draftStatus(draft);
        const pill = status === 'approved' ? '✅ одобрен' : status === 'denied' ? '🚫 отклонён' : '⏳ ждёт одобрения';
        lines.push(
          `• черновик <code>${escapeTelegram(draft.id)}</code> — ${pill}\n` +
            `  ${escapeTelegram(draft.title)}\n` +
            `  запросов владельца: ${draft.totals?.ownerQueries ?? '?'}, кандидатов: ${draft.totals?.suggestedQueries ?? '?'}` +
            (draft.approvalId ? `\n  одобрить: <code>/approve ${escapeTelegram(draft.approvalId)}</code>` : '')
        );
      }

      await safeSendMessage(chatId, `📋 <b>Черновики семантики</b>\n\n${lines.join('\n\n')}`);
    } catch (error) {
      await safeSendMessage(chatId, `❌ Ошибка: ${escapeTelegram(error.message)}`);
    }
  });

  bot.onText(/\/modx(?:@\w+)?/, async (msg) => {
    if (!(await requireAdmin(msg))) return;
    const chatId = String(msg.chat.id);

    try {
      const modx = require('./lib/modx-client');
      const state = await modx.status();

      if (!state.configured) {
        return safeSendMessage(chatId, `⚠️ ${escapeTelegram(state.error)}`);
      }

      if (!state.reachable) {
        return safeSendMessage(
          chatId,
          `❌ Коннектор MODX настроен, но недоступен.\n${escapeTelegram(state.error || '')}`
        );
      }

      await safeSendMessage(
        chatId,
        `✅ <b>MODX на связи</b>\n` +
          `Версия: ${escapeTelegram(state.modxVersion || '?')}\n` +
          `Режим политики: <b>${escapeTelegram(state.mode || '?')}</b>` +
          (state.mode === 'create_only' ? ' (чужой контент трогать нельзя)' : ' ⚠️ FULL') +
          `\nСайт: ${escapeTelegram(state.siteUrl || '?')}`
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
          `Задача в YouGile. Переместите её в колонку «В работе», чтобы агент взялся за работу.`
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
        'Входящие задачи': config.columnDefault,
        'В работе': config.columnToExecute,
        'На проверку': config.columnReview,
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

  // Файл .xlsx в чат — импорт частотностей владельца в черновик семантики.
  // Черновик определяется детерминированно (приоритеты): id в подписи →
  // id задачи YouGile в подписи → reply на уведомление бота → кнопка
  // «Загрузить частотности» → единственный ожидающий черновик.
  // Если сигналов нет, а черновиков несколько — НЕ угадываем, а спрашиваем кнопками.
  bot.on('message', async (msg) => {
    if (!msg.document) return;

    const chatId = String(msg.chat.id);
    if (!(await resolveAccess(chatId)).allowed) return handleUnauthorized(msg);

    const fileName = toStr(msg.document.file_name);
    const mime = toStr(msg.document.mime_type);

    if (!/\.xlsx$/i.test(fileName) && !/spreadsheet|xlsx/i.test(mime)) {
      return safeSendMessage(
        chatId,
        `Принимаю только файлы .xlsx с частотностями. Получил: ${escapeTelegram(fileName || mime || 'файл')}`
      );
    }

    try {
      const semantics = require('./lib/semantics');

      const choice = await semantics.resolveDraftForUpload({
        chatId,
        caption: toStr(msg.caption),
        replyMessageId: msg.reply_to_message ? msg.reply_to_message.message_id : null,
      });

      if (choice.draftId) {
        return await importFrequenciesFile(chatId, choice.draftId, msg.document.file_id, fileName);
      }

      if (choice.ambiguous.length > 0) {
        // Запоминаем файл (file_id живёт на стороне Telegram) и спрашиваем, куда его отнести
        await db.setPendingState(chatId, 'file', {
          file: { fileId: msg.document.file_id, fileName },
        });

        const keyboard = {
          inline_keyboard: [
            ...choice.ambiguous.map((draft) => [
              {
                text: `${String(draft.label).slice(0, 46)} · ${draft.id}`.slice(0, 64),
                callback_data: `pick:${draft.id}`,
              },
            ]),
            [{ text: 'Отмена', callback_data: 'pick:cancel' }],
          ],
        };

        return safeSendMessage(
          chatId,
          '🤔 Незакрытых черновиков несколько — к какому отнести файл? Файл я запомнил, выбери черновик:',
          { reply_markup: keyboard }
        );
      }

      return safeSendMessage(
        chatId,
        'Не нашёл черновик семантики, к которому отнести частотности.\n' +
          'Черновик появляется через минуту после того, как задача конвейера выполнена ' +
          '(задачи конвейера сами уходят в «В работе», переносить руками не нужно).\n' +
          'Посмотри список: /drafts. Файл можно прислать ответом (reply) на уведомление о черновике ' +
          'или с подписью — id черновика (8 символов) либо id задачи YouGile целиком.'
      );
    } catch (error) {
      await safeSendMessage(chatId, `❌ Ошибка импорта файла: ${escapeTelegram(error.message)}`);
    }
  });

  // Кнопки: «Загрузить частотности» под уведомлением о черновике и выбор
  // черновика для файла, который бот запомнил при неоднозначности.
  bot.on('callback_query', async (query) => {
    const chatId = String(
      (query.message && query.message.chat && query.message.chat.id) || (query.from && query.from.id) || ''
    );
    const data = toStr(query.data);

    try {
      if (!(await resolveAccess(chatId)).allowed) {
        await bot.answerCallbackQuery(query.id, { text: 'Доступ запрещён' }).catch(() => {});
        return;
      }

      if (data.startsWith('freq:')) {
        const draftId = data.slice(5).toLowerCase();
        const pending = await db.takePendingState(chatId).catch(() => null);

        if (pending && pending.kind === 'file' && pending.file && pending.file.fileId) {
          // Файл уже был прислан, но без однозначного адресата — теперь адресат есть
          await bot.answerCallbackQuery(query.id, { text: 'Импортирую файл…' }).catch(() => {});
          return await importFrequenciesFile(chatId, draftId, pending.file.fileId, pending.file.fileName);
        }

        await db.setPendingState(chatId, 'target', { draftId });
        await bot.answerCallbackQuery(query.id, { text: 'Жду файл' }).catch(() => {});
        return safeSendMessage(
          chatId,
          `Пришли .xlsx с частотностями следующим сообщением — импортирую в черновик <code>${escapeTelegram(draftId)}</code>.\n` +
            'Подпись не нужна, выбор я запомнил (действует 30 минут).'
        );
      }

      if (data === 'pick:cancel') {
        await db.clearPendingState(chatId).catch(() => {});
        await bot.answerCallbackQuery(query.id, { text: 'Отменено' }).catch(() => {});
        return safeSendMessage(
          chatId,
          'Отменил. Файл можно прислать заново — ответом на уведомление о черновике, ' +
            'с подписью (id черновика) или через кнопку «Загрузить частотности».'
        );
      }

      if (data.startsWith('pick:')) {
        const draftId = data.slice(5).toLowerCase();
        const pending = await db.takePendingState(chatId).catch(() => null);

        if (!pending || pending.kind !== 'file' || !pending.file || !pending.file.fileId) {
          await bot.answerCallbackQuery(query.id, { text: 'Файл не найден' }).catch(() => {});
          return safeSendMessage(
            chatId,
            'Не нашёл запомненный файл (возможно, истекло время ожидания). Пришли .xlsx ещё раз — спрошу заново.'
          );
        }

        await bot.answerCallbackQuery(query.id, { text: 'Импортирую…' }).catch(() => {});
        return await importFrequenciesFile(chatId, draftId, pending.file.fileId, pending.file.fileName);
      }

      await bot.answerCallbackQuery(query.id).catch(() => {});
    } catch (error) {
      console.error(`❌ callback_query: ${error.message}`);
      await bot.answerCallbackQuery(query.id, { text: `Ошибка: ${error.message}` }).catch(() => {});
    }
  });

  // Любое текстовое сообщение (не команда) — создание задачи
  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    if (msg.chat.type !== 'private') return;

    const chatId = String(msg.chat.id);
    if (!(await resolveAccess(chatId)).allowed) return handleUnauthorized(msg);

    // «Частотности к …» без приложенного файла — это не задача, а попытка
    // импорта: объясняем формат вместо создания бесполезной задачи
    if (/частотност|частоты\s+к/i.test(msg.text) && !msg.document) {
      return safeSendMessage(
        chatId,
        'Чтобы залить частотности, пришли сам файл .xlsx.\n' +
          'Самый надёжный способ — ответом (reply) на уведомление о черновике ' +
          'или через кнопку «Загрузить частотности» под ним.\n' +
          'Можно и просто файлом: если незакрытый черновик один — пойму сам, ' +
          'если несколько — спрошу кнопками.\n' +
          'В подписи можно указать id черновика (8 символов, см. /drafts) ' +
          'или id задачи YouGile целиком — пойму оба варианта.'
      );
    }

    await safeSendMessage(chatId, '🤖 Создаю задачу из твоего сообщения...');

    try {
      const task = await createTaskFromText(msg.text);
      await safeSendMessage(
        chatId,
        `✅ <b>Задача создана!</b>\n\n🆔 <code>${escapeTelegram(task.id)}</code>\n📝 ${escapeTelegram(task.title)}` +
          (task.autoQueued
            ? '\n\n⚙️ Распознан сценарий конвейера: задача уже поставлена в «В работе», ' +
              'переносить вручную не нужно. Результат придёт комментарием в задачу и сюда.'
            : '')
      );
    } catch (error) {
      await safeSendMessage(chatId, `❌ Ошибка: ${escapeTelegram(error.message)}`);
    }
  });
}

/**
 * Создание задачи в YouGile из произвольного текста пользователя.
 * Вынесено из двух одинаковых блоков (/task и обработчик сообщений).
 *
 * Задачи согласованного конвейера («собери черновик семантики…», «создай страницу
 * по черновику…», «проведи SEO-аудит…») ставятся СРАЗУ в колонку-очередь «В работе»:
 * им не нужно ручное перемещение, исполнитель подхватит их за 30 секунд.
 * План для них детерминированный — реальные шаги кода (lib/task-planner.js).
 *
 * Прочие задачи проходят через планировщика GLM: индивидуальный план 3-7
 * конкретных шагов под запрос и инструменты из полного реестра (раньше здесь
 * был зашит одинаковый куцый план из трёх общих шагов и жёсткая пара
 * web_search+web_analysis для любой задачи).
 * Если планировщик недоступен — безопасный общий план, задача всё равно создаётся.
 */
async function createTaskFromText(text) {
  const { createYougileTask } = require('./email-worker');
  const workflows = require('./lib/workflows');
  const planner = require('./lib/task-planner');
  const { config } = require('./lib/config');

  const workflow = workflows.detectWorkflow(String(text));
  const columnId = workflow && config.columnToExecute ? config.columnToExecute : undefined;

  let taskData;

  if (workflow) {
    const preset = planner.WORKFLOW_PLANS[workflow] || {};
    taskData = {
      title: String(text).slice(0, 100),
      can_execute: true,
      execution_plan: preset.plan || [
        'Выполнить сценарий конвейера',
        'Отчитаться комментарием и заявкой на согласование',
      ],
      tools_needed: preset.tools || [],
    };
  } else {
    const planned = await planner.planTaskFromText(text);
    taskData = {
      title: String(text).slice(0, 100) || planned.title,
      can_execute: planned.can_execute,
      execution_plan: planned.execution_plan,
      tools_needed: planned.tools_needed,
    };
  }

  const task = await createYougileTask(taskData, columnId);

  return { ...task, autoQueued: Boolean(workflow) };
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
    const code = error.code || '';
    const isConflict = /409|terminated by other getUpdates/i.test(String(error.message));

    console.error(`⚠️ Telegram polling_error: ${code} ${error.message}`.trim());

    // 409 Conflict означает, что слот getUpdates занят ДРУГИМ экземпляром бота.
    // Штатная причина — пересечение старого и нового dyno во время деплоя Render.
    // Без реакции библиотека долбит getUpdates и получает 409 бесконечно,
    // то есть бот в этом экземпляре мёртв. Лечим уступкой слота с повтором:
    // как только старый экземпляр умрёт, новый подхватит поллинг.
    if (isConflict) {
      conflictRetries++;
      const delay = Math.min(15000 * conflictRetries, 120000);

      console.warn(
        ` Слот getUpdates занят другим экземпляром (попытка ${conflictRetries}). ` +
          `Останавливаю поллинг и повторю через ${Math.round(delay / 1000)}с.`
      );

      try {
        bot.stopPolling();
      } catch {
        /* уже остановлен */
      }

      if (conflictTimer) clearTimeout(conflictTimer);
      conflictTimer = setTimeout(() => {
        try {
          bot.startPolling();
          console.log('🔄 Telegram: поллинг перезапущен после конфликта');
        } catch (restartError) {
          console.error(`❌ Не удалось перезапустить поллинг: ${restartError.message}`);
        }
      }, delay);
      conflictTimer.unref?.();
    } else if (consecutivePollErrors++ % 20 === 0) {
      console.warn('   (повторяющиеся ошибки поллинга логируются раз в 20, чтобы не засорять лог)');
    }
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
  if (conflictTimer) {
    clearTimeout(conflictTimer);
    conflictTimer = null;
  }

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
