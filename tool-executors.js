// tool-executors.js
// Реализация инструментов, которые агент вызывает через GLM function calling.
//
// Изменения:
//  • web_search переведён на цепочку провайдеров (lib/search.js) вместо
//    нерабочего DuckDuckGo Instant Answer API.
//  • добавлен web_analysis — глубокое чтение страницы (был заявлен в README
//    и в tools_needed, но не существовал: агент обещал то, чего нет).
//  • create_document грузит файлы в pCloud вместо Google Drive, у которого
//    Service Account не имеет квоты хранилища.
//  • все вызовы YouGile идут через lib/yougile-client (таймауты, ретраи,
//    экранирование HTML, пагинация).
//  • аргументы инструментов валидируются: раньше query.substring() падал,
//    если модель не передавала query.
//  • временные файлы удаляются гарантированно (try/finally).

const fs = require('fs/promises');
const path = require('path');

const { fetchWithTimeout } = require('./lib/http');
const db = require('./db');
const cloud = require('./lib/cloud');
const yougile = require('./lib/yougile-client');
const search = require('./lib/search');
const { fetchReadable } = require('./lib/web-content');
const { createDocx, createXlsx, createTxt, removeTemp } = require('./document-generator');
const { toStr, sanitizeFilename } = require('./lib/text');
const { config } = require('./lib/config');

/* ------------------------------------------------------------------ */
// web_search
/* ------------------------------------------------------------------ */

/**
 * Поиск в интернете.
 * @param {string} query
 * @param {object} [options]
 * @returns {Promise<object>} результаты или явная ошибка (никогда не «пусто и тихо»)
 */
async function webSearch(query, options = {}) {
  const normalized = toStr(query).trim();

  if (!normalized) {
    return {
      success: false,
      error: 'Не передан параметр query. Укажите конкретный поисковый запрос.',
    };
  }

  console.log(`🔍 Поиск: "${normalized.slice(0, 80)}"`);

  try {
    const result = await search.search(normalized, options);

    if (result.error) {
      return { success: false, query: normalized, error: result.error, providersTried: result.providersTried };
    }

    return { success: true, ...result };
  } catch (error) {
    console.error(`❌ webSearch: ${error.message}`);
    return { success: false, query: normalized, error: error.message };
  }
}

/* ------------------------------------------------------------------ */
// web_analysis
/* ------------------------------------------------------------------ */

/**
 * Чтение и анализ содержимого веб-страницы.
 *
 * Стратегия:
 *   1. Tavily Extract (если задан ключ) — справляется со страницами,
 *      где контент подгружается JavaScript.
 *   2. Собственное извлечение текста из HTML (lib/web-content.js) — без ключей.
 *   3. Если вопрос сформулирован — краткая выжимка по тексту через GLM.
 *
 * @param {string} url
 * @param {string} [question] - на что именно смотреть на странице
 */
async function webAnalysis(url, question = '') {
  const target = toStr(url).trim();

  if (!target) {
    return { success: false, error: 'Не передан параметр url.' };
  }

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return { success: false, error: `Некорректный URL: ${target}` };
  }

  if (!/^https?:$/.test(parsed.protocol)) {
    return { success: false, error: `Поддерживаются только http(s) ссылки, получено: ${parsed.protocol}` };
  }

  console.log(`📖 Анализ страницы: ${parsed.href.slice(0, 100)}`);

  try {
    // 1. Tavily Extract
    let content = null;
    let source = 'tavily-extract';

    const extracted = await search.tavilyExtract(parsed.href);
    if (extracted && extracted.length > 0 && toStr(extracted[0].content).length > 200) {
      content = toStr(extracted[0].content);
    }

    // 2. Собственное извлечение
    if (!content) {
      const readable = await fetchReadable(parsed.href, { timeout: config.searchTimeoutMs });
      content = readable.text;
      source = 'html-extract';

      return await finishAnalysis({
        url: parsed.href,
        source,
        title: readable.title,
        description: readable.description,
        headings: readable.headings,
        wordCount: readable.wordCount,
        content,
        question,
      });
    }

    // Для Tavily-пути заголовки берём из HTML, если получится
    let meta = { title: null, description: null, headings: [] };
    try {
      const readable = await fetchReadable(parsed.href, { timeout: 15000, maxChars: 2000 });
      meta = { title: readable.title, description: readable.description, headings: readable.headings };
    } catch {
      /* мета необязательна */
    }

    return await finishAnalysis({
      url: parsed.href,
      source,
      title: meta.title,
      description: meta.description,
      headings: meta.headings,
      wordCount: content.split(/\s+/).length,
      content,
      question,
    });
  } catch (error) {
    console.error(`❌ webAnalysis: ${error.message}`);
    return {
      success: false,
      url: parsed.href,
      error: error.message,
      hint: 'Попробуйте web_search по этой теме или найдите другой источник.',
    };
  }
}

