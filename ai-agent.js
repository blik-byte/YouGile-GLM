// ai-agent.js
const tools = require('./tools');
const executors = require('./tool-executors');

async function runAgent(taskId, taskTitle, taskDescription) {
  const messages = [
    {
      role: 'system',
      content: `Ты AI-агент, который выполняет задачи шаг за шагом.

Задача: ${taskTitle}
Описание: ${taskDescription}

Правила:
1. Используй инструменты для выполнения шагов
2. После каждого шага сохраняй результат через save_result
3. Добавляй комментарии о прогрессе через add_comment
4. Когда задача выполнена — вызови update_task_status("Готово")
5. Если ошибка — вызови update_task_status("Ошибка") и добавь комментарий с описанием

Действуй пошагово, не пытайся сделать всё сразу.`
    }
  ];

  let maxSteps = 20; // защита от бесконечного цикла
  
  while (maxSteps-- > 0) {
    const response = await fetch('https://api.z.ai/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.ZAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'glm-4.5-flash',
        messages,
        tools,
        tool_choice: 'auto'
      })
    });

    const data = await response.json();
    const msg = data.choices[0].message;

    // Если нет вызовов инструментов — задача завершена
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      console.log('✅ Агент завершил работу');
      return msg.content;
    }

    // Добавляем ответ агента в историю
    messages.push(msg);

    // Выполняем вызовы инструментов
    for (const call of msg.tool_calls) {
      const args = JSON.parse(call.function.arguments);
      console.log(`🔧 Вызов: ${call.function.name}`, args);

      let result;
      try {
        if (call.function.name === 'web_search') {
          result = await executors.webSearch(args.query);
        } else if (call.function.name === 'save_result') {
          result = await executors.saveResult(args.taskId, args.step, args.data);
        } else if (call.function.name === 'update_task_status') {
          result = await executors.updateTaskStatus(args.taskId, args.status);
        } else if (call.function.name === 'add_comment') {
          result = await executors.addComment(args.taskId, args.text);
        }
      } catch (error) {
        result = { error: error.message };
      }

      // Добавляем результат в историю
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result)
      });
    }
  }

  return 'Превышен лимит шагов';
}

module.exports = { runAgent };
