// lib/modx-client.js
// Клиент коннектора публикации MODX (modx/ai-publisher.connector.php).
//
// ДВА УРОВНЯ ЗАЩИТЫ СУЩЕСТВУЮЩЕГО КОНТЕНТА:
//   1. Серверный: коннектор в режиме create_only (по умолчанию) отклоняет
//      update/publish чужих ресурсов с 403, даже при верном токене.
//   2. Агентский: этот клиент ВООБЩЕ не отправляет такие запросы без одобренной
//      заявки из lib/approvals.js. Вместо действия он создаёт заявку,
//      уведомляет владельца в Telegram и возвращает модели «жди согласования».
//
// Поэтому случайная галлюцинация модели или ошибка промпта не могут привести
// к правке чужой страницы: оба контура должны быть пройдены осознанно.

const { fetchJson } = require('./http');
const { config } = require('./config');
const approvals = require('./approvals');
const { toStr } = require('./text');

function isConfigured() {
  return Boolean(config.modxPublisherUrl && config.modxPublisherToken);
}

function describeNotConfigured() {
  return 'Коннектор MODX не настроен: не заданы MODX_PUBLISHER_URL и MODX_PUBLISHER_TOKEN.';
}

/** Человекочитаемый диагноз по коду ответа коннектора или защиты хостинга. */
function diagnose(status, body) {
  const text = toStr(body).slice(0, 400);

  if (status === 412 || /hostia-antibot|защита против взлома/i.test(text)) {
    return (
      'Запрос заблокировала анти-бот защита хостинга (HTTP 412, «Хостия. Сработала защита против взлома»). ' +
      'Она стоит ПЕРЕД PHP и не пропускает серверные запросы с датацентровых IP. ' +
      'Нужно в панели хостинга добавить исключение для пути коннектора ' +
      '(/assets/components/aipublisher/) или попросить поддержку хостинга разрешить ' +
      'API-доступ к этому пути. Токен и код тут ни при чём.'
    );
  }
  if (status === 401) {
    return 'Коннектор отклонил токен: сверь MODX_PUBLISHER_TOKEN с настройкой MODX ai_publisher_token.';
  }
  if (status === 403) {
    return 'Сработала политика коннектора: действие над существующим контентом запрещено режимом create_only.';
  }
  if (status === 404) {
    return 'Ресурс не найден или путь коннектора неверен: проверь MODX_PUBLISHER_URL.';
  }
  if (status === 405) {
    return 'Действие доступно только методом POST.';
  }
  if (status === 500 && /config.core.php/i.test(text)) {
    return 'Коннектор не нашёл config.core.php: файл лежит вне дерева сайта MODX.';
  }
  return null;
}

