// lib/yougile-client.js
// Единый клиент YouGile API.
//
// Зачем: раньше вызовы https://rocketup.yougile.com/api-v2/* были размазаны по
// четырём файлам, без таймаутов, с двумя разными именами API-ключа
// (YOUGILE_API_KEY в index.js против YOUGILE_GLM_API_KEY в остальных) и без
// пагинации — при >50 задачах в колонке часть просто не обрабатывалась.

const { fetchJson, withRetry } = require('./http');
const { textToHtml } = require('./text');
const { config } = require('./config');

function assertKey() {
  if (!config.yougileApiKey) {
    throw new Error('YouGile API-ключ не задан (ни YOUGILE_API_KEY, ни YOUGILE_GLM_API_KEY)');
  }
}

function headers(extra = {}) {
  assertKey();
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.yougileApiKey}`,
    ...extra,
  };
}

/**
 * Низкоуровневый запрос к YouGile с ретраями на 429/5xx.
 * @returns {Promise<{ok:boolean, status:number, data:any, text:string}>}
 */
async function request(method, path, { body, query, timeout } = {}) {
  const url = new URL(path.startsWith('http') ? path : `${config.yougileBaseUrl}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
  }

  return withRetry({
    retries: 2,
    baseDelay: 1500,
    onRetry: ({ attempt, delay, error }) =>
      console.warn(`⏳ YouGile ${method} ${url.pathname} — повтор ${attempt} через ${Math.round(delay / 1000)}с (${error.message})`),
    fn: async () => {
      const result = await fetchJson(
        url.toString(),
        {
          method,
          headers: headers(),
          body: body === undefined ? undefined : JSON.stringify(body),
        },
        { timeout: timeout || 20000 }
      );

      // Пробрасываем статус, чтобы withRetry понимал, что можно повторить
      if (!result.ok) {
        const error = new Error(
          `YouGile ${method} ${url.pathname} -> ${result.status}: ${(result.text || '').slice(0, 300)}`
        );
        error.status = result.status;
        throw error;
      }
      return result;
    },
  });
}

/**
 * Извлечение массива задач из ответа.
 * YouGile в разных версиях API отдаёт то {content:[...]}, то {items:[...]}, то голый массив.
 */
