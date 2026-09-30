// email-worker.js
// Приём задач из почтового ящика по IMAP.
//
// Исправлено:
//  C4 — УБРАНО ЛОГИРОВАНИЕ ПАРОЛЯ. Прежняя версия писала в stdout длину и
//       первые 5 символов MAIL_PASSWORD, и это попадало в логи Render.
//       Пароль от почты считается скомпрометированным — его нужно перевыпустить.
//  H1 — у всех внешних запросов появились таймауты (через lib/http и lib/glm-client).
//  M13 — проверка TLS-сертификата включена по умолчанию, отключается только
//        явным флагом MAIL_TLS_INSECURE=true.
//  M14 — фильтр темы сужен: вместо «любое письмо со словом Задачи» теперь
//        настраиваемый список маркеров (по умолчанию только [TASK]).
//  M15 — папка AI_DONE создаётся автоматически, если её нет.
//  M16 — письма помечаются обработанными поштучно, а не «все или ничего».
//        Раньше одна ошибка YouGile оставляла письмо необработанным, хотя часть
//        задач уже была создана → дубли при повторном запуске.

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const { config } = require('./lib/config');
const { chatJson } = require('./lib/glm-client');
const yougile = require('./lib/yougile-client');
const { toStr } = require('./lib/text');

let isProcessing = false;
let stopping = false;

const IGNORE_SENDERS = [
  'yougile.com',
  'noreply',
  'no-reply',
  'mailer-daemon',
  'postmaster',
  'notification',
];

/* ------------------------------------------------------------------ */
/* IMAP-клиент                                                         */
/* ------------------------------------------------------------------ */

function createMailClient() {
  if (!config.mailUser || !config.mailPassword) {
    throw new Error('MAIL_USER или MAIL_PASSWORD не заданы — почтовый воркер не может работать');
  }

  // Никакого логирования пароля: ни длины, ни первых символов, ни факта наличия.
  console.log(`🔧 IMAP: подключаюсь к ${config.mailHost}:${config.mailPort} как ${config.mailUser}`);

  const client = new ImapFlow({
    host: config.mailHost,
    port: config.mailPort,
    secure: true,
    auth: {
      user: config.mailUser,
      pass: config.mailPassword,
    },
    tls: {
      // Отключение проверки сертификата — только по явному флагу.
      // Прежде было захардкожено rejectUnauthorized: false (риск MITM).
      rejectUnauthorized: !config.mailTlsInsecure,
    },
    connectionTimeout: 30000,
    socketTimeout: 60000,
    logger: false,
  });

  client.on('error', (error) => {
    console.error(`❌ IMAP error: ${error.message}`);
  });

  return client;
}

/* ------------------------------------------------------------------ */
/* Фильтры                                                             */
/* ------------------------------------------------------------------ */

function shouldIgnoreEmail(parsed) {
  const from = (parsed.from?.value?.[0]?.address || '').toLowerCase();
  const subject = toStr(parsed.subject).toLowerCase();

  if (IGNORE_SENDERS.some((pattern) => from.includes(pattern))) return true;

  const ignoredSubjects = ['notification', 'уведомление', 'назначена задача', 'выполнена', 'undelivered', 'delivery status'];
  return ignoredSubjects.some((pattern) => subject.includes(pattern));
}

/**
 * Подходит ли письмо под критерий задачи.
 * Прежняя проверка `subject.includes('Задачи')` зацепляла любое письмо со словом
 * «задачи» — теперь список маркеров настраивается через MAIL_TASK_SUBJECT_MARKERS.
 */
function isTaskEmail(parsed) {
  const subject = toStr(parsed.subject);
  return config.mailTaskSubjectMarkers.some((marker) => subject.toLowerCase().includes(marker.toLowerCase()));
}

/* ------------------------------------------------------------------ */
/* Создание задачи в YouGile                                           */
/* ------------------------------------------------------------------ */

