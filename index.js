// index.js
require('dotenv').config();

const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());

// 🔍 Найти ID стикера через задачу
async function findAiStickerFromTask() {
  const TASK_ID = '9aef04b1-c8ae-424f-9054-3ad30087c893'; // ← ID задачи, который вы нашли
  
  try {
    const response = await fetch(
      `https://rocketup.yougile.com/api-v2/tasks/${TASK_ID}`,
      {
        headers: {
          'Authorization': `Bearer ${process.env.YOUGILE_API_KEY}`
        }
      }
    );
    
    if (!response.ok) {
      console.error('❌ Ошибка получения задачи:', await response.text());
      return null;
    }
    
    const task = await response.json();
    
    // Выводим ВСЮ задачу — ищем где стикеры
    console.log('🔍 ПОЛНАЯ ЗАДАЧА (ищите поле stickers/stickerIds/labels):');
    console.log(JSON.stringify(task, null, 2));
    
    // Пробуем найти стикер в разных возможных полях
    const stickers = task.stickers || task.stickerIds || task.labels || task.tags;
    if (stickers && stickers.length > 0) {
      console.log('✅ Найдены стикеры/метки:', JSON.stringify(stickers, null, 2));
      
      // Ищем "Добавлено AI"
      const aiSticker = stickers.find(s => 
        s.title === 'Добавлено AI' || 
        s.name === 'Добавлено AI' ||
        s === 'Добавлено AI'
      );
      
      if (aiSticker) {
        const stickerId = typeof aiSticker === 'string' ? aiSticker : aiSticker.id;
        console.log(`🎯 ID стикера "Добавлено AI": ${stickerId}`);
        return stickerId;
      }
    }
    
    return null;
  } catch (error) {
    console.error('❌ Ошибка:', error.message);
    return null;
  }
}

// Запускаем при старте
findAiStickerFromTask();

// Создание задачи в YouGile
async function createYougileTask(taskData) {

  const AI_STICKER_ID =
    "c553a657-fa54-4532-9d02-4750e013005f";

  const description = [
    "🤖 <b>AI-анализ:</b>",
    "📊 <b>Результат:</b>",
    taskData.result || "—",
    "⏱️ <b>Оценка времени:</b>",
    taskData.estimated_time || "—",
    "📋 <b>План действий:</b>",
    taskData.steps?.map(
      (step, i) => `${i + 1}. ${step}`
    ).join("<br>") || "—"
  ].join("<br><br>");

  const response = await fetch(
    "https://rocketup.yougile.com/api-v2/tasks",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization":
          `Bearer ${process.env.YOUGILE_API_KEY}`
      },
      body: JSON.stringify({
        title: taskData.title,
        description,
        columnId:
          "c34d4600-b9d8-4e07-ab3b-e2a024cc69d1",
        stickers: {
          [AI_STICKER_ID]: "empty"
        }
      })
    }
  );

  return await response.json();

}

