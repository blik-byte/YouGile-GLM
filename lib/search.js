// lib/search.js
// Веб-поиск с цепочкой провайдеров.
//
// Что было не так раньше (баг H4): после Tavily код падал на
// https://api.duckduckgo.com/?q=... — это Instant Answer API, а не поиск.
// Он отвечает только на запросы про известные сущности («Эйфелева башня»),
// а для рабочих запросов возвращает пустой RelatedTopics. Хуже того:
// с IP дата-центров DuckDuckGo отдаёт страницу с капчей (HTTP 202), поэтому
// агент получал ПУСТОЙ результат и начинал выдумывать данные.
//
// Теперь: цепочка провайдеров с явным приоритетом, и если не сработал ни один —
// модель получает ЧЕСТНУЮ ошибку, а не пустой список результатов.

const { fetchJson, withRetry } = require('./http');
const { config } = require('./config');
const { toStr } = require('./text');

/** Нормализация результата к единой форме. */
function normalize({ query, answer, results, source, extra = {} }) {
  return {
    query,
    answer: toStr(answer, '') || null,
    results: (results || []).slice(0, config.searchMaxResults).map((item) => ({
      title: toStr(item.title).slice(0, 300),
      url: toStr(item.url),
      content: toStr(item.content).slice(0, 1200),
      ...(item.score !== undefined ? { score: item.score } : {}),
      ...(item.published ? { published: item.published } : {}),
    })),
    source,
    ...extra,
  };
}

/* ------------------------------------------------------------------ */
// Провайдер 1: Tavily — основной. 1000 запросов/месяц бесплатно.
/* ------------------------------------------------------------------ */

async function tavily(query, options = {}) {
  const depth = options.depth || process.env.TAVILY_SEARCH_DEPTH || 'basic';

  const body = {
    query,
    max_results: options.maxResults || config.searchMaxResults,
    include_answer: true,
    include_raw_content: false,
    search_depth: depth,
  };

  const { ok, status, data, text } = await fetchJson(
    'https://api.tavily.com/search',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Актуальный способ авторизации. Прежний (api_key в теле) объявлен устаревшим.
        Authorization: `Bearer ${config.tavilyApiKey}`,
      },
      body: JSON.stringify(body),
    },
    { timeout: config.searchTimeoutMs }
  );

  if (!ok) {
    const error = new Error(`Tavily ${status}: ${text.slice(0, 200)}`);
    error.status = status;
    throw error;
  }

  return normalize({
    query,
    answer: data.answer,
    results: (data.results || []).map((r) => ({
      title: r.title,
      url: r.url,
      content: r.content,
      score: r.score,
      published: r.published_date,
    })),
    source: 'tavily',
    extra: { depth },
  });
}

/* ------------------------------------------------------------------ */
// Провайдер 2: Brave Search API — 2000 запросов/месяц бесплатно.
/* ------------------------------------------------------------------ */

async function brave(query, options = {}) {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(options.maxResults || config.searchMaxResults));

  const { ok, status, data, text } = await fetchJson(
    url.toString(),
    {
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': process.env.BRAVE_API_KEY,
      },
    },
    { timeout: config.searchTimeoutMs }
  );

  if (!ok) {
    const error = new Error(`Brave ${status}: ${text.slice(0, 200)}`);
    error.status = status;
    throw error;
  }

  const items = data?.web?.results || [];
  return normalize({
    query,
    results: items.map((r) => ({ title: r.title, url: r.url, content: r.description })),
    source: 'brave',
  });
}

/* ------------------------------------------------------------------ */
// Провайдер 3: Google Custom Search — 100 запросов/день бесплатно.
/* ------------------------------------------------------------------ */

async function googleCse(query, options = {}) {
  const url = new URL('https://www.googleapis.com/customsearch/v1');
  url.searchParams.set('key', process.env.GOOGLE_API_KEY);
  url.searchParams.set('cx', process.env.GOOGLE_CX);
  url.searchParams.set('q', query);
  url.searchParams.set('num', String(Math.min(options.maxResults || 10, 10)));

  const { ok, status, data, text } = await fetchJson(url.toString(), {}, { timeout: config.searchTimeoutMs });

  if (!ok) {
    const error = new Error(`Google CSE ${status}: ${text.slice(0, 200)}`);
    error.status = status;
    throw error;
  }

  return normalize({
    query,
    results: (data.items || []).map((r) => ({
      title: r.title,
      url: r.link,
      content: r.snippet,
    })),
    source: 'google-cse',
  });
}

