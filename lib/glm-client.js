// lib/glm-client.js
// Единственная точка обращения к GLM (Z.AI).
//
// Зачем: раньше эндпоинт https://api.z.ai/api/paas/v4/chat/completions был
// продублирован в 4 местах (ai-agent.js x3, email-worker.js, index.js) с разным
// набором багов. Здесь — один клиент с таймаутом и корректной обработкой 429.
//
// Ключевой исправленный баг: в старой ai-agent.js задержка считалась как
// `30000 * retryCount`, где retryCount на первой итерации равен 0, то есть
// агент мгновенно повторял запрос вместо ожидания и добивал rate limit.

const { fetchWithTimeout, sleep } = require('./http');
const { config } = require('./config');

const MAX_RETRIES = Number(process.env.GLM_MAX_RETRIES || 4);

/**
 * Модели по ролям.
 *   worker  — исполнитель: крутит цикл «шаг → инструмент», дёшево и быстро;
 *   planner — планировщик и рецензент: составляет план до выполнения и
 *             проверяет готовый отчёт перед публикацией;
 *   vision  — мультимодальная: скриншоты страниц, прайсы в PDF и сканах,
 *             таблицы на картинках.
 */
function modelFor(role) {
  switch (role) {
    case 'planner':
      return config.glmModelPlanner || config.glmModelWorker;
    case 'vision':
      return config.glmModelVision || config.glmModelWorker;
    default:
      return config.glmModelWorker;
  }
}

/** Ошибка «такой модели нет» или «роль недоступна» — повод уйти на worker. */
function isModelUnavailable(response) {
  const status = response.status;
  const body = String(response.body || '');
  return (
    status === 404 ||
    (status === 400 && /model.*(not (found|exist|supported)|invalid|unknown)/i.test(body)) ||
    (status === 403 && /model/i.test(body) && /not (available|supported)/i.test(body))
  );
}

class GlmError extends Error {
  constructor(message, { status, body, retryAfterSec } = {}) {
    super(message);
    this.name = 'GlmError';
    this.status = status;
    this.body = body;
    this.retryAfterSec = retryAfterSec;
  }
}

function parseRetryAfter(headers) {
  const raw = headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds;
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, Math.round((date - Date.now()) / 1000));
  return null;
}

/**
 * Грубая оценка размера контекста в символах.
 * Нужна, чтобы не уйти за лимит модели на длинных задачах (messages растёт
 * неограниченно — на 20+ шагах GLM отвечает 400).
 */
function estimateContextChars(messages) {
  let total = 0;
  for (const message of messages) {
    if (typeof message.content === 'string') total += message.content.length;
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        total += (call.function?.arguments || '').length + (call.function?.name || '').length;
      }
    }
  }
  return total;
}

/**
 * Урезание истории под лимит контекста.
 * Всегда сохраняет system-промпт и последнее сообщение, выбрасывает самые старые
 * пары assistant/tool из середины.
 *
 * @param {Array} messages
 * @param {number} maxChars
 */