/**
 * Если задан вопрос — просим GLM сделать выжимку по извлечённому тексту.
 * Без вопроса возвращаем структурированное содержимое страницы.
 */
async function finishAnalysis({ url, source, title, description, headings, wordCount, content, question }) {
  const maxContent = 12000;
  const body = content.length > maxContent ? content.slice(0, maxContent) : content;
  const truncated = content.length > maxContent;

  const result = {
    success: true,
    url,
    source,
    title,
    description,
    headings: (headings || []).slice(0, 40),
    wordCount,
    truncated,
  };

  const normalizedQuestion = toStr(question).trim();

  if (normalizedQuestion) {
    try {
      const { chatJson } = require('./lib/glm-client');
      const answer = await chatJson(
        'Ты аналитик. Ответь строго по содержимому страницы. Если данных нет — так и напиши, не выдумывай. ' +
          'Верни JSON: {"answer": "развёрнутый ответ", "key_facts": ["факт 1", "факт 2"], "confidence": "high|medium|low"}',
        `Вопрос: ${normalizedQuestion}\n\nURL: ${url}\nЗаголовок: ${title || '—'}\n\nСодержимое страницы:\n${body}`,
        { timeout: 60000 }
      );
      result.question = normalizedQuestion;
      result.answer = toStr(answer.answer);
      result.keyFacts = Array.isArray(answer.key_facts) ? answer.key_facts.slice(0, 15) : [];
      result.confidence = answer.confidence || 'unknown';
    } catch (error) {
      console.warn(`⚠️ Не удалось сформировать выжимку: ${error.message}`);
      result.question = normalizedQuestion;
      result.answer = null;
      result.analysisError = error.message;
      result.content = body;
    }
  } else {
    result.content = body;
  }

  return result;
}

/* ------------------------------------------------------------------ */
// analyze_image (мультимодальная модель)
/* ------------------------------------------------------------------ */

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg'];
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * Анализ изображения мультимодальной моделью (GLM-4.6V-Flash по умолчанию).
 *
 * Зачем: визуальная проверка опубликованной страницы (скриншот), разбор
 * прайс-листов и таблиц, присланных картинкой или сканом, извлечение данных
 * с диаграмм. Текстовая модель этого не видит вовсе.
 *
 * @param {string} url
 * @param {string} [question]
 */
