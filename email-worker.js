// email-worker.js
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");

let isProcessing = false;
const AI_STICKER_ID = "c553a657-fa54-4532-9d02-4750e013005f";

// 🔍 Фильтр для игнорирования ненужных писем
const IGNORE_SENDERS = [
  'yougile.com',
  'noreply',
  'no-reply',
  'mailer-daemon',
  'postmaster',
  'notification'
];

function shouldIgnoreEmail(parsed) {
  const from = (parsed.from?.value?.[0]?.address || '').toLowerCase();
  const subject = (parsed.subject || '').toLowerCase();
  
  for (const ignore of IGNORE_SENDERS) {
    if (from.includes(ignore)) return true;
  }
  
  if (subject.includes('notification') || 
      subject.includes('уведомление') ||
      subject.includes('назначена задача') ||
      subject.includes('выполнена')) {
    return true;
  }
  
  return false;
}

// Функция создания задачи (для человека)
async function createYougileTask(taskData, columnId = process.env.COLUMN_DEFAULT) {
  // Форматируем execution_plan (массив или строка)
// ✅ Форматируем execution_plan (массив или строка)
let executionPlanFormatted;
if (Array.isArray(taskData.execution_plan)) {
  executionPlanFormatted = taskData.execution_plan
    .map((step, i) => {
      const cleanStep = String(step).trim();
      // Если шаг уже начинается с цифры (например "1. ...") — не добавляем нумерацию
      if (/^\d+[\.\)]\s*/.test(cleanStep)) {
        return cleanStep;
      }
      return `${i + 1}. ${cleanStep}`;
    })
    .join('<br>');
} else {
  executionPlanFormatted = String(taskData.execution_plan || "Не указан")
    .replace(/\n+/g, '<br>')
    .replace(/<br><br>/g, '<br>');
}

const description = [
  "🤖 <b>AI-агент может выполнить эту задачу автономно</b>",
  "",
  "<b>📋 План выполнения:</b>",
  executionPlanFormatted,
  "",
  "<b>🔧 Инструменты:</b>",
  taskData.tools_needed?.join(', ') || 'web_search',
  "",
  "<b>✅ Для запуска:</b> переместите задачу в колонку 'К выполнению'"
].join('<br>');

  // ✅ ИСПРАВЛЕНО: assigned — это МАССИВ, а не строка!
  const payload = {
    title: taskData.title,
    description,
    columnId: columnId,
    stickers: { [AI_STICKER_ID]: "empty" }
  };

  if (process.env.YOUGILE_GLM_USER_ID) {
    payload.assigned = [process.env.YOUGILE_GLM_USER_ID];
  }

  const response = await fetch("https://rocketup.yougile.com/api-v2/tasks", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.YOUGILE_GLM_API_KEY}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`❌ YouGile ошибка при создании задачи: ${response.status} - ${errorText}`);
    throw new Error(`YouGile error: ${response.status}`);
  }

  return await response.json();
}

// Основная функция обработки почты
async function processMail() {
  console.log(`🔍 processMail() запущен`);

  if (isProcessing) {
    console.log("⏳ Уже идёт обработка, пропускаем");
    return 0;
  }

isProcessing = true;
const mailClient = new ImapFlow({
  host: "imap.mail.ru",
  port: 993,
  secure: true,
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASSWORD
  }
});

// ✅ Обработчик ошибок соединения
mailClient.on('error', (err) => {
  console.error(`❌ IMAP error in processMail: ${err.message}`);
});

