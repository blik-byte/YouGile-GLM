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
let executionPlanFormatted;
if (Array.isArray(taskData.execution_plan)) {
  // Если это массив — нумеруем пункты
  executionPlanFormatted = taskData.execution_plan
    .map((step, i) => `${i + 1}. ${step}`)
    .join('<br>');
} else {
  // Если это строка — просто заменяем переносы
  executionPlanFormatted = (taskData.execution_plan || "Не указан")
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

      // ✅ GLM с таймаутом 90 секунд
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 90000);

      let glmData;
      try {
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
  - execution_plan: массив подробных шагов (ОБЯЗАТЕЛЬНО массив строк!)
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

        if (!glmResponse.ok) {
          throw new Error(`GLM error: ${await glmResponse.text()}`);
        }

        glmData = await glmResponse.json();
      } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
          throw new Error('GLM API таймаут (90 сек)');
        }
        throw error;
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
          const executionPlan = (taskData.execution_plan || "Не указан")
            .replace(/\n+/g, '<br>')
            .replace(/<br><br>/g, '<br>');

          const description = [
            "🤖 <b>AI-агент может выполнить эту задачу автономно</b>",
            "<br>",
            "<b>📋 План выполнения:</b>",
            executionPlan,
            "<br>",
            "<b>🔧 Инструменты:</b>",
            taskData.tools_needed?.join(', ') || 'web_search',
            "<br>",
            "<b>✅ Для запуска:</b> переместите задачу в колонку 'К выполнению'"
          ].join('');

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
