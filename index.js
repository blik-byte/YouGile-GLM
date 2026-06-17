// index.js
require('dotenv').config(); // Загружаем .env переменные

const express = require('express');
const { OpenAI } = require('openai'); // GLM работает через OpenAI-совместимый API

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Инициализация клиента для GLM (через OpenRouter или Zhipu)
const client = new OpenAI({
  baseURL: process.env.GLM_API_BASE || 'https://openrouter.ai/api/v1', // или https://open.bigmodel.cn/api/paas/v4/
  apiKey: process.env.GLM_API_KEY,
});

// 🎯 Ваш endpoint
app.post('/assistant', async (req, res) => {
  try {
    const userInput = req.body.text;

    // 1. Анализируем задачу через GLM
    const completion = await client.chat.completions.create({
      model: 'glm-4.5-flash', // или 'openai/gpt-4o-mini' если через OpenRouter
      messages: [
        {
          role: 'system',
          content: `
Верни ТОЛЬКО JSON без пояснений.

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
      response_format: { type: 'json_object' } // Гарантируем JSON-ответ
    });

    const aiText = completion.choices[0].message.content;
    const taskData = JSON.parse(aiText);

    // 2. Создаём задачу в YouGile
    const createTaskResponse = await fetch(
      'https://rocketup.yougile.com/api-v2/tasks',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.YOUGILE_API_KEY}`
        },
        body: JSON.stringify({
          title: taskData.title,
          columnId: 'c34d4600-b9d8-4e07-ab3b-e2a024cc69d1' // Ваша колонка
        })
      }
    );

    if (!createTaskResponse.ok) {
      const errorText = await createTaskResponse.text();
      throw new Error(`YouGile API error: ${createTaskResponse.status} - ${errorText}`);
    }

    const taskResult = await createTaskResponse.json();

    // 3. Отправляем успешный ответ
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

// 🏓 Health check для Render
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 🚀 Запуск сервера
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