try {
  await mailClient.connect();
    console.log("✅ IMAP подключен");

    const lock = await mailClient.getMailboxLock("INBOX");
    
    try {
  // Ищем все непрочитанные письма
  console.log(`🔍 Ищем непрочитанные письма...`);
  const allUnseen = await mailClient.search({ seen: false });
  console.log(`📬 Всего непрочитанных: ${allUnseen.length}`);

  // Фильтруем по теме
  const range = [];
  for (const uid of allUnseen) {
    const message = await mailClient.fetchOne(uid, { envelope: true });
    const subject = message.envelope.subject || '';
    if (subject.includes('[TASK]') || subject.includes('Задачи')) {
      range.push(uid);
    }
  }

  console.log(`📬 Писем с темой [TASK] или "Задачи": ${range.length}`);
  
  if (range.length === 0) {
    console.log("📭 Нет писем с темой [TASK] или 'Задачи'");
    return 0;
  }

  // ... остальной код обработки ...

      let mailText = "";
      const processedUids = [];

      for await (let message of mailClient.fetch(range, {
        uid: true,
        source: true
      })) {
        const parsed = await simpleParser(message.source);
        
        // 🔍 Фильтруем ненужные письма
        if (shouldIgnoreEmail(parsed)) {
          await mailClient.messageFlagsAdd(message.uid, ["\\Seen"], { uid: true });
          console.log(`🚫 Пропущено: ${parsed.from?.value?.[0]?.address} | ${parsed.subject}`);
          continue;
        }
        
        // ✅ Ограничиваем размер текста (макс 5000 символов)
        const text = (parsed.text || "").trim().substring(0, 5000);
        console.log(`📧 Письмо UID ${message.uid} | Тема: "${parsed.subject}" | Размер: ${text.length} симв.`);
        
        mailText += `[Тема: ${parsed.subject}]\n${text}\n\n`;
        processedUids.push(message.uid);
      }

      if (processedUids.length === 0) return 0;

      console.log(`📝 Обрабатываю ${processedUids.length} писем, всего ${mailText.length} символов`);

// ✅ GLM с retry-логикой и увеличенным таймаутом
const MAX_RETRIES = 3;
const BASE_TIMEOUT = 120000; // 120 секунд
let glmData;
let lastError;

for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  const controller = new AbortController();
  const timeout = BASE_TIMEOUT + (attempt - 1) * 30000; // увеличиваем с каждой попыткой
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    console.log(`🤖 GLM запрос (попытка ${attempt}/${MAX_RETRIES}, таймаут ${timeout/1000}с)...`);
    const startTime = Date.now();

    const glmResponse = await fetch('https://api.z.ai/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.ZAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'glm-4.5-flash',
        messages: [
          {
            role: 'system',
            content: `Проанализируй запрос и разбей его на ОТДЕЛЬНЫЕ задачи.

ВАЖНО: Если в запросе несколько действий — создай несколько задач!

Для каждой задачи:
- Если можешь выполнить АВТОНОМНО (поиск, анализ): 
  - can_execute: true
  - execution_plan: массив из 3-7 подробных шагов (ОБЯЗАТЕЛЬНО заполни!)
  - tools_needed: массив инструментов

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
      "execution_plan": [
        "Шаг 1: подробное описание",
        "Шаг 2: подробное описание",
        "Шаг 3: подробное описание"
      ],
      "tools_needed": ["web_search", "web_analysis"]
    },
    {
      "title": "вторая задача",
      "can_execute": false,
      "result": "что получится в итоге",
      "estimated_time": "2-3 часа",
      "steps": ["шаг 1", "шаг 2", "шаг 3"]
    }
  ]
}

ВАЖНО: execution_plan ВСЕГДА должен быть МАССИВОМ строк, даже если один шаг!`
          },
          { role: 'user', content: mailText }
        ],
        response_format: { type: 'json_object' }
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    const elapsed = Date.now() - startTime;
    console.log(`✅ GLM ответил за ${elapsed}мс (статус ${glmResponse.status})`);

    if (!glmResponse.ok) {
      const errorText = await glmResponse.text();
      throw new Error(`GLM error ${glmResponse.status}: ${errorText}`);
    }

    glmData = await glmResponse.json();
    break; // Успех — выходим из цикла retry

  } catch (error) {
    clearTimeout(timeoutId);
    lastError = error;
    
    if (error.name === 'AbortError') {
      console.error(`❌ GLM таймаут на попытке ${attempt} (${timeout/1000}с)`);
    } else {
      console.error(`❌ GLM ошибка на попытке ${attempt}: ${error.message}`);
    }

    if (attempt < MAX_RETRIES) {
      const waitTime = attempt * 5000; // 5с, 10с между попытками
      console.log(`⏳ Ждём ${waitTime/1000}с перед следующей попыткой...`);
      await new Promise(r => setTimeout(r, waitTime));
    }
  }
}

if (!glmData) {
  throw new Error(`GLM API не ответил после ${MAX_RETRIES} попыток: ${lastError?.message}`);
}

      const aiResponse = glmData.choices[0].message.content;

      let response;
      try {
        const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
        response = JSON.parse(jsonMatch ? jsonMatch[0] : aiResponse);
      } catch (e) {
        throw new Error(`Не удалось распарсить GLM: ${aiResponse}`);
      }

      const tasks = response.tasks || [response];
      console.log(`🤖 GLM вернул ${tasks.length} задач`);

      const createdTasks = [];

      for (const taskData of tasks) {
        console.log(`📋 Задача: "${taskData.title}" (can_execute: ${taskData.can_execute})`);

       if (taskData.can_execute) {
  // ✅ Пропускаем задачи без плана
  if (!taskData.execution_plan || 
      (Array.isArray(taskData.execution_plan) && taskData.execution_plan.length === 0)) {
    console.warn(`⚠️ Пропускаю задачу "${taskData.title}" — нет плана выполнения`);
    continue;
  }

  // ✅ Форматируем execution_plan (массив или строка)
  let executionPlanFormatted;
  if (Array.isArray(taskData.execution_plan)) {
    executionPlanFormatted = taskData.execution_plan
      .map((step, i) => {
        const cleanStep = String(step).trim();
        // Если шаг уже начинается с номера ("1. ", "1) ") или "Шаг N:" — не добавляем нумерацию
        if (/^(шаг\s*\d+[:\.\)]|\d+[\.\)])\s*/i.test(cleanStep)) {
          return cleanStep;
        }
        return `${i + 1}. ${cleanStep}`;
      })
      .join('<br>');
  } else {
    executionPlanFormatted = String(taskData.execution_plan || "Не указан")
      .replace(/\n+/g, '<br>')
      .replace(/<br><br>/g, '<br>');
  }

  // ✅ Формируем описание со всеми блоками
  const descriptionParts = [
    "🤖 <b>AI-агент может выполнить эту задачу автономно</b>",
    ""
  ];

  // Добавляем "Результат", если есть
  if (taskData.result && String(taskData.result).trim() && String(taskData.result).trim() !== 'Не применимо') {
    descriptionParts.push("<b>📊 Результат:</b>");
    descriptionParts.push(String(taskData.result).trim());
    descriptionParts.push("");
  }

  // Добавляем "Оценка времени", если есть
  if (taskData.estimated_time && String(taskData.estimated_time).trim() && String(taskData.estimated_time).trim() !== 'Не применимо') {
    descriptionParts.push("<b>⏱️ Оценка времени:</b>");
    descriptionParts.push(String(taskData.estimated_time).trim());
    descriptionParts.push("");
  }

  // План выполнения (всегда)
  descriptionParts.push("<b>📋 План выполнения:</b>");
  descriptionParts.push(executionPlanFormatted);
  descriptionParts.push("");

  // Инструменты
  descriptionParts.push("<b>🔧 Инструменты:</b>");
  descriptionParts.push(
    Array.isArray(taskData.tools_needed) 
      ? taskData.tools_needed.join(', ') 
      : (taskData.tools_needed || 'web_search')
  );
  descriptionParts.push("");

  // Инструкция
  descriptionParts.push("<b>✅ Для запуска:</b> переместите задачу в колонку 'К выполнению'");

  const description = descriptionParts.join('<br>');

  // ... остальной код (taskPayload, fetch и т.д.)

          const taskPayload = {
            title: taskData.title,
            description,
            columnId: process.env.COLUMN_AWAITING_CONFIRMATION,
            stickers: { [AI_STICKER_ID]: "empty" }
          };

          if (process.env.YOUGILE_GLM_USER_ID) {
            taskPayload.assigned = [process.env.YOUGILE_GLM_USER_ID];
          }

          console.log(`🔧 Отправляю задачу в YouGile...`);
console.log(`🔧 API ключ: ${process.env.YOUGILE_GLM_API_KEY ? 'YOUGILE_GLM_API_KEY ✓' : 'НЕ УСТАНОВЛЕН!'}`);
console.log(`🔧 Токен (первые 10 символов): ${process.env.YOUGILE_GLM_API_KEY?.substring(0, 10)}...`);
console.log(`🔧 columnId: "${process.env.COLUMN_AWAITING_CONFIRMATION}"`);
console.log(`🔧 assigned: [${process.env.YOUGILE_GLM_USER_ID}]`);

          const taskResponse = await fetch('https://rocketup.yougile.com/api-v2/tasks', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${process.env.YOUGILE_GLM_API_KEY}`
            },
            body: JSON.stringify(taskPayload)
          });

          const responseText = await taskResponse.text();
          console.log(`🔧 YouGile статус: ${taskResponse.status}`);

          if (!taskResponse.ok) {
            console.error(`❌ YouGile ошибка: ${taskResponse.status} - ${responseText}`);
            continue;
          }

          const taskResult = JSON.parse(responseText);
          createdTasks.push(taskResult.id);
          console.log(`✅ Задача для AI создана: ${taskResult.id}`);

        } else {
          console.log(`🔧 Создаю обычную задачу...`);
          const taskResult = await createYougileTask({
            title: taskData.title,
            result: taskData.result || "Не указано",
            estimated_time: taskData.estimated_time || "Не указано",
            steps: taskData.steps || ["Уточнить план"]
          });
          createdTasks.push(taskResult.id);
          console.log(`✅ Задача для человека создана: ${taskResult.id}`);
        }
      }

      // ✅ Перемещаем письма ТОЛЬКО если все задачи созданы успешно
if (createdTasks.length === tasks.length) {
  await mailClient.messageFlagsAdd(processedUids, ["\\Seen"], { uid: true });
  
  try {
    await mailClient.messageMove(processedUids, "AI_DONE", { uid: true });
    console.log(`📁 Перемещено в AI_DONE`);
  } catch (moveErr) {
    console.warn("⚠️ Не удалось переместить:", moveErr.message);
  }
  
  console.log(`✅ Создано ${createdTasks.length} задач из ${tasks.length}`);
  return createdTasks.length;
  
} else {
  // ❌ Не все задачи созданы — НЕ перемещаем письма
  console.warn(`⚠️ Создано только ${createdTasks.length} из ${tasks.length} задач`);
  console.warn(`⚠️ Письма НЕ перемещены в AI_DONE для повторной обработки`);
  
  // Помечаем как прочитанные, но НЕ перемещаем
  await mailClient.messageFlagsAdd(processedUids, ["\\Seen"], { uid: true });
  
  return createdTasks.length;
}

    } finally {
      lock.release();
    }

  } catch (error) {
    console.error("❌ Process mail error:", error);
    return 0;
  } finally {
    try {
      await mailClient.logout();
    } catch (e) {}
    isProcessing = false;
  }
}

// IDLE-цикл для мгновенной реакции
async function runIdleLoop() {
  while (true) {
    const mailClient = new ImapFlow({
      host: "imap.mail.ru",
      port: 993,
      secure: true,
      auth: {
        user: process.env.MAIL_USER,
        pass: process.env.MAIL_PASSWORD
      }
    });

    // ✅ Обработчик ошибок соединения
    mailClient.on('error', (err) => {
      console.error(`❌ IMAP connection error: ${err.message}`);
    });

    try {
      await mailClient.connect();
      const lock = await mailClient.getMailboxLock("INBOX");

      console.log("👂 IDLE: слушаю новые письма...");

      await new Promise((resolve) => {
        mailClient.on("exists", async () => {
          console.log("🔔 Новое письмо!");
          resolve();
        });
        setTimeout(resolve, 25 * 60 * 1000);
      });

      lock.release();
      await mailClient.logout();

      await processMail();

    } catch (e) {
      console.error("❌ IDLE error:", e.message);
      try { await mailClient.logout(); } catch (_) {}
    }

    await new Promise(r => setTimeout(r, 5000));
  }
}

// Запуск worker'а
async function startEmailWorker() {
  console.log("📧 Email worker запущен (IDLE + polling fallback)");

  setInterval(async () => {
    try {
      await processMail();
    } catch (e) {
      console.error("❌ Polling error:", e);
    }
  }, 2 * 60 * 1000);

  runIdleLoop().catch(e => console.error("IDLE loop crashed:", e));

  await processMail();
}

module.exports = { startEmailWorker, processMail, createYougileTask };
