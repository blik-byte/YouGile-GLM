// ai-agent.js
// Цикл выполнения агента: запрос к GLM → вызов инструментов → повтор.
//
// ИСПРАВЛЕН КРИТИЧЕСКИЙ БАГ: в прежней версии функция runAgent была объявлена
// ДВАЖДЫ (строки 6 и 138). В JavaScript объявления функций поднимаются, и
// последняя перезаписывает предыдущую, поэтому экспортировалась вторая версия —
// а она НЕ вызывала getPromptForTask(). В результате вся папка prompts/
// (seo.js, research.js, documents.js, human-tasks.js — 238 строк) не
// использовалась никогда: любые задачи выполнялись по одному универсальному промпту.
//
// Также исправлено:
//  C5 — задержка при rate limit больше не равна нулю на первой попытке
//       (было 30000 * retryCount при retryCount === 0) и счётчик ретраев
//       сбрасывается для каждого шага, а не копится на всю задачу.
//  M8 — история сообщений обрезается под лимит контекста.
//  M28 — результаты инструментов укорачиваются без разрыва JSON.

const tools = require('./tools');
const executors = require('./tool-executors');
const { getPromptForTask } = require('./prompts');
const { chatCompletion } = require('./lib/glm-client');
const { truncateJsonSafe, toStr } = require('./lib/text');
const db = require('./db');

const MAX_STEPS = Number(process.env.GLM_MAX_STEPS || 25);
const MAX_STEPS_FOR_QUESTION = Number(process.env.GLM_MAX_STEPS_QUESTION || 6);

/** Правила агента, общие для всех специализированных промптов. */
function buildSystemPrompt(taskId, taskTitle, taskDescription, specialistPrompt) {
  const base = specialistPrompt || '';

  return `${base}

---
## КОНТЕКСТ ЗАДАЧИ
Задача: ${taskTitle}
Описание: ${taskDescription || '(без описания)'}
ID задачи в YouGile: ${taskId}

## ОБЯЗАТЕЛЬНЫЕ ПРАВИЛА РАБОТЫ
1. Используй РЕАЛЬНЫЙ ID задачи: ${taskId}. Никогда не придумывай свой.
2. Работай пошагово: один шаг — один-два вызова инструментов.
3. После каждого содержательного шага сохраняй результат через save_result (step — короткое название шага).
4. Комментируй прогресс через add_comment — но не чаще одного раза на 2-3 шага, не засоряй чат.
5. Для web_search формулируй конкретные запросы. НЕ повторяй один и тот же запрос.
6. Если нужен документ — используй create_document и обязательно добавь ссылку на него в комментарий.
7. Когда ВСЁ выполнено — вызови update_task_status со status "Готово".
8. Если задача не может быть выполнена — вызови update_task_status со status "Ошибка" и объясни причину в комментарии.
9. Выполни ВСЕ шаги плана. Не останавливайся на середине.
10. В финальном ответе кратко перечисли, что сделано, и дай ссылки на созданные документы.`;
}

/**
 * Единая таблица вызова инструментов.
 * Чтобы добавить инструмент, достаточно одной записи здесь + объявления в tools.js.
 */
const TOOL_HANDLERS = {
  web_search: (args) => executors.webSearch(args.query),
  web_analysis: (args) => executors.webAnalysis(args.url, args.query),
  save_result: (args, ctx) => executors.saveResult(args.taskId || ctx.taskId, args.step, args.data),
  update_task_status: (args, ctx) => executors.updateTaskStatus(args.taskId || ctx.taskId, args.status),
  add_comment: (args, ctx) => executors.addComment(args.taskId || ctx.taskId, args.text),
  create_document: (args) =>
    executors.createDocument(args.format, args.filename, args.title || '', args.content || '', args.tables || []),
};

/**
 * Ядро агентского цикла — общее для выполнения задач и ответов в чате.
 *
 * @param {object} params
 * @param {Array} params.messages
 * @param {string} params.taskId
 * @param {string} params.mode - 'task' | 'question'
 * @param {number} [params.maxSteps]
 * @param {string[]} [params.allowedTools] - ограничить набор инструментов
 * @returns {Promise<{text:string, completed:boolean, steps:number, toolCalls:number, error?:string}>}
 */