// Ваш endpoint
app.post('/assistant', async (req, res) => {
  try {
    const userInput = req.body.text;

    // 1. Запрос к GLM (Z.ai)
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
            content: `Верни ТОЛЬКО JSON без пояснений.
Формат:
{
  "title": "краткое название задачи",
  "task_type": "тип",
  "result": "что получится в итоге",
  "estimated_time": "оценка времени",
  "steps": ["шаг 1", "шаг 2", "шаг 3"]
}`
          },
          { role: 'user', content: userInput }
        ],
        response_format: { type: 'json_object' }
      })
    });

    if (!glmResponse.ok) {
      const errorText = await glmResponse.text();
      throw new Error(`GLM API error: ${glmResponse.status} - ${errorText}`);
    }

    const glmData = await glmResponse.json();
    const aiText = glmData.choices[0].message.content;
    
    // Парсим JSON с защитой от лишнего текста
    let taskData;
    try {
      const jsonMatch = aiText.match(/\{[\s\S]*\}/);
      taskData = JSON.parse(jsonMatch ? jsonMatch[0] : aiText);
    } catch (e) {
      throw new Error(`Не удалось распарсить ответ ИИ: ${aiText}`);
    }

    const taskResult = await createYougileTask(taskData);

    // 4. Успешный ответ
    console.log(`✅ Task created: "${taskData.title}" → YouGile ID: ${taskResult.id}`);
    res.json({
      success: true,
      taskId: taskResult.id,
      analysis: taskData
    });

  } catch (error) {
    console.error('❌ Assistant error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Health check для Render
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Запуск сервера — ОБЯЗАТЕЛЬНО
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

app.get("/check-mail", async (req, res) => {

  try {

    const mailClient = new ImapFlow({
      host: "imap.mail.ru",
      port: 993,
      secure: true,
      auth: {
        user: process.env.MAIL_USER,
        pass: process.env.MAIL_PASSWORD
      }
    });

    await mailClient.connect();

    let lock = await mailClient.getMailboxLock("AI");

    try {

      const messages = [];

      for await (let message of mailClient.fetch("1:*", {
        envelope: true,
        source: true
      })) {

        const parsed = await simpleParser(message.source);

        messages.push({
          subject: parsed.subject,
          text: parsed.text
        });

      }

      res.json({
        success: true,
        count: messages.length,
        messages
      });

    } finally {

      lock.release();

    }

    await mailClient.logout();

  } catch (error) {

    console.error(error);

    res.status(500).json({
      success: false,
      error: error.message
    });

  }

});

app.get("/process-mail", async (req, res) => {

  try {

    const mailClient = new ImapFlow({
      host: "imap.mail.ru",
      port: 993,
      secure: true,
      auth: {
        user: process.env.MAIL_USER,
        pass: process.env.MAIL_PASSWORD
      }
    });

    await mailClient.connect();

    let lock = await mailClient.getMailboxLock("AI");

    let mailText = "";
    const processedUids = [];

try {

for await (let message of mailClient.fetch("1:*", {
  uid: true,
  source: true
})) {

  const parsed = await simpleParser(message.source);

  mailText += (parsed.text || "").trim() + "\n";

  processedUids.push(message.uid);

}

    } finally {

      lock.release();

    }

await mailClient.logout();

if (processedUids.length === 0) {

  return res.json({
    success: true,
    created: 0,
    message: "Нет новых писем"
  });

}

const glmResponse = await fetch(
  "https://api.z.ai/api/paas/v4/chat/completions",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.ZAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "glm-4.5-flash",
      messages: [
        {
          role: "system",
          content: `Разбей текст на отдельные задачи.

Верни только JSON.

{
  "tasks": [
    {
      "title": "Название задачи"
    }
  ]
}`
        },
        {
          role: "user",
          content: mailText
        }
      ],
      response_format: {
        type: "json_object"
      }
    })
  }
);

if (!glmResponse.ok) {
  throw new Error(await glmResponse.text());
}

const glmData = await glmResponse.json();

const aiResponse =
  glmData.choices[0].message.content;

    const tasks = JSON.parse(aiResponse);

 const createdTasks = [];

for (const task of tasks.tasks) {

  const taskResult = await createYougileTask({
    title: task.title,
    result: "Создано из письма",
    estimated_time: "Не определено",
    steps: [
      "Проверить задачу"
    ]
  });

  createdTasks.push(taskResult.id);

}

if (processedUids.length > 0) {

  const lock2 =
    await mailClient.getMailboxLock("AI");

  try {

    await mailClient.messageMove(
      processedUids,
      "AI_DONE",
      { uid: true }
    );

  } finally {

    lock2.release();

  }

}

    await mailClient.logout();

    res.json({
      success: true,
      created: createdTasks.length
    });

  } catch (error) {

    res.status(500).json({
      success: false,
      error: error.message
    });

  }

});

