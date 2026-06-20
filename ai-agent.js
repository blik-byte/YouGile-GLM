// ai-agent.js
const tools = require('./tools');
const executors = require('./tool-executors');

async function runAgent(taskId, taskTitle, taskDescription) {
  console.log(`🤖 Агент запущен для задачи: ${taskTitle}`);
  
  const messages = [
  {
    role: 'system',
    content: `Ты AI-агент, который выполняет задачи шаг за шагом.

Задача: ${taskTitle}
Описание: ${taskDescription}
ID задачи: ${taskId}

Правила:
1. Используй инструменты для выполнения шагов
2. После каждого важного шага сохраняй результат через save_result (используй taskId: ${taskId})
3. Добавляй комментарии о прогрессе через add_comment (используй taskId: ${taskId})
4. Когда задача выполнена — вызови update_task_status с taskId: ${taskId} и status: "Готово"
5. Если ошибка — вызови update_task_status с taskId: ${taskId} и status: "Ошибка"
6. Для web_search используй конкретные запросы, не общие фразы
7. НЕ повторяй один и тот же запрос
8. ВАЖНО: Всегда используй реальный ID задачи: ${taskId}, а не придумывай свой!

Действуй пошагово. После каждого шага думай, что делать дальше.`
  },
  {
    role: 'user',
    content: `Начни выполнение задачи с ID: ${taskId}. Используй инструменты для поиска информации и сохранения результатов.`
  }
];

  let maxSteps = 15;
  let stepCount = 0;
  
  while (maxSteps-- > 0) {
    stepCount++;
    console.log(`🔄 Шаг агента ${stepCount}...`);
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000);
    
    let data;
    try {
      // Формируем запрос правильно для GLM API
      const requestBody = {
        model: 'glm-4.5-flash',
        messages: messages,
        tools: tools,
        tool_choice: 'auto'
      };
      
      console.log(`📤 Отправляю запрос к GLM...`);
      console.log(`📤 Messages count: ${messages.length}`);
      
      const response = await fetch('https://api.z.ai/api/paas/v4/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.ZAI_API_KEY}`
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ GLM error ${response.status}: ${errorText}`);
        throw new Error(`GLM error ${response.status}`);
      }
      
      data = await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      console.error(`❌ GLM ошибка на шаге ${stepCount}: ${error.message}`);
      
      if (maxSteps > 0) {
        console.log(`⏳ Повтор через 5 сек...`);
        await new Promise(r => setTimeout(r, 5000));
        maxSteps++;
        continue;
      }
      throw error;
    }
    
    const msg = data.choices[0].message;

    // Если нет вызовов инструментов — задача завершена
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      console.log(`✅ Агент завершил работу на шаге ${stepCount}`);
      return msg.content || 'Задача выполнена';
    }

    // Добавляем ответ агента в историю
    messages.push(msg);

    // Выполняем вызовы инструментов
    for (const call of msg.tool_calls) {
      let args;
      try {
        args = JSON.parse(call.function.arguments);
      } catch (e) {
        console.error(`❌ Ошибка парсинга аргументов: ${call.function.arguments}`);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ error: 'Invalid arguments' })
        });
        continue;
      }
      
      console.log(`🔧 ${call.function.name}(${JSON.stringify(args).substring(0, 100)})`);

      let result;
      try {
        if (call.function.name === 'web_search') {
          result = await executors.webSearch(args.query);
        } else if (call.function.name === 'save_result') {
          result = await executors.saveResult(args.taskId || taskId, args.step, args.data);
        } else if (call.function.name === 'update_task_status') {
          result = await executors.updateTaskStatus(args.taskId || taskId, args.status);
        } else if (call.function.name === 'add_comment') {
          result = await executors.addComment(args.taskId || taskId, args.text);
        } else {
          result = { error: `Unknown tool: ${call.function.name}` };
        }
      } catch (error) {
        console.error(`❌ Ошибка выполнения ${call.function.name}: ${error.message}`);
        result = { error: error.message };
      }

      // Добавляем результат в историю
      const resultStr = JSON.stringify(result);
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: resultStr.length > 3000 ? resultStr.substring(0, 3000) + '...(обрезано)' : resultStr
      });
    }
  }

  return 'Превышен лимит шагов';
}

// Ответы в чате
async function runAgentForQuestion(taskId, taskTitle, taskDescription, chatContext) {
  console.log(`🤖 Агент запущен для ответа на вопрос в задаче: ${taskTitle}`);
  
  const messages = [
    {
      role: 'system',
      content: `Ты AI-агент, который отвечает на вопросы по выполненной задаче.

Задача: ${taskTitle}
Описание: ${taskDescription}

История чата:
${chatContext}

Правила:
1. Ответь на последний вопрос пользователя
2. Если нужен дополнительный поиск — используй web_search
3. Будь краток и по делу
4. Если вопрос не по теме задачи — вежливо уточни`
    },
    {
      role: 'user',
      content: 'Ответь на последний вопрос из чата.'
    }
  ];

  let maxSteps = 5;
  let stepCount = 0;
  
  while (maxSteps-- > 0) {
    stepCount++;
    console.log(`🔄 Шаг агента (ответ на вопрос) ${stepCount}...`);
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);
    
    let data;
    try {
      const requestBody = {
        model: 'glm-4.5-flash',
        messages: messages,
        tools: tools,
        tool_choice: 'auto'
      };
      
      const response = await fetch('https://api.z.ai/api/paas/v4/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.ZAI_API_KEY}`
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ GLM error ${response.status}: ${errorText}`);
        
        // ✅ При rate limit ждём дольше
        if (response.status === 429) {
          console.log(`⏳ Rate limit, ждём 30 сек...`);
          await new Promise(r => setTimeout(r, 30000));
          maxSteps++; // не считаем эту попытку
          continue;
        }
        
        throw new Error(`GLM error ${response.status}`);
      }
      
      data = await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      console.error(`❌ GLM ошибка: ${error.message}`);
      if (maxSteps > 0) {
        await new Promise(r => setTimeout(r, 3000));
        maxSteps++;
        continue;
      }
      throw error;
    }
    
    const msg = data.choices[0].message;

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      console.log(`✅ Агент завершил ответ на шаге ${stepCount}`);
      return msg.content || 'Ответ сформирован';
    }

    messages.push(msg);

    for (const call of msg.tool_calls) {
      let args;
      try {
        args = JSON.parse(call.function.arguments);
      } catch (e) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ error: 'Invalid arguments' })
        });
        continue;
      }
      
      console.log(`🔧 ${call.function.name}(${JSON.stringify(args).substring(0, 100)})`);

      let result;
      try {
        if (call.function.name === 'web_search') {
          result = await executors.webSearch(args.query);
        } else {
          result = { error: `Unknown tool: ${call.function.name}` };
        }
      } catch (error) {
        result = { error: error.message };
      }

      const resultStr = JSON.stringify(result);
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: resultStr.length > 2000 ? resultStr.substring(0, 2000) + '...' : resultStr
      });
    }
  }

  return 'Превышен лимит шагов';
}

module.exports = { runAgent, runAgentForQuestion };