async function analyzeImage(url, question = '') {
  const target = toStr(url).trim();
  if (!target) return { success: false, error: 'Не передан параметр url.' };

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return { success: false, error: `Некорректный URL: ${target}` };
  }

  if (!/^https?:$/.test(parsed.protocol)) {
    return { success: false, error: `Поддерживаются только http(s) ссылки, получено: ${parsed.protocol}` };
  }

  const normalizedQuestion = toStr(question).trim();
  console.log(`🖼️ Анализ изображения: ${parsed.href.slice(0, 100)}`);

  try {
    // Предпроверка: ссылка живая, это изображение и оно не гигантское.
    // Мультимодальная модель тянет картинку сама, но битая ссылка превратилась бы
    // в невнятную ошибку модели — лучше поймать её здесь и сообщить внятно.
    const probe = await fetchWithTimeout(
      parsed.toString(),
      { method: 'HEAD', headers: { 'User-Agent': 'YouGileAIAgent/1.1' } },
      { timeout: 15000 }
    );

    const contentType = probe.headers.get('content-type') || '';
    const contentLength = Number(probe.headers.get('content-length') || 0);
    const extension = path.extname(parsed.pathname).toLowerCase();

    const looksLikeImage =
      contentType.startsWith('image/') || IMAGE_EXTENSIONS.includes(extension);

    if (probe.ok && !looksLikeImage && !contentType.includes('octet-stream')) {
      return {
        success: false,
        url: parsed.href,
        error: `Ссылка ведёт не на изображение, а на ${contentType || 'неизвестный тип'}. ` +
          'Для анализа веб-страниц используй web_analysis, для изображений — прямую ссылку на картинку.',
      };
    }

    if (contentLength > MAX_IMAGE_BYTES) {
      return {
        success: false,
        url: parsed.href,
        error: `Изображение ${(contentLength / 1024 / 1024).toFixed(1)} МБ — больше лимита 8 МБ.`,
      };
    }

    const { chatCompletion } = require('./lib/glm-client');

    const instruction = normalizedQuestion
      ? `Ответь строго по изображению на вопрос: ${normalizedQuestion}\n` +
        'Верни JSON: {"answer": "развёрнутый ответ", "facts": ["факт 1", "факт 2"], "confidence": "high|medium|low"}'
      : 'Опиши содержимое изображения и извлеки из него все полезные данные ' +
        '(текст, цифры, таблицы, элементы интерфейса). Верни JSON: ' +
        '{"description": "описание", "facts": ["факт 1"], "extracted_text": "текст с изображения"}';

    const { message, model } = await chatCompletion({
      role: 'vision',
      messages: [
        {
          role: 'system',
          content:
            'Ты анализируешь изображения для бизнес-задач. Описывай только то, что реально видишь. ' +
            'Если данных на изображении нет — прямо скажи об этом, не выдумывай.',
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: instruction },
            { type: 'image_url', image_url: { url: parsed.href } },
          ],
        },
      ],
      timeout: 90000,
    });

    const raw = toStr(message.content);
    let structured = null;
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      structured = match ? JSON.parse(match[0]) : null;
    } catch {
      structured = null;
    }

    return {
      success: true,
      url: parsed.href,
      model,
      question: normalizedQuestion || null,
      answer: structured?.answer || structured?.description || raw,
      facts: Array.isArray(structured?.facts) ? structured.facts.slice(0, 20) : [],
      extractedText: structured?.extracted_text || null,
      confidence: structured?.confidence || null,
      raw: structured ? undefined : raw.slice(0, 4000),
    };
  } catch (error) {
    console.error(`❌ analyzeImage: ${error.message}`);
    return { success: false, url: parsed.href, error: error.message };
  }
}

/* ------------------------------------------------------------------ */
// seo_audit
/* ------------------------------------------------------------------ */

const seoAuditor = require('./lib/seo-audit');

/**
 * Механический SEO-аудит.
 * @param {string} [url] - одна страница (полный отчёт)
 * @param {string[]} [urls] - список страниц (сжатая сводка по каждой)
 * @param {boolean} [probeDomain]
 */
async function seoAudit(url, urls, probeDomain = true) {
  const list = Array.isArray(urls) && urls.length > 0 ? urls : url ? [url] : [];

  if (list.length === 0) {
    return { success: false, error: 'Передай url (строку) или urls (массив) для аудита.' };
  }

  if (list.length === 1) {
    console.log(`🔬 SEO-аудит: ${list[0]}`);
    const report = await seoAuditor.auditPage(list[0], { probeDomain });
    return report.success ? { success: true, ...report } : report;
  }

  console.log(`🔬 SEO-аудит ${list.length} страниц...`);
  const reports = [];

  for (const target of list.slice(0, 10)) {
    const report = await seoAuditor.auditPage(target, { probeDomain });

    if (!report.success) {
      reports.push({ url: target, success: false, error: report.error });
      continue;
    }

    reports.push({
      url: target,
      success: true,
      score: report.score.total,
      categories: Object.fromEntries(
        Object.entries(report.score.byCategory).map(([name, row]) => [name, row.score])
      ),
      errors: report.errors,
      warnings: report.warnings,
      topFindings: report.findings.slice(0, 5).map((f) => ({
        severity: f.severity,
        check: f.check,
        value: f.value,
        recommendation: f.recommendation,
      })),
      facts: {
        title: report.facts.title,
        titleLength: report.facts.titleLength,
        descriptionLength: report.facts.descriptionLength,
        wordCount: report.facts.wordCount,
        schemaTypes: report.facts.schemaTypes,
      },
    });
  }

  return { success: true, pageCount: reports.length, reports };
}

