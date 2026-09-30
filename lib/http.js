// lib/http.js
// Единая обёртка над fetch: таймауты, ретраи, разбор JSON.
//
// Проблема, которую решает: в Node.js у fetch НЕТ таймаута по умолчанию.
// Любой зависший внешний сервис (Tavily, YouGile, pCloud, Telegram) оставлял
// промис висящим навсегда — например, флаг isProcessing в почтовом воркере
// залипал, и обработка почты останавливалась до рестарта dyno.

const DEFAULT_TIMEOUT = Number(process.env.HTTP_TIMEOUT_MS || 30000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * fetch с гарантированным таймаутом.
 * @param {string} url
 * @param {object} [options] - обычные опции fetch
 * @param {object} [extra]
 * @param {number} [extra.timeout] - мс, по умолчанию HTTP_TIMEOUT_MS или 30000
 * @param {AbortSignal} [extra.signal] - внешний сигнал (объединяется с таймаутом)
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options = {}, extra = {}) {
  const timeout = extra.timeout ?? DEFAULT_TIMEOUT;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  // Если пришёл внешний сигнал — пробрасываем его отмену внутрь
  if (extra.signal) {
    if (extra.signal.aborted) controller.abort();
    else extra.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error(`Таймаут запроса ${timeout}мс: ${url}`);
      e.code = 'ETIMEDOUT';
      e.cause = err;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * fetch + парсинг JSON + внятная ошибка со статусом и телом ответа.
 * @returns {Promise<{ok:boolean, status:number, data:any, text:string}>}
 */
async function fetchJson(url, options = {}, extra = {}) {
  const response = await fetchWithTimeout(url, options, extra);
  const text = await response.text();

  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null; // не JSON — вернём сырой текст в .text
    }
  }

  return { ok: response.ok, status: response.status, data, text };
}

/**
 * Запрос с повторами и экспоненциальной задержкой.
 * Повторяет при сетевых ошибках, таймаутах и статусах из retryStatuses.
 *
 * ВАЖНО: первая задержка НЕ равна нулю (баг ai-agent.js:220 в старой версии:
 * `30000 * retryCount` при retryCount=0 давал мгновенный повтор и добивал rate limit).
 *
 * @param {object} cfg
 * @param {() => Promise<any>} cfg.fn - функция запроса
 * @param {number} [cfg.retries=3] - сколько ДОПОЛНИТЕЛЬНЫХ попыток
 * @param {number} [cfg.baseDelay=2000] - базовая задержка, мс
 * @param {number} [cfg.maxDelay=60000]
 * @param {number[]} [cfg.retryStatuses=[429,500,502,503,504]]
 * @param {(info:{attempt:number, delay:number, error:Error}) => void} [cfg.onRetry]
 */
async function withRetry({
  fn,
  retries = 3,
  baseDelay = 2000,
  maxDelay = 60000,
  retryStatuses = [429, 500, 502, 503, 504],
  onRetry,
} = {}) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;

      const status = error.status;
      const retryable = !status || retryStatuses.includes(status);

      if (attempt >= retries || !retryable) throw error;

      // Уважение к Retry-After, если сервер его прислал
      let delay = Math.min(baseDelay * 2 ** attempt, maxDelay);
      if (error.retryAfterSec) delay = Math.max(delay, error.retryAfterSec * 1000);

      // Немного джиттера, чтобы параллельные запросы не синхронизировались
      delay += Math.floor(Math.random() * 500);

      if (onRetry) onRetry({ attempt: attempt + 1, delay, error });
      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Чтение тела с ограничением размера (защита от гигантских ответов).
 */
async function readBodyLimited(response, maxBytes = 10 * 1024 * 1024) {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.from(await response.text());

  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Ответ больше ${maxBytes} байт, чтение прервано`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

module.exports = { fetchWithTimeout, fetchJson, withRetry, readBodyLimited, sleep, DEFAULT_TIMEOUT };
