// index.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');

// ✅ Импорты (каждый ОДИН раз!)
const { startEmailWorker, processMail, createYougileTask } = require('./email-worker');
const { connectToMongo, getStats } = require('./db');
const { startTaskExecutorWorker } = require('./task-executor-worker');
const { getTaskResults } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());

// Просмотр результатов задачи
app.get('/task-results/:taskId', async (req, res) => {
  try {
    const results = await getTaskResults(req.params.taskId);
    res.json({ success: true, count: results.length, results });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/columns', async (req, res) => {
  try {
    const response = await fetch(
      'https://rocketup.yougile.com/api-v2/columns',
      {
        headers: {
          'Authorization': `Bearer ${process.env.YOUGILE_API_KEY}`
        }
      }
    );
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});



// 🔍 Поиск GLM-пользователя (можно удалить после настройки)
app.get('/find-glm-user', async (req, res) => {
  try {
    const response = await fetch(
      'https://rocketup.yougile.com/api-v2/tasks?limit=50',
      {
        headers: {
          'Authorization': `Bearer ${process.env.YOUGILE_API_KEY}`
        }
      }
    );
    
    const data = await response.json();
    const glmUsers = new Map();
    
    for (const task of data.items || []) {
      if (task.responsible && task.responsible.email?.includes('ai.assistant')) {
        glmUsers.set(task.responsible.id, {
          id: task.responsible.id,
          name: task.responsible.name,
          email: task.responsible.email
        });
      }
    }
    
    res.json({
      success: true,
      glmUsers: Array.from(glmUsers.values())
    });
    
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 🔧 Создание задачи из текста
app.post('/assistant', async (req, res) => {
  try {
    const userInput = req.body.text;

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
    
    let taskData;
    try {
      const jsonMatch = aiText.match(/\{[\s\S]*\}/);
      taskData = JSON.parse(jsonMatch ? jsonMatch[0] : aiText);
    } catch (e) {
      throw new Error(`Не удалось распарсить ответ ИИ: ${aiText}`);
    }

    const taskResult = await createYougileTask(taskData);

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

// 📧 Ручной запуск обработки почты
app.get('/process-mail', async (req, res) => {
  try {
    const created = await processMail();
    res.json({ success: true, created });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 🗄️ Проверка MongoDB
app.get('/db-check', async (req, res) => {
  try {
    await connectToMongo();
    const stats = await getStats();
    res.json({ success: true, stats });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 📊 Статистика
app.get('/stats', async (req, res) => {
  try {
    const stats = await getStats();
    res.json({ success: true, stats });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 🏓 Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Webhook для получения событий от YouGile
app.post('/webhook/yougile', async (req, res) => {
  try {
    console.log('📨 Получен webhook от YouGile:', JSON.stringify(req.body).substring(0, 300));
    
    const event = req.body;
    
    // Проверяем тип события
    if (event.event === 'chat.message.created') {
      const { chatId, message } = event.data;
      
      // Игнорируем сообщения от самого AI
      if (message.author?.email?.includes('ai.assistant')) {
        console.log(`💬 Игнорируем сообщение от AI в чате ${chatId}`);
        return res.json({ success: true, ignored: true });
      }
      
      console.log(`💬 Новое сообщение в чате ${chatId}: ${message.text?.substring(0, 100)}`);
      
      // Получаем задачу
      const taskResponse = await fetch(
        `https://rocketup.yougile.com/api-v2/tasks/${chatId}`,
        {
          headers: {
            'Authorization': `Bearer ${process.env.YOUGILE_GLM_API_KEY}`
          }
        }
      );
      
      if (!taskResponse.ok) {
        console.error(`❌ Не удалось получить задачу ${chatId}`);
        return res.json({ success: false, error: 'Task not found' });
      }
      
      const task = await taskResponse.json();
      
      // Проверяем, что задача в колонке "Готово" или "Вопросы к AI"
      const ALLOWED_COLUMNS = [process.env.COLUMN_DONE, process.env.COLUMN_QUESTIONS];
      if (!ALLOWED_COLUMNS.includes(task.columnId)) {
        console.log(`⏭️ Задача ${chatId} не в нужной колонке, пропускаем`);
        return res.json({ success: true, skipped: true });
      }
      
      // Получаем историю чата
      const chatResponse = await fetch(
        `https://rocketup.yougile.com/api-v2/chats/${chatId}/messages`,
        {
          headers: {
            'Authorization': `Bearer ${process.env.YOUGILE_GLM_API_KEY}`
          }
        }
      );
      
      if (!chatResponse.ok) {
        console.error(`❌ Не удалось получить чат ${chatId}`);
        return res.json({ success: false, error: 'Chat not found' });
      }
      
      const chatMessages = await chatResponse.json();
      
      // Формируем контекст для агента
      const chatContext = chatMessages.items
        .map(msg => `${msg.author?.name || 'Unknown'}: ${msg.text}`)
        .join('\n');
      
      console.log(`🤖 Запускаю агента для ответа на вопрос в задаче ${chatId}`);
      
      // Добавляем комментарий о начале работы
      await executors.addComment(chatId, '🤖 AI-агент обрабатывает ваш вопрос...');
      
      // Запускаем агента в режиме "ответ на вопрос"
      const { runAgentForQuestion } = require('./ai-agent');
      const answer = await runAgentForQuestion(
        chatId,
        task.title,
        task.description,
        chatContext
      );
      
      // Пишем ответ в чат
      await executors.addComment(chatId, `💡 Ответ:\n\n${answer}`);
      
      console.log(`✅ Ответ отправлен в чат задачи ${chatId}`);
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});


// 🚀 Запуск сервера + workers
app.listen(PORT, async () => {
  console.log(`✅ Server running on port ${PORT}`);
  await connectToMongo();
  startEmailWorker();
  startTaskExecutorWorker();
});