/* ------------------------------------------------------------------ */
// create_document
/* ------------------------------------------------------------------ */

const SUPPORTED_FORMATS = ['docx', 'xlsx', 'txt', 'md', 'csv', 'json'];

/**
 * Создание документа и загрузка в облако.
 * @returns {Promise<{success:boolean, link?:string, downloadLink?:string, filename?:string, error?:string}>}
 */
async function createDocument(format, filename, title = '', content = '', tables = []) {
  const fmt = toStr(format).trim().toLowerCase();
  const safeName = sanitizeFilename(toStr(filename).trim() || 'document', 'document');

  if (!SUPPORTED_FORMATS.includes(fmt)) {
    return {
      success: false,
      error: `Неподдерживаемый формат "${format}". Доступны: ${SUPPORTED_FORMATS.join(', ')}`,
    };
  }

  console.log(`📄 Создаю документ ${safeName}.${fmt}...`);

  let filePath = null;

  try {
    if (fmt === 'docx') {
      if (!toStr(content).trim() && !toStr(title).trim()) {
        return { success: false, error: 'Для docx нужно передать title или content' };
      }
      filePath = await createDocx(safeName, title, content);
    } else if (fmt === 'xlsx') {
      const rows = Array.isArray(tables) ? tables : [];
      if (rows.length === 0) {
        return {
          success: false,
          error: 'Для xlsx нужен непустой массив tables: [{name, headers, rows}]',
        };
      }
      filePath = await createXlsx(safeName, rows);
    } else if (fmt === 'txt') {
      if (!toStr(content).trim()) {
        return { success: false, error: 'Для txt нужно передать content' };
      }
      filePath = await createTxt(safeName, content);
    } else if (fmt === 'md') {
      filePath = await createTxt(safeName, content);
      filePath = await renameExtension(filePath, 'md');
    } else if (fmt === 'csv') {
      filePath = await createTxt(safeName, tablesToCsv(tables, content));
      filePath = await renameExtension(filePath, 'csv');
    } else if (fmt === 'json') {
      const json = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
      try {
        JSON.parse(json);
      } catch (error) {
        return { success: false, error: `content не является валидным JSON: ${error.message}` };
      }
      filePath = await createTxt(safeName, json);
      filePath = await renameExtension(filePath, 'json');
    }

    const finalName = `${safeName}.${fmt}`;

    // Облако: провайдер выбирается переменной CLOUD_PROVIDER (r2 | pcloud | none).
    // Google Drive убран — Service Account не имеет квоты хранилища.
    if (!cloud.isConfigured()) {
      // Документ создан, но отдать ссылку нечем. Возвращаем содержимое текстом,
      // чтобы результат не потерялся, и честно сообщаем о проблеме.
      const preview = toStr(content).slice(0, 4000);
      await removeTemp(filePath);

      return {
        success: false,
        error:
          'Облачное хранилище не настроено (CLOUD_PROVIDER=auto, ни R2, ни pCloud не заполнены). ' +
          'Документ создать удалось, но разместить его негде. ' +
          'Передайте содержимое текстом в комментарии к задаче и сообщите пользователю о проблеме.',
        filename: finalName,
        contentPreview: preview,
      };
    }

    const uploaded = await cloud.upload(filePath, finalName);

    if (!uploaded.success) {
      return {
        success: false,
        provider: uploaded.provider,
        filename: finalName,
        error: `Не удалось загрузить в облако (${uploaded.provider}): ${uploaded.error}`,
        hint: uploaded.hint || undefined,
      };
    }

    console.log(`✅ Документ доступен: ${uploaded.link || uploaded.downloadLink}`);

    return {
      success: true,
      provider: uploaded.provider,
      filename: uploaded.filename || finalName,
      fileId: uploaded.fileId ?? uploaded.key ?? null,
      size: uploaded.size,
      link: uploaded.link || uploaded.shortlink,
      shortlink: uploaded.shortlink || null,
      downloadLink: uploaded.downloadLink || null,
      publicLinkWarning: uploaded.publicLinkError || undefined,
    };
  } catch (error) {
    console.error(`❌ Ошибка создания документа: ${error.message}`);
    return { success: false, error: error.message };
  } finally {
    // Гарантированно убираем временный файл — раньше unlinkSync стоял вне
    // блока finally и при ошибке загрузки файл оставался в /tmp навсегда
    await removeTemp(filePath);
  }
}

