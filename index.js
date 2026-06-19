// index.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');

// ✅ Импортируем worker из отдельного файла
const { startEmailWorker, processMail } = require('./email-worker');

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

app.get("/process-mail", async (req, res) => {
  try {
    const created = await processMail();
    res.json({ success: true, created });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Запускаем после старта сервера
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  startEmailWorker(); // ← запускаем email worker
});