/* ------------------------------------------------------------------ */
// Провайдер 4: Wikipedia — без ключа, работает всегда.
/* ------------------------------------------------------------------ */

async function wikipedia(query, options = {}) {
  const limit = Math.min(options.maxResults || 5, 10);
  const languages = ['ru', 'en'];
  const results = [];
  let summary = null;

  for (const lang of languages) {
    const url = new URL(`https://${lang}.wikipedia.org/w/api.php`);
    url.searchParams.set('action', 'query');
    url.searchParams.set('list', 'search');
    url.searchParams.set('srsearch', query);
    url.searchParams.set('srlimit', String(limit));
    url.searchParams.set('format', 'json');
    url.searchParams.set('formatversion', '2');

    try {
      const { ok, data } = await fetchJson(
        url.toString(),
        {
          headers: {
            // Wikipedia требует осмысленный User-Agent с контактом — иначе отдаёт 403
            'User-Agent': 'YouGileAIAgent/1.1 (https://github.com/blik-byte/YouGile-GLM)',
            Accept: 'application/json',
          },
        },
        { timeout: config.searchTimeoutMs }
      );

      if (!ok || !data?.query?.search) continue;

      for (const item of data.query.search) {
        results.push({
          title: item.title,
          url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, '_'))}`,
          content: toStr(item.snippet).replace(/<[^>]+>/g, ''),
        });
      }

      // Краткая выжимка по первому совпадению — заменяет поле answer
      if (!summary && results.length > 0) {
        try {
          const rest = await fetchJson(
            `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
              results[0].title.replace(/ /g, '_')
            )}`,
            { headers: { 'User-Agent': 'YouGileAIAgent/1.1', Accept: 'application/json' } },
            { timeout: config.searchTimeoutMs }
          );
          if (rest.ok) summary = rest.data?.extract || null;
        } catch {
          /* выжимка необязательна */
        }
      }

      if (results.length > 0) break;
    } catch {
      continue;
    }
  }

  if (results.length === 0) {
    throw new Error('Wikipedia: ничего не найдено');
  }

  return normalize({ query, answer: summary, results, source: 'wikipedia' });
}

/* ------------------------------------------------------------------ */
/* Цепочка провайдеров                                                 */
/* ------------------------------------------------------------------ */

/**
 * Доступные провайдеры в порядке приоритета.
 * Порядок настраивается переменной SEARCH_PROVIDERS=tavily,brave,google,wikipedia
 */
const PROVIDERS = {
  tavily: { fn: tavily, available: () => Boolean(config.tavilyApiKey) },
  brave: { fn: brave, available: () => Boolean(process.env.BRAVE_API_KEY) },
  google: { fn: googleCse, available: () => Boolean(process.env.GOOGLE_API_KEY && process.env.GOOGLE_CX) },
  wikipedia: { fn: wikipedia, available: () => true },
};

function providerOrder() {
  const custom = toStr(process.env.SEARCH_PROVIDERS)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const order = custom.length > 0 ? custom : ['tavily', 'brave', 'google', 'wikipedia'];
  // Неизвестные имена игнорируем, отсутствующие ключи — пропускаем
  return order.filter((name) => PROVIDERS[name]);
}

/**
 * Поиск в интернете.
 * @param {string} query
 * @param {object} [options]
 * @param {number} [options.maxResults]
 * @param {'basic'|'advanced'} [options.depth]
 * @param {boolean} [options.skipCache]
 * @returns {Promise<object>}
 */
async function search(query, options = {}) {
  const normalizedQuery = toStr(query).trim();

  // Валидация: прежний код падал на query.substring(), если модель не передавала query
  if (!normalizedQuery) {
    return {
      query: '',
      answer: null,
      results: [],
      source: 'none',
      error: 'Пустой поисковый запрос. Передайте параметр query с конкретным текстом.',
    };
  }

  if (normalizedQuery.length < 2) {
    return {
      query: normalizedQuery,
      answer: null,
      results: [],
      source: 'none',
      error: 'Слишком короткий запрос. Сформулируйте конкретный поисковый запрос.',
    };
  }

  const db = require('../db');

  // Кэш на 7 дней — не тратим лимиты провайдеров на повторные запросы
  if (!options.skipCache) {
    try {
      const cached = await db.getCachedSearch(normalizedQuery);
      if (cached && Array.isArray(cached.results)) {
        console.log(`📦 Поиск из кэша: "${normalizedQuery.slice(0, 50)}"`);
        return { ...cached, from_cache: true };
      }
    } catch (error) {
      console.warn(`⚠️ Кэш поиска недоступен: ${error.message}`);
    }
  }

  const order = providerOrder();
  const available = order.filter((name) => PROVIDERS[name].available());

  if (available.length === 0) {
    // Честная ошибка вместо пустого результата: модель должна сообщить о проблеме,
    // а не выдумывать данные.
    return {
      query: normalizedQuery,
      answer: null,
      results: [],
      source: 'none',
      error:
        'Веб-поиск недоступен: не задан ни один API-ключ (TAVILY_API_KEY, BRAVE_API_KEY, GOOGLE_API_KEY+GOOGLE_CX). ' +
        'Сообщите пользователю, что поиск не настроен, и НЕ придумывайте данные.',
    };
  }

  const tried = [];
  let lastError = null;

  for (const name of available) {
    try {
      const result = await withRetry({
        retries: 1,
        baseDelay: 1000,
        retryStatuses: [429, 500, 502, 503, 504],
        fn: () => PROVIDERS[name].fn(normalizedQuery, options),
      });

      // Провайдер ответил, но результатов нет — пробуем следующего
      if (!result.results || result.results.length === 0) {
        tried.push({ provider: name, status: 'empty' });
        continue;
      }

      result.providersTried = [...tried, { provider: name, status: 'ok' }];
      console.log(`🔍 [${name}] "${normalizedQuery.slice(0, 50)}" → ${result.results.length} результатов`);

      try {
        await db.cacheSearch(normalizedQuery, result);
      } catch (error) {
        console.warn(`⚠️ Не удалось закэшировать поиск: ${error.message}`);
      }

      return result;
    } catch (error) {
      lastError = error;
      tried.push({ provider: name, status: 'error', error: error.message.slice(0, 150) });
      console.warn(`⚠️ Провайдер ${name} не сработал: ${error.message.slice(0, 150)}`);
    }
  }

  return {
    query: normalizedQuery,
    answer: null,
    results: [],
    source: 'none',
    providersTried: tried,
    error:
      `Ни один поисковый провайдер не вернул результатов. Последняя ошибка: ${
        lastError ? lastError.message : 'не найдено'
      }. ` +
      'Сообщите об этом в задаче и НЕ придумывайте данные. Попробуйте переформулировать запрос.',
  };
}

/**
 * Глубокое извлечение содержимого страницы через Tavily Extract.
 * Используется инструментом web_analysis, когда задан TAVILY_API_KEY:
 * Tavily умеет вытаскивать текст даже со страниц с клиентским рендерингом.
 */
async function tavilyExtract(urls) {
  if (!config.tavilyApiKey) return null;

  try {
    const { ok, data } = await fetchJson(
      'https://api.tavily.com/extract',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.tavilyApiKey}`,
        },
        body: JSON.stringify({ urls: Array.isArray(urls) ? urls : [urls], extract_depth: 'basic' }),
      },
      { timeout: Math.max(config.searchTimeoutMs, 45000) }
    );

    if (!ok || !data?.results?.length) return null;

    return data.results.map((item) => ({
      url: item.url,
      content: toStr(item.raw_content),
    }));
  } catch (error) {
    console.warn(`⚠️ Tavily extract: ${error.message}`);
    return null;
  }
}

module.exports = { search, tavily, brave, googleCse, wikipedia, tavilyExtract, providerOrder, PROVIDERS };