function formatExecutionPlan(plan) {
  if (Array.isArray(plan)) {
    return plan
      .map((step, index) => {
        const clean = toStr(step).trim();
        // Не добавляем нумерацию, если шаг уже пронумерован («1.», «1)», «Шаг 1:»)
        if (/^(шаг\s*\d+[:.)]|\d+[.)])\s*/i.test(clean)) return clean;
        return `${index + 1}. ${clean}`;
      })
      .join('<br>');
  }
  return toStr(plan, 'Не указан').replace(/\n+/g, '<br>');
}

function buildAiTaskDescription(taskData) {
  const parts = ['🤖 <b>AI-агент может выполнить эту задачу автономно</b>', ''];

  const result = toStr(taskData.result).trim();
  if (result && result !== 'Не применимо') {
    parts.push('<b>📊 Результат:</b>', result, '');
  }

  const estimated = toStr(taskData.estimated_time).trim();
  if (estimated && estimated !== 'Не применимо') {
    parts.push('<b>⏱️ Оценка времени:</b>', estimated, '');
  }

  parts.push('<b>📋 План выполнения:</b>', formatExecutionPlan(taskData.execution_plan), '');
  parts.push(
    '<b>🔧 Инструменты:</b>',
    Array.isArray(taskData.tools_needed)
      ? taskData.tools_needed.join(', ')
      : toStr(taskData.tools_needed, 'web_search'),
    ''
  );
  parts.push('<b>✅ Для запуска:</b> переместите задачу в колонку «К выполнению»');

  return parts.join('<br>');
}

/**
 * Создание задачи «для человека» (или общей точки входа для других модулей).
 * @param {object} taskData
 * @param {string} [columnId]
 */
async function createYougileTask(taskData, columnId) {
  const description = buildAiTaskDescription({
    execution_plan: taskData.execution_plan || taskData.steps,
    tools_needed: taskData.tools_needed,
    result: taskData.result,
    estimated_time: taskData.estimated_time,
  });

  return yougile.createTask({
    title: taskData.title,
    description,
    columnId: columnId || config.columnDefault || config.columnAwaitingConfirmation,
    assigned: config.yougileUserId ? [config.yougileUserId] : undefined,
    stickers: { [config.aiStickerId]: 'empty' },
  });
}

/* ------------------------------------------------------------------ */
/* Разбор письма через GLM                                             */
/* ------------------------------------------------------------------ */

const MAIL_ANALYSIS_PROMPT = `Проанализируй запрос из письма и разбей его на ОТДЕЛЬНЫЕ задачи.

ВАЖНО: если в запросе несколько действий — создай несколько задач.

Для каждой задачи:
- Если можешь выполнить АВТОНОМНО (поиск, анализ, подготовка документа):
  - can_execute: true
  - execution_plan: массив из 3-7 подробных шагов (ОБЯЗАТЕЛЬНО заполни)
  - tools_needed: массив инструментов (web_search, web_analysis, create_document)

- Если задача для человека:
  - can_execute: false
  - result: что получится
  - estimated_time: оценка времени
  - steps: массив шагов

Верни ТОЛЬКО JSON:
{
  "tasks": [
    {
      "title": "краткое название задачи",
      "can_execute": true,
      "execution_plan": ["Шаг 1: подробное описание", "Шаг 2: подробное описание"],
      "tools_needed": ["web_search", "web_analysis"]
    },
    {
      "title": "вторая задача",
      "can_execute": false,
      "result": "что получится в итоге",
      "estimated_time": "2-3 часа",
      "steps": ["шаг 1", "шаг 2"]
    }
  ]
}

ВАЖНО: execution_plan ВСЕГДА должен быть МАССИВОМ строк, даже если шаг один.`;

async function analyseMailText(mailText) {
  const parsed = await chatJson(MAIL_ANALYSIS_PROMPT, mailText, { timeout: config.glmTimeoutMs });
  const tasks = Array.isArray(parsed.tasks) && parsed.tasks.length > 0 ? parsed.tasks : [parsed];
  return tasks.filter((task) => task && toStr(task.title).trim());
}

/* ------------------------------------------------------------------ */
/* Основной цикл обработки                                             */
/* ------------------------------------------------------------------ */