function trimMessages(messages, maxChars = config.glmMaxContextChars) {
  let total = estimateContextChars(messages);
  if (total <= maxChars) return { messages, trimmed: 0 };

  const system = messages.filter((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');

  // Оставляем хвост, который помещается в бюджет (минус system)
  const budget = Math.max(10000, maxChars - estimateContextChars(system));
  const kept = [];
  let used = 0;
  for (let i = rest.length - 1; i >= 0; i--) {
    const size = estimateContextChars([rest[i]]);
    if (used + size > budget && kept.length >= 2) break;
    kept.unshift(rest[i]);
    used += size;
  }

  const trimmedCount = rest.length - kept.length;
  if (trimmedCount <= 0) return { messages, trimmed: 0 };

  const notice = {
    role: 'user',
    content:
      `[Служебное] Начало истории обрезано (${trimmedCount} сообщений), чтобы уложиться в контекст. ` +
      'Ранее сохранённые результаты лежат в базе — используй их, не повторяй уже выполненные шаги.',
  };

  return { messages: [...system, notice, ...kept], trimmed: trimmedCount };
}

/**
 * Запрос к GLM с таймаутом и экспоненциальным backoff.
 *
 * @param {object} params
 * @param {Array} params.messages
 * @param {Array} [params.tools]
 * @param {string} [params.toolChoice='auto']
 * @param {object} [params.responseFormat]
 * @param {number} [params.temperature]
 * @param {number} [params.timeout]
 * @returns {Promise<{message: object, usage: object, raw: object}>}
 */
async function chatCompletion(params) {
  const {
    messages,
    tools,
    toolChoice = 'auto',
    responseFormat,
    temperature,
    timeout = config.glmTimeoutMs,
  } = params;

  const role = params.role || 'worker';
  const requestedModel = params.model || modelFor(role);

  if (!config.zaiApiKey) {
    throw new GlmError('ZAI_API_KEY не задан', { status: 0 });
  }

  const { messages: trimmedMessages, trimmed } = trimMessages(messages);
  if (trimmed > 0) {
    console.log(`✂️ Контекст GLM обрезан: убрано ${trimmed} старых сообщений`);
  }

  const buildBody = (model) => {
    const body = { model, messages: trimmedMessages };
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = toolChoice;
    }
    if (responseFormat) body.response_format = responseFormat;
    if (temperature !== undefined) body.temperature = temperature;
    return body;
  };

  let body = buildBody(requestedModel);
  const url = `${config.glmBaseUrl}/chat/completions`;
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const startedAt = Date.now();
    try {
      const response = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.zaiApiKey}`,
          },
          body: JSON.stringify(body),
        },
        { timeout }
      );

      const text = await response.text();

      if (!response.ok) {
        let detail = text.slice(0, 500);
        const err = new GlmError(`GLM API ${response.status}: ${detail}`, {
          status: response.status,
          body: detail,
          retryAfterSec: parseRetryAfter(response.headers),
        });

        // Модель роли недоступна (её нет в API, снята с поддержки) — один раз
        // прозрачно уходим на worker, чтобы второстепенный шаг не ронял задачу
        if (
          config.glmRoleFallback &&
          body.model !== config.glmModelWorker &&
          isModelUnavailable({ status: response.status, body: text })
        ) {
          console.warn(
            `⚠️ Модель роли "${role}" (${body.model}) недоступна — продолжаю на ${config.glmModelWorker}`
          );
          body = buildBody(config.glmModelWorker);
          continue;
        }

        // 429 и 5xx — повторяем с задержкой. Прочие 4xx — нет: повтор бессмыслен.
        // (404 недоступной модели роли обрабатывается выше фолбэком на worker.)
        if (response.status === 429 || response.status >= 500) {
          lastError = err;
          if (attempt < MAX_RETRIES) {
            const delay = err.retryAfterSec
              ? err.retryAfterSec * 1000
              : Math.min(30000 * 2 ** attempt, 240000) + Math.floor(Math.random() * 1000);
            console.warn(
              `⏳ GLM ${response.status}, повтор ${attempt + 1}/${MAX_RETRIES} через ${Math.round(delay / 1000)}с`
            );
            await sleep(delay);
            continue;
          }
        }
        throw err;
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new GlmError('GLM вернул не-JSON', { status: response.status, body: text.slice(0, 200) });
      }

      const message = data?.choices?.[0]?.message;
      if (!message) {
        throw new GlmError('GLM вернул ответ без choices[0].message', {
          status: response.status,
          body: JSON.stringify(data).slice(0, 300),
        });
      }

      if (attempt > 0) {
        console.log(`✅ GLM ответил с ${attempt + 1}-й попытки за ${Date.now() - startedAt}мс`);
      }

      return { message, usage: data.usage || null, raw: data, model: body.model, role };
    } catch (error) {
      lastError = error;

      // Повторяем только таймауты и сетевые ошибки
      const retryable =
        error instanceof GlmError
          ? error.status === 429 || error.status >= 500
          : error.code === 'ETIMEDOUT' || error.name === 'AbortError' || error.code === 'ECONNRESET';

      if (!retryable || attempt >= MAX_RETRIES) throw error;

      const delay = Math.min(10000 * 2 ** attempt, 120000) + Math.floor(Math.random() * 1000);
      console.warn(
        `⏳ GLM недоступен (${error.message}), повтор ${attempt + 1}/${MAX_RETRIES} через ${Math.round(delay / 1000)}с`
      );
      await sleep(delay);
    }
  }

  throw lastError || new GlmError('GLM: неизвестная ошибка');
}

/**
 * Удобная обёртка для «одиночных» запросов без инструментов,
 * которые ожидают JSON (разбор письма, /assistant).
 */
async function chatJson(systemPrompt, userContent, options = {}) {
  const { message } = await chatCompletion({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    responseFormat: { type: 'json_object' },
    ...options,
  });

  const text = message.content || '';
  // Модели иногда оборачивают JSON в ```json ... ``` — вытаскиваем объект
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new GlmError(`Не удалось найти JSON в ответе модели: ${text.slice(0, 300)}`, { status: 200 });
  }

  try {
    return JSON.parse(match[0]);
  } catch (error) {
    throw new GlmError(`Не удалось разобрать JSON от модели: ${error.message}. Текст: ${text.slice(0, 300)}`, {
      status: 200,
    });
  }
}

module.exports = {
  chatCompletion,
  chatJson,
  trimMessages,
  estimateContextChars,
  modelFor,
  isModelUnavailable,
  GlmError,
};
