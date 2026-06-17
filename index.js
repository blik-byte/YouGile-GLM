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

    // 1. Прямой запрос к GLM API (Zhipu)
    const glmResponse = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GLM_API_KEY}`
      },
      body: JSON.stringify({
        model: 'glm-4.5-flash',
        messages: [
          {
            role: 'system',
            content: `Верни ТОЛЬКО JSON без пояснений.
Формат:
{
  "title": "...",
  "task_type": "...",
  "result": "...",
  "estimated_time": "...",
  "steps": ["...", "...", "..."]
}
Сделай название задачи кратким и понятным.`
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
    
    // Парсим JSON-ответ от модели
    const taskData = JSON.parse(aiText);

    // 2. Создаём задачу в YouGile
    const yougileResponse = await fetch(
      'https://rocketup.yougile.com/api-v2/tasks',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.YOUGILE_API_KEY}`
        },
        body: JSON.stringify({
          title: taskData.title,
          columnId: 'c34d4600-b9d8-4e07-ab3b-e2a024cc69d1'
        })
      }
    );

    if (!yougileResponse.ok) {
      const errorText = await yougileResponse.text();
      throw new Error(`YouGile API error: ${yougileResponse.status} - ${errorText}`);
    }

    const taskResult = await yougileResponse.json();

    // 3. Успешный ответ
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