function extractList(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['content', 'items', 'tasks', 'data', 'result']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

/**
 * Какой параметр использует YouGile для постраничного обхода.
 * Определяется автоматически по ответу API и запоминается на время жизни процесса.
 *
 * Почему не жёстко задан: в продакшене запрос с параметром page получил ответ
 *   400 {"message":["property page should not exist"]}
 * — то есть сервер валидирует набор query-параметров по схеме и отвергает
 * неизвестные. Предполагаемый `offset` тоже может не поддерживаться, поэтому
 * первая же ошибка валидации отключает пагинацию с внятным сообщением в логе,
 * а не роняет весь опрос задач.
 */
let pagingParam = (process.env.YOUGILE_PAGE_PARAM || 'offset').trim();
let pagingDisabled = pagingParam === '' || pagingParam === 'none';

function isParamRejected(error) {
  return /should not exist|property .* not exist|Bad Request/i.test(String(error.message));
}

function disablePaging(param, error) {
  if (pagingDisabled) return;
  pagingDisabled = true;
  console.warn(
    `⚠️ YouGile отверг параметр постраничного обхода "${param}": ${error.message}\n` +
      '   Пагинация отключена — читается только первая страница (до YOUGILE_PAGE_SIZE задач).\n' +
      '   Если в колонке задач больше, укажите верный параметр через YOUGILE_PAGE_PARAM\n' +
      '   (варианты: offset, skip, from) или оставьте пустым для явного отключения.'
  );
}

/**
 * Извлечение метаданных постраничной выдачи.
 * YouGile возвращает объект paging; точная форма может отличаться, поэтому читаем осторожно.
 */
function readPaging(payload, fetched) {
  const paging = payload && typeof payload === 'object' ? payload.paging : null;
  if (!paging) return { total: null, hasMore: false };

  const total = Number(paging.count ?? paging.total ?? paging.totalCount);
  return {
    total: Number.isFinite(total) ? total : null,
    hasMore: Number.isFinite(total) ? fetched < total : false,
  };
}

/**
 * Список задач.
 * @param {object} [query] - columnId и прочие фильтры
 * @param {object} [opts]
 * @param {number} [opts.pageSize=50]
 * @param {number} [opts.maxPages=10] - защита от бесконечного цикла
 */
async function listTasks(query = {}, { pageSize = 50, maxPages = 10 } = {}) {
  const all = [];
  let offset = 0;

  for (let page = 0; page < maxPages; page++) {
    const params = { ...query, limit: pageSize };

    // Параметры постраничного обхода добавляем только со второй страницы:
    // первый запрос обязан проходить даже если API их не поддерживает
    if (page > 0 && !pagingDisabled) params[pagingParam] = offset;

    let data;
    try {
      ({ data } = await request('GET', '/tasks', { query: params }));
    } catch (error) {
      if (page > 0 && isParamRejected(error)) {
        disablePaging(pagingParam, error);
        break; // первая страница уже получена — возвращаем её
      }
      throw error;
    }

    const batch = extractList(data);
    all.push(...batch);
    offset += batch.length;

    if (batch.length === 0 || batch.length < pageSize) break;

    const { total, hasMore } = readPaging(data, all.length);
    if (total !== null && !hasMore) break;
    if (pagingDisabled) {
      if (total !== null && total > all.length) {
        console.warn(
          `⚠️ В выборке ${total} задач, прочитано ${all.length}. Пагинация отключена — ` +
            'задайте YOUGILE_PAGE_PARAM, чтобы обработать остальные.'
        );
      }
      break;
    }
  }

  return all;
}

async function getTask(taskId) {
  const { data } = await request('GET', `/tasks/${encodeURIComponent(taskId)}`);
  return data;
}

/**
 * Перемещение задачи в колонку.
 * @param {string} taskId
 * @param {string} columnId
 * @param {object} [extra] - например { completed: true }
 */
async function moveTask(taskId, columnId, extra = {}) {
  if (!columnId) {
    throw new Error(`Не задан ID колонки для задачи ${taskId}`);
  }
  const { data } = await request('PUT', `/tasks/${encodeURIComponent(taskId)}`, {
    body: { columnId, ...extra },
  });
  return data;
}

/** Словарь «человеческий статус» → ID колонки из окружения. */
const COLUMN_BY_STATUS = {
  Выполняется: () => config.columnExecuting,
  Готово: () => config.columnDone,
  Ошибка: () => config.columnError,
  'Ждёт подтверждения': () => config.columnAwaitingConfirmation,
  'К выполнению': () => config.columnToExecute,
};

async function setStatus(taskId, status) {
  const resolver = COLUMN_BY_STATUS[status];
  const columnId = resolver ? resolver() : null;

  if (!columnId) {
    return {
      success: false,
      error: `Неизвестный статус "${status}" или не задана соответствующая переменная COLUMN_*`,
    };
  }

  const extra = status === 'Готово' ? { completed: true } : {};
  const data = await moveTask(taskId, columnId, extra);
  return { success: true, columnId, data };
}

/**
 * Сообщение в чат задачи.
 * Текст экранируется перед вставкой в HTML — иначе любой символ '<' в ответе
 * модели ломал разметку (YouGile возвращал ошибку или сохранял кашу).
 */
async function addChatMessage(taskId, text, { label = 'AI', asHtml = false } = {}) {
  const plain = String(text ?? '');
  const { data } = await request('POST', `/chats/${encodeURIComponent(taskId)}/messages`, {
    body: {
      text: plain,
      textHtml: asHtml ? plain : `<p>${textToHtml(plain)}</p>`,
      label,
    },
  });
  return data;
}

async function getChatMessages(taskId) {
  const { data } = await request('GET', `/chats/${encodeURIComponent(taskId)}/messages`);
  return extractList(data);
}

async function listColumns() {
  const { data } = await request('GET', '/columns');
  return extractList(data);
}

/**
 * Создание задачи.
 * @param {object} task
 * @param {string} task.title
 * @param {string} [task.description]
 * @param {string} [task.columnId]
 * @param {string[]} [task.assigned]
 * @param {object} [task.stickers]
 */
async function createTask({ title, description = '', columnId, assigned, stickers }) {
  if (!title || !String(title).trim()) {
    throw new Error('Не задан заголовок задачи');
  }

  const payload = {
    title: String(title).slice(0, 500),
    description,
  };

  const targetColumn = columnId || config.columnDefault || config.columnAwaitingConfirmation;
  if (targetColumn) payload.columnId = targetColumn;

  const assignee = assigned || (config.yougileUserId ? [config.yougileUserId] : null);
  if (assignee && assignee.length > 0) payload.assigned = assignee;

  if (stickers) payload.stickers = stickers;
  else if (config.aiStickerId) payload.stickers = { [config.aiStickerId]: 'empty' };

  const { data } = await request('POST', '/tasks', { body: payload, timeout: 30000 });

  if (!data || !data.id) {
    throw new Error(`YouGile не вернул id созданной задачи: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data;
}

/**
 * Подписка на вебхуки — идемпотентная.
 * Старая версия создавала НОВУЮ подписку при каждом старте приложения, поэтому
 * после каждого деплоя в YouGile накапливался дубль и каждое сообщение чата
 * обрабатывалось N раз. Здесь сначала смотрим существующие подписки.
 */
async function ensureWebhook(event = 'chat_message-created') {
  const url = `${config.publicBaseUrl.replace(/\/$/, '')}/webhook/yougile`;

  let existing = [];
  try {
    const { data } = await request('GET', '/webhooks');
    existing = extractList(data);
  } catch (error) {
    console.warn(`⚠️ Не удалось прочитать список вебхуков: ${error.message}`);
  }

  const already = existing.find((hook) => hook?.url === url && (hook?.event === event || !hook?.event));
  if (already) {
    console.log(`✅ Вебхук ${event} уже подписан (id ${already.id})`);
    return already;
  }

  try {
    const { data } = await request('POST', '/webhooks', { body: { url, event } });
    console.log(`✅ Вебхук ${event} подписан: ${url}`);
    return data;
  } catch (error) {
    console.error(`❌ Не удалось подписаться на вебхук: ${error.message}`);
    return null;
  }
}

/** Общий счётчик задач по колонкам (для отчётов и дашборда). */
async function countByColumn(columnIds = {}) {
  const result = {};
  for (const [name, id] of Object.entries(columnIds)) {
    if (!id) continue;
    try {
      const { data } = await request('GET', '/tasks', { query: { columnId: id, limit: 1 } });
      result[name] = data?.paging?.count ?? extractList(data).length;
    } catch (error) {
      result[name] = { error: error.message };
    }
  }
  return result;
}

module.exports = {
  request,
  extractList,
  listTasks,
  getTask,
  moveTask,
  setStatus,
  addChatMessage,
  getChatMessages,
  listColumns,
  createTask,
  ensureWebhook,
  countByColumn,
  COLUMN_BY_STATUS,
};
