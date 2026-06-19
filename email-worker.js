// email-worker.js
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");

let isProcessing = false;
const AI_STICKER_ID = "c553a657-fa54-4532-9d02-4750e013005f";

// Функция создания задачи
async function createYougileTask(taskData, columnId = process.env.COLUMN_DEFAULT) {
  const description = [
    "🤖 <b>AI-анализ:</b>",
    "📊 <b>Результат:</b>",
    taskData.result || "—",
    "⏱️ <b>Оценка времени:</b>",
    taskData.estimated_time || "—",
    "📋 <b>План действий:</b>",
    taskData.steps?.map((step, i) => `${i + 1}. ${step}`).join("<br>") || "—"
  ].join("<br><br>");

  const response = await fetch("https://rocketup.yougile.com/api-v2/tasks", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.YOUGILE_API_KEY}`
    },
    body: JSON.stringify({
      title: taskData.title,
      description,
      columnId: columnId,
      stickers: { [AI_STICKER_ID]: "empty" },
      responsibleId: process.env.YOUGILE_GLM_USER_ID
    })
  });

  return await response.json();
}

// Основная функция обработки почты
async function processMail() {
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

  try {
    await mailClient.connect();
    console.log("✅ IMAP подключен");

    const lock = await mailClient.getMailboxLock("INBOX");
    
    try {
      const range = await mailClient.search({ seen: false });
      
      if (range.length === 0) {
        console.log("📭 Нет новых писем");
        return 0;
      }

      console.log(`📬 Найдено ${range.length} непрочитанных писем`);

      let mailText = "";
      const processedUids = [];

      for await (let message of mailClient.fetch(range, {
        uid: true,
        source: true
      })) {
        const parsed = await simpleParser(message.source);
        mailText += (parsed.text || "").trim() + "\n";
        processedUids.push(message.uid);
      }

      if (processedUids.length === 0) return 0;

// 🔍 ОТЛАДКА
console.log(`📧 UIDs писем: ${processedUids.join(', ')}`);
console.log(`📝 Текст письма (первые 300 символов): ${mailText.substring(0, 300)}`);

      // GLM анализирует
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
              content: `Проанализируй запрос и реши:
1. Можешь ли ты выполнить эту задачу АВТОНОМНО (используя поиск в интернете, анализ данных)?
2. Или это задача для человека (требует физических действий, звонков, встреч)?

Если можешь выполнить сам:
- can_execute: true
- execution_plan: подробный план шагов
- tools_needed: какие инструменты будешь использовать

Если задача для человека:
- can_execute: false
- result: что получится в итоге
- estimated_time: оценка времени
- steps: шаги для человека

Верни ТОЛЬКО JSON:
{
  "title": "название задачи",
  "can_execute": true/false,
  "execution_plan": "план для AI (если can_execute=true)",
  "tools_needed": ["web_search", "save_result"],
  "result": "результат (если can_execute=false)",
  "estimated_time": "время (если can_execute=false)",
  "steps": ["шаги (если can_execute=false)"]
}`
            },
            { role: 'user', content: mailText }
          ],
          response_format: { type: 'json_object' }
        })
      });

      if (!glmResponse.ok) {
        throw new Error(`GLM error: ${await glmResponse.text()}`);
      }

      const glmData = await glmResponse.json();
      const aiResponse = glmData.choices[0].message.content;

      let taskData;
      try {
        const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
        taskData = JSON.parse(jsonMatch ? jsonMatch[0] : aiResponse);
      } catch (e) {
        throw new Error(`Не удалось распарсить GLM: ${aiResponse}`);
      }

      console.log(`🤖 GLM вернул задачу: "${taskData.title}" (can_execute: ${taskData.can_execute})`);
// 🔍 ОТЛАДКА — полный ответ GLM
console.log(`🤖 Полный ответ GLM:`, JSON.stringify(taskData, null, 2));

      const createdTasks = [];

      if (taskData.can_execute) {
        // Задача для AI-агента — создаём в колонке "Ожидает подтверждения"
        const description = [
          "🤖 <b>AI-агент может выполнить эту задачу автономно</b>",
          "",
          "<b>📋 План выполнения:</b>",
          taskData.execution_plan || "Не указан",
          "",
          "<b>🔧 Инструменты:</b>",
          taskData.tools_needed?.join(', ') || 'web_search',
          "",
          "<b>✅ Для запуска:</b> переместите задачу в колонку 'К выполнению'"
        ].join('<br><br>');

        console.log(`🔧 Отправляю задачу в YouGile...`);
console.log(`🔧 columnId: "${process.env.COLUMN_AWAITING_CONFIRMATION}"`);
console.log(`🔧 title: "${taskData.title}"`);

const response = await fetch('https://rocketup.yougile.com/api-v2/tasks', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.YOUGILE_API_KEY}`
  },
  body: JSON.stringify({
    title: taskData.title,
    description,
    columnId: process.env.COLUMN_AWAITING_CONFIRMATION,
    stickers: { [AI_STICKER_ID]: "empty" },
    responsibleId: process.env.YOUGILE_GLM_USER_ID
  })
});

const responseText = await response.text();
console.log(`🔧 YouGile статус: ${response.status}`);
console.log(`🔧 YouGile ответ: ${responseText}`);

if (!response.ok) {
  console.error(`❌ YouGile ошибка: ${response.status} - ${responseText}`);
  throw new Error(`YouGile error: ${response.status} - ${responseText}`);
}

const taskResult = JSON.parse(responseText);
createdTasks.push(taskResult.id);
console.log(`✅ Задача для AI создана: ${taskResult.id}`);

      } else {
  // Обычная задача для человека
  console.log(`🔧 Создаю обычную задачу в колонку: "${process.env.COLUMN_DEFAULT}"`);
  const taskResult = await createYougileTask({
    title: taskData.title,
    result: taskData.result || "Не указано",
    estimated_time: taskData.estimated_time || "Не указано",
    steps: taskData.steps || ["Уточнить план"]
  });
  console.log(`🔧 YouGile ответ:`, JSON.stringify(taskResult));
  createdTasks.push(taskResult.id);
  console.log(`✅ Задача для человека создана: ${taskResult.id}`);
}

      await mailClient.messageFlagsAdd(processedUids, ["\\Seen"], { uid: true });

      try {
        await mailClient.messageMove(processedUids, "AI_DONE", { uid: true });
        console.log(`📁 Перемещено в AI_DONE`);
      } catch (moveErr) {
        console.warn("⚠️ Не удалось переместить:", moveErr.message);
      }

      console.log(`✅ Создано ${createdTasks.length} задач`);
      return createdTasks.length;

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

  // Polling каждые 2 минуты
  setInterval(async () => {
    try {
      await processMail();
    } catch (e) {
      console.error("❌ Polling error:", e);
    }
  }, 2 * 60 * 1000);

  // IDLE в фоне
  runIdleLoop().catch(e => console.error("IDLE loop crashed:", e));

  // Первая проверка сразу
  await processMail();
}

module.exports = { startEmailWorker, processMail, createYougileTask };