async function ensureFolder(client, folderName) {
  try {
    const status = await client.status(folderName, { uidNext: true });
    if (status) return true;
  } catch {
    // папки нет — пробуем создать
  }

  try {
    await client.mailboxCreate(folderName);
    console.log(`📁 Папка ${folderName} создана`);
    return true;
  } catch (error) {
    console.warn(`⚠️ Не удалось создать папку ${folderName}: ${error.message}`);
    return false;
  }
}

async function processMail() {
  if (stopping) return 0;

  if (isProcessing) {
    console.log('⏳ Уже идёт обработка почты, пропускаем');
    return 0;
  }

  if (!config.mailUser || !config.mailPassword) {
    console.log('📧 MAIL_USER/MAIL_PASSWORD не заданы — почтовый воркер отключён');
    return 0;
  }

  isProcessing = true;

  let mailClient;
  try {
    mailClient = createMailClient();
    await mailClient.connect();
    console.log('✅ IMAP подключен');

    const lock = await mailClient.getMailboxLock(config.mailInbox);

    try {
      const unseen = await mailClient.search({ seen: false });
      console.log(`🔍 Непрочитанных писем: ${unseen.length}`);
      if (!unseen || unseen.length === 0) return 0;

      // Отбор писем, похожих на задачи
      const candidateUids = [];
      for (const uid of unseen) {
        const envelope = await mailClient.fetchOne(uid, { envelope: true, uid: true });
        const subject = toStr(envelope?.envelope?.subject);
        const fakeParsed = { subject, from: { value: [{ address: envelope?.envelope?.from?.[0]?.address }] } };

        if (shouldIgnoreEmail(fakeParsed)) {
          console.log(`🚫 Пропущено (служебное): ${subject}`);
          await mailClient.messageFlagsAdd(uid, ['\\Seen'], { uid: true }).catch(() => {});
          continue;
        }

        if (isTaskEmail(fakeParsed)) candidateUids.push(uid);
      }

      console.log(`📬 Писем-задач: ${candidateUids.length}`);
      if (candidateUids.length === 0) return 0;

      // Читаем письма и разбираем их по отдельности, чтобы ошибка в одном
      // не блокировала остальные (прежде всё склеивалось в один mailText)
      let createdTotal = 0;

      for await (const message of mailClient.fetch(candidateUids, { uid: true, source: true })) {
        if (stopping) break;

        let parsed;
        try {
          parsed = await simpleParser(message.source);
        } catch (error) {
          console.error(`❌ Не удалось разобрать письмо UID ${message.uid}: ${error.message}`);
          continue; // НЕ помечаем — пусть останется для ручной проверки
        }

        const text = toStr(parsed.text).trim().substring(0, 5000);
        const subject = toStr(parsed.subject);
        console.log(`📧 UID ${message.uid} | «${subject}» | ${text.length} симв.`);

        if (!text && !subject) {
          await mailClient.messageFlagsAdd(message.uid, ['\\Seen'], { uid: true }).catch(() => {});
          continue;
        }

        try {
          const tasks = await analyseMailText(`[Тема: ${subject}]\n${text}`);
          console.log(`🤖 GLM вернул ${tasks.length} задач`);

          let createdHere = 0;

          for (const taskData of tasks) {
            try {
              if (taskData.can_execute) {
                const plan = taskData.execution_plan;
                if (!plan || (Array.isArray(plan) && plan.length === 0)) {
                  console.warn(`⚠️ Пропускаю «${taskData.title}» — нет плана выполнения`);
                  continue;
                }

                const created = await yougile.createTask({
                  title: taskData.title,
                  description: buildAiTaskDescription(taskData),
                  columnId: config.columnAwaitingConfirmation || config.columnDefault,
                  assigned: config.yougileUserId ? [config.yougileUserId] : undefined,
                  stickers: { [config.aiStickerId]: 'empty' },
                });
                console.log(`✅ Задача для AI создана: ${created.id}`);
                createdHere++;
              } else {
                const created = await createYougileTask({
                  title: taskData.title,
                  result: taskData.result || 'Не указано',
                  estimated_time: taskData.estimated_time || 'Не указано',
                  steps: taskData.steps || ['Уточнить план'],
                });
                console.log(`✅ Задача для человека создана: ${created.id}`);
                createdHere++;
              }
            } catch (error) {
              console.error(`❌ Не удалось создать задачу «${taskData.title}»: ${error.message}`);
            }
          }

          createdTotal += createdHere;

          // Письмо считается обработанным, если создана хотя бы одна задача
          // ИЛИ если GLM не вернул ни одной (нечего создавать).
          // Помечаем поштучно — раньше «все или ничего» приводило к дублям.
          if (createdHere > 0 || tasks.length === 0) {
            await mailClient.messageFlagsAdd(message.uid, ['\\Seen'], { uid: true }).catch(() => {});

            if (await ensureFolder(mailClient, config.mailDoneFolder)) {
              await mailClient
                .messageMove(message.uid, config.mailDoneFolder, { uid: true })
                .catch((error) => console.warn(`⚠️ Не удалось переместить в ${config.mailDoneFolder}: ${error.message}`));
            }

            const { notify } = require('./telegram-bot');
            await notify.taskCreatedFromEmail({
              title: tasks[0]?.title || subject,
              count: createdHere,
            });
          } else {
            console.warn(`⚠️ UID ${message.uid}: создано 0 из ${tasks.length} задач — письмо оставлено для повтора`);
          }
        } catch (error) {
          console.error(`❌ Обработка письма UID ${message.uid} не удалась: ${error.message}`);
          // Письмо НЕ помечаем — обработается на следующем цикле
        }
      }

      return createdTotal;
    } finally {
      try {
        lock.release();
      } catch {
        /* уже отпущен */
      }
    }
  } catch (error) {
    console.error(`❌ processMail: ${error.message}`);
    return 0;
  } finally {
    if (mailClient) {
      try {
        await mailClient.logout();
      } catch {
        /* соединение уже закрыто */
      }
    }
    isProcessing = false;
  }
}