async function request(action, { method = 'GET', body, query } = {}) {
  if (!isConfigured()) {
    return { success: false, error: describeNotConfigured() };
  }

  const url = new URL(config.modxPublisherUrl);
  url.searchParams.set('action', action);

  // GET с телом запрещён спецификацией fetch, поэтому чтения идут query-строкой:
  // коннектор читает id и из JSON-тела, и из $_GET
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
  }

  try {
    const result = await fetchJson(
      url.toString(),
      {
        method,
        headers: {
          Authorization: `Bearer ${config.modxPublisherToken}`,
          'Content-Type': 'application/json',
          'User-Agent': 'YouGileAIAgent/1.1 (publisher)',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      { timeout: 30000 }
    );

    if (!result.ok) {
      const hint = diagnose(result.status, result.text || result.data);
      return {
        success: false,
        status: result.status,
        error: hint || `Коннектор MODX ответил ${result.status}: ${toStr(result.text).slice(0, 200)}`,
        antibot: result.status === 412,
      };
    }

    return { success: true, ...result.data };
  } catch (error) {
    return { success: false, error: `Запрос к коннектору MODX не удался: ${error.message}` };
  }
}

/* ------------------------------------------------------------------ */
/* Чтения                                                              */
/* ------------------------------------------------------------------ */

async function ping() {
  return request('ping');
}

async function templates() {
  return request('templates');
}

async function getResource(id) {
  return request('resource', { query: { id: Number(id) } });
}

/* ------------------------------------------------------------------ */
/* Создание: разрешено всегда (черновики)                              */
/* ------------------------------------------------------------------ */

/**
 * Создание НОВОГО ресурса черновиком.
 * published принудительно 0: публикация — решение человека или отдельное
 * согласованное действие, но не побочный эффект генерации.
 */
async function createDraft(payload) {
  const safe = { ...payload, published: 0 };

  if (!toStr(safe.pagetitle).trim()) {
    return { success: false, error: 'Не задан pagetitle создаваемой страницы' };
  }

  return request('create', { method: 'POST', body: safe });
}

/**
 * Создание страницы по спеке из lib/page-builder.js.
 * Всегда черновиком: published принудительно 0 (политика владельца).
 * В ответ добавляется managerUrl — прямая ссылка на карточку ресурса в админке,
 * чтобы человек открыл и проверил результат одним кликом.
 */
async function createPage(spec) {
  const result = await createDraft({
    pagetitle: spec.pagetitle,
    longtitle: spec.longtitle,
    description: spec.description,
    introtext: spec.introtext,
    content: spec.content,
    alias: spec.alias,
    template: spec.template,
    parent: spec.parent,
    published: 0,
  });

  if (result.success && result.id) {
    try {
      const origin = new URL(config.modxPublisherUrl).origin;
      result.managerUrl = `${origin}/manager/?a=resource/update&id=${result.id}`;
    } catch {
      /* managerUrl необязателен */
    }
  }

  return { ...result, warnings: spec.warnings || [] };
}

/* ------------------------------------------------------------------ */
/* Защищённые действия: только через согласование                      */
/* ------------------------------------------------------------------ */

const ACTION_TO_KIND = {
  update: 'modx_update',
  publish: 'modx_publish_existing',
  unpublish: 'modx_unpublish',
};

/**
 * Действие над существующим ресурсом.
 *
 * Логика:
 *   1. Смотрим ресурс: если он создан агентом (agentOwned) — действие разрешено
 *      сразу, согласование не нужно (агент доводит до ума свой черновик).
 *   2. Иначе ищем одобренную заявку на это действие и объект. Есть — выполняем
 *      и «сжигаем» заявку: повторного права она не даёт.
 *   3. Иначе создаём заявку, уведомляем владельца и возвращаем pending.
 *      Запрос к коннектору при этом НЕ отправляется вовсе.
 *
 * @param {'update'|'publish'|'unpublish'} action
 * @param {object} params
 * @param {number} params.id
 * @param {object} [params.payload]
 * @param {string} params.reason - почему это нужно; уйдёт владельцу в Telegram
 * @param {string} [params.taskId]
 */
async function mutateExisting(action, { id, payload = {}, reason, taskId = null }) {
  const kind = ACTION_TO_KIND[action];
  if (!kind) {
    return { success: false, error: `Неизвестное защищённое действие: ${action}` };
  }

  if (!isConfigured()) {
    return { success: false, error: describeNotConfigured() };
  }

  const target = String(id);

  // 1. Свои черновики агент доводит сам
  const current = await getResource(id);
  if (current.success && current.resource?.agentOwned) {
    console.log(`🔓 Ресурс ${id} создан агентом — согласование не требуется`);
    return execute(action, { ...payload, id: Number(id) });
  }

  // 2. Одобренная ранее заявка
  const approved = await approvals.findApproved(kind, target);
  if (approved) {
    console.log(`🔓 Заявка ${approved.id} одобрена — выполняю ${action} над ресурсом ${id}`);
    const result = await execute(action, { ...payload, id: Number(id) });
    if (result.success) await approvals.consume(approved.id);
    return { ...result, approvalId: approved.id };
  }

  // 3. Заявки нет — действие НЕ выполняется, владелец получает запрос
  const request_ = await approvals.createRequest({
    kind,
    target,
    reason: toStr(reason, 'причина не указана'),
    taskId,
  });

  return {
    success: false,
    pending: true,
    requestId: request_.id,
    error:
      `Действие «${request_.kindLabel}» над ресурсом ${target} НЕ выполнено: требуется согласование. ` +
      `Заявка ${request_.id} отправлена владельцу в Telegram. ` +
      'Дождись /approve и повтори шаг — до этого момента контент не меняется.',
  };
}

async function execute(action, body) {
  if (action === 'update') return request('update', { method: 'POST', body });
  if (action === 'publish') return request('publish', { method: 'POST', body: { ...body, published: 1 } });
  if (action === 'unpublish') return request('publish', { method: 'POST', body: { ...body, published: 0 } });
  return { success: false, error: `Неизвестное действие: ${action}` };
}

/**
 * Состояние интеграции для дашборда и старта приложения.
 */
async function status() {
  if (!isConfigured()) {
    return { configured: false, error: describeNotConfigured() };
  }

  const pingResult = await ping();
  return {
    configured: true,
    reachable: pingResult.success === true,
    modxVersion: pingResult.modx_version || null,
    mode: pingResult.mode || null,
    siteUrl: pingResult.site_url || null,
    error: pingResult.success ? null : pingResult.error,
    antibot: Boolean(pingResult.antibot),
  };
}

module.exports = {
  isConfigured,
  ping,
  templates,
  getResource,
  createDraft,
  createPage,
  mutateExisting,
  status,
  diagnose,
};
