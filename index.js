// index.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());

// 🔍 Найти ID стикера "Добавлено AI" автоматически
async function findAiStickerId() {
  try {
    const response = await fetch('https://rocketup.yougile.com/api-v2/stickers', {
      headers: {
        'Authorization': `Bearer ${process.env.YOUGILE_API_KEY}`
      }
    });
    
    if (!response.ok) {
      console.error('❌ Не удалось получить стикеры:', await response.text());
      return null;
    }
    
    const data = await response.json();
    console.log('📋 Все стикеры в YouGile:', JSON.stringify(data, null, 2));
    
    // Ищем стикер по названию
    const stickers = data.stickers || data.items || data;
    const aiSticker = Array.isArray(stickers) 
      ? stickers.find(s => s.title === 'Добавлено AI' || s.name === 'Добавлено AI')
      : null;
    
    if (aiSticker) {
      console.log(`✅ Найден стикер "Добавлено AI": ${aiSticker.id}`);
      return aiSticker.id;
    } else {
      console.log('❌ Стикер "Добавлено AI" не найден. Посмотрите список выше.');
      return null;
    }
  } catch (error) {
    console.error('❌ Ошибка поиска стикера:', error.message);
    return null;
  }
}

// Запускаем при старте сервера
let AI_STICKER_ID = null;
findAiStickerId().then(id => { AI_STICKER_ID = id; });

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

    // 2. Формируем описание для YouGile
 // 2. Формируем описание с явными переносами строк
// Замените формирование description на этот блок:
const description = [
  "🤖 <b>AI-анализ:</b>",
  "📊 <b>Результат:</b>",
  taskData.result || "—",
  "⏱️ <b>Оценка времени:</b>",
  taskData.estimated_time || "—",
  "📋 <b>План действий:</b>",
  taskData.steps?.map((step, i) => `${i + 1}. ${step}`).join('<br>') || "—"
].join('<br><br>');

// Лог для проверки (удалите после отладки)
console.log('📝 Generated description:\n', description);

    // 3. Создаём задачу в YouGile
    const yougileResponse = await fetch(
      'https://rocketup.yougile.com/api-v2/tasks',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.YOUGILE_API_KEY}` // ← YouGile токен
        },
        body: JSON.stringify({
          title: taskData.title,
          description: description, // ← теперь точно с переносами
          columnId: 'c34d4600-b9d8-4e07-ab3b-e2a024cc69d1'
        })
      }
    );

    if (!yougileResponse.ok) {
      const errorText = await yougileResponse.text();
      throw new Error(`YouGile API error: ${yougileResponse.status} - ${errorText}`);
    }

    const taskResult = await yougileResponse.json();

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