/* ------------------------------------------------------------------ */
/* IDLE + поллинг                                                      */
/* ------------------------------------------------------------------ */

async function runIdleLoop() {
  while (!stopping) {
    let mailClient;
    try {
      mailClient = createMailClient();
      await mailClient.connect();

      const lock = await mailClient.getMailboxLock(config.mailInbox);
      console.log('👂 IDLE: слушаю новые письма...');

      await new Promise((resolve) => {
        const onExists = () => {
          console.log('🔔 Новое письмо!');
          resolve();
        };
        mailClient.on('exists', onExists);

        // Перезапускаем IDLE каждые 25 минут — серверы обычно рвут его через 30
        const timer = setTimeout(() => {
          mailClient.removeListener('exists', onExists);
          resolve();
        }, 25 * 60 * 1000);

        mailClient.once('close', () => {
          clearTimeout(timer);
          mailClient.removeListener('exists', onExists);
          resolve();
        });
      });

      try {
        lock.release();
      } catch {
        /* ignore */
      }
      try {
        await mailClient.logout();
      } catch {
        /* ignore */
      }

      await processMail();
    } catch (error) {
      console.error(`❌ IDLE error: ${error.message}`);
      if (mailClient) {
        try {
          await mailClient.logout();
        } catch {
          /* ignore */
        }
      }
    }

    if (!stopping) await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  console.log('📧 IDLE-цикл остановлен');
}

let pollTimer = null;

async function startEmailWorker() {
  if (!config.mailUser || !config.mailPassword) {
    console.log('📧 Почтовый воркер отключён: не заданы MAIL_USER/MAIL_PASSWORD');
    return;
  }

  console.log(`📧 Email worker запущен (IDLE + поллинг каждые ${config.mailPollIntervalMs / 1000}с)`);

  pollTimer = setInterval(() => {
    processMail().catch((error) => console.error(`❌ Polling error: ${error.message}`));
  }, config.mailPollIntervalMs);

  runIdleLoop().catch((error) => console.error(`❌ IDLE loop crashed: ${error.message}`));

  await processMail();
}

async function stopEmailWorker() {
  stopping = true;
  if (pollTimer) clearInterval(pollTimer);
}

module.exports = {
  startEmailWorker,
  stopEmailWorker,
  processMail,
  createYougileTask,
};
