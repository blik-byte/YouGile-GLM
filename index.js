// index.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());

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