async function renameExtension(filePath, newExt) {
  if (!filePath) return filePath;
  const target = filePath.replace(/\.[^.]+$/, `.${newExt}`);
  if (target === filePath) return filePath;
  await fs.rename(filePath, target);
  return target;
}

function tablesToCsv(tables, content) {
  if (toStr(content).trim()) return content;
  if (!Array.isArray(tables) || tables.length === 0) return '';

  const escape = (value) => {
    const str = toStr(value);
    return /[",\n;]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };

  return tables
    .map((table) => {
      const lines = [];
      if (Array.isArray(table.headers)) lines.push(table.headers.map(escape).join(';'));
      for (const row of table.rows || []) {
        lines.push((Array.isArray(row) ? row : [row]).map(escape).join(';'));
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

/* ------------------------------------------------------------------ */
// Сохранение результатов
/* ------------------------------------------------------------------ */

async function saveResult(taskId, step, data) {
  const id = toStr(taskId).trim();
  if (!id) {
    return { success: false, error: 'Не передан taskId. Используйте реальный ID задачи из контекста.' };
  }

  try {
    const insertedId = await db.saveTaskStep(id, toStr(step, 'без названия'), data);
    return { success: true, id: String(insertedId) };
  } catch (error) {
    console.error(`❌ saveResult: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/* ------------------------------------------------------------------ */
// YouGile
/* ------------------------------------------------------------------ */

async function updateTaskStatus(taskId, status) {
  const id = toStr(taskId).trim();
  const newStatus = toStr(status).trim();

  if (!id) return { success: false, error: 'Не передан taskId' };
  if (!newStatus) {
    return {
      success: false,
      error: 'Не передан status. Допустимые значения: Выполняется, Готово, Ошибка',
    };
  }

  console.log(`🔄 Статус задачи ${id} → ${newStatus}`);

  try {
    const result = await yougile.setStatus(id, newStatus);
    return result.success
      ? { success: true, taskId: id, status: newStatus }
      : { success: false, taskId: id, status: newStatus, error: result.error };
  } catch (error) {
    console.error(`❌ updateTaskStatus: ${error.message}`);
    return { success: false, taskId: id, error: error.message };
  }
}

async function addComment(taskId, text) {
  const id = toStr(taskId).trim();
  const body = toStr(text);

  if (!id) return { success: false, error: 'Не передан taskId' };
  if (!body.trim()) return { success: false, error: 'Пустой текст комментария' };

  console.log(`💬 Комментарий к задаче ${id} (${body.length} симв.)`);

  try {
    await yougile.addChatMessage(id, body, { label: 'AI' });
    return { success: true, taskId: id, length: body.length };
  } catch (error) {
    console.error(`❌ addComment: ${error.message}`);
    return { success: false, taskId: id, error: error.message };
  }
}

/**
 * Подписка на вебхуки YouGile.
 * Идемпотентная: раньше при каждом старте создавалась НОВАЯ подписка, поэтому
 * после каждого деплоя накапливался дубль и сообщения обрабатывались N раз.
 * URL больше не захардкожен — берётся из PUBLIC_BASE_URL.
 */
async function subscribeToWebhooks(event = 'chat_message-created') {
  return yougile.ensureWebhook(event);
}

/* ------------------------------------------------------------------ */
/* Диагностика (используется дашбордом и /stats)                       */
/* ------------------------------------------------------------------ */

async function getProviderStatus() {
  return {
    search: {
      providers: search.providerOrder(),
      tavily: Boolean(config.tavilyApiKey),
      brave: Boolean(process.env.BRAVE_API_KEY),
      googleCse: Boolean(process.env.GOOGLE_API_KEY && process.env.GOOGLE_CX),
      wikipedia: true,
    },
    cloud: await cloud.status(),
  };
}

module.exports = {
  webSearch,
  webAnalysis,
  analyzeImage,
  seoAudit,
  createDocument,
  saveResult,
  updateTaskStatus,
  addComment,
  subscribeToWebhooks,
  getProviderStatus,
  SUPPORTED_FORMATS,
};