async function agentLoop({ messages, taskId, mode, maxSteps, allowedTools }) {
  const availableTools = allowedTools
    ? tools.filter((tool) => allowedTools.includes(tool.function.name))
    : tools;

  let stepCount = 0;
  let toolCallCount = 0;
  let statusSetByAgent = null;

  const ctx = { taskId, mode };

  while (stepCount < maxSteps) {
    stepCount++;
    console.log(`🔄 [${mode}] Шаг ${stepCount}/${maxSteps}...`);

    let message;
    try {
      const result = await chatCompletion({
        messages,
        tools: availableTools,
        toolChoice: 'auto',
      });
      message = result.message;
    } catch (error) {
      console.error(`❌ [${mode}] GLM недоступен на шаге ${stepCount}: ${error.message}`);
      return {
        text: '',
        completed: false,
        steps: stepCount,
        toolCalls: toolCallCount,
        error: error.message,
      };
    }

    const toolCalls = message.tool_calls || [];

    // Модель закончила работу — финальный ответ
    if (toolCalls.length === 0) {
      console.log(`✅ [${mode}] Агент завершил работу на шаге ${stepCount}`);
      return {
        text: toStr(message.content, ''),
        completed: true,
        steps: stepCount,
        toolCalls: toolCallCount,
        statusSetByAgent,
      };
    }

    messages.push(message);

    for (const call of toolCalls) {
      const name = call.function?.name;
      toolCallCount++;

      let args;
      try {
        args = JSON.parse(call.function?.arguments || '{}');
      } catch {
        console.error(`❌ Ошибка разбора аргументов ${name}: ${call.function?.arguments}`);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ error: 'Некорректный JSON в аргументах. Передай валидный JSON.' }),
        });
        continue;
      }

      console.log(`🔧 ${name}(${truncateJsonSafe(args, 160)})`);

      const handler = TOOL_HANDLERS[name];
      let result;

      if (!handler) {
        result = { error: `Неизвестный инструмент: ${name}. Доступны: ${Object.keys(TOOL_HANDLERS).join(', ')}` };
      } else {
        try {
          result = await handler(args, ctx);
          if (name === 'update_task_status' && result?.success) statusSetByAgent = args.status;
        } catch (error) {
          console.error(`❌ Ошибка выполнения ${name}: ${error.message}`);
          result = { error: error.message };
        }
      }

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: truncateJsonSafe(result ?? { error: 'пустой результат' }, 3000),
      });
    }
  }

  console.warn(`⚠️ [${mode}] Превышен лимит шагов (${maxSteps})`);
  return {
    text: '',
    completed: false,
    steps: stepCount,
    toolCalls: toolCallCount,
    statusSetByAgent,
    error: `Превышен лимит шагов (${maxSteps})`,
  };
}

/**
 * Выполнение задачи из YouGile.
 * @returns {Promise<{text:string, completed:boolean, steps:number, toolCalls:number, error?:string}>}
 */
async function runAgent(taskId, taskTitle, taskDescription = '') {
  console.log(`🤖 Агент запущен для задачи: ${taskTitle}`);

  // ✅ Специализированный промпт по типу задачи (раньше этот вызов был в мёртвой
  // копии функции и не выполнялся никогда)
  let specialistPrompt;
  try {
    specialistPrompt = getPromptForTask(taskTitle, taskDescription);
  } catch (error) {
    console.warn(`⚠️ Не удалось подобрать промпт, использую базовый: ${error.message}`);
    specialistPrompt = '';
  }

  const runId = await db.logAgentRun({
    taskId: String(taskId),
    title: taskTitle,
    mode: 'task',
    promptType: 'specialist',
  });

  const messages = [
    { role: 'system', content: buildSystemPrompt(taskId, taskTitle, taskDescription, specialistPrompt) },
    {
      role: 'user',
      content: `Задача: ${taskTitle}\n\nОписание: ${taskDescription || '(пусто)'}\n\nID задачи: ${taskId}\n\nНачни выполнение.`,
    },
  ];

  const outcome = await agentLoop({
    messages,
    taskId: String(taskId),
    mode: 'task',
    maxSteps: MAX_STEPS,
  });

  // Сохраняем историю диалога — раньше saveChatHistory не вызывалась нигде (M12)
  await db.saveChatHistory(taskId, messages).catch((error) => {
    console.warn(`⚠️ Не удалось сохранить историю чата: ${error.message}`);
  });

  await db.updateAgentRun(runId, {
    completed: outcome.completed,
    steps: outcome.steps,
    toolCalls: outcome.toolCalls,
    error: outcome.error || null,
    resultLength: (outcome.text || '').length,
  });

  return outcome;
}

/**
 * Ответ на вопрос пользователя в чате уже выполненной задачи.
 * Набор инструментов ограничен поиском — статусы менять нельзя.
 */
async function runAgentForQuestion(taskId, taskTitle, taskDescription = '', chatContext = '') {
  console.log(`🤖 Агент отвечает на вопрос в задаче: ${taskTitle}`);

  const runId = await db.logAgentRun({
    taskId: String(taskId),
    title: taskTitle,
    mode: 'question',
  });

  const messages = [
    {
      role: 'system',
      content: `Ты AI-агент, который отвечает на вопросы пользователя по задаче.

Задача: ${taskTitle}
Описание: ${taskDescription || '(нет)'}
ID задачи: ${taskId}

История чата:
${chatContext}

Правила:
1. Ответь на ПОСЛЕДНИЙ вопрос пользователя.
2. Если нужны дополнительные данные — используй web_search или web_analysis.
3. Отвечай кратко и по делу, без воды.
4. Если вопрос не по теме задачи — вежливо уточни.
5. НЕ меняй статус задачи и не создавай документов, если об этом прямо не просят.`,
    },
    { role: 'user', content: 'Ответь на последний вопрос из чата.' },
  ];

  const outcome = await agentLoop({
    messages,
    taskId: String(taskId),
    mode: 'question',
    maxSteps: MAX_STEPS_FOR_QUESTION,
    allowedTools: ['web_search', 'web_analysis'],
  });

  await db.updateAgentRun(runId, {
    completed: outcome.completed,
    steps: outcome.steps,
    toolCalls: outcome.toolCalls,
    error: outcome.error || null,
  });

  return outcome.text || 'Не удалось сформировать ответ.';
}

module.exports = { runAgent, runAgentForQuestion, agentLoop, TOOL_HANDLERS, buildSystemPrompt };
