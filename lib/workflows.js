// lib/workflows.js
// Детерминированные сценарии согласованного конвейера.
//
// ПОЧЕМУ ЭТОТ ФАЙЛ СУЩЕСТВУЕТ.
// Раньше команда «собери черновик семантики по группе seo-wordpress» уходила
// свободному агенту, и модель импровизировала: собрала подсказки по seed
// «seo wordpress» (плагины, hostgator, meaning), проигнорировала каталог
// владельца и его 23 запроса с частотностями, не создала заявку на согласование.
// Согласованный процесс не может зависеть от того, какой инструмент модель
// сочтёт уместным. Поэтому ключевые сценарии стали жёсткими маршрутами:
// код ведёт шаг за шагом, а модель используется только там, где нужен текст.
//
// Маршруты:
//   semantics — черновик семантики из каталога владельца + заявка на согласование;
//   page      — страница по ОДОБРЕННОМУ черновику (гейты внутри);
//   seo_audit — механический SEO-аудит сайта + отчёт файлом + рекомендации;
//   всё остальное — прежний свободный агент.

const semantics = require('./semantics');
const pageBuilder = require('./page-builder');
const modx = require('./modx-client');
const executors = require('../tool-executors');
const { toStr } = require('./text');

/** Признаки сценария «черновик семантики». */
const SEMANTICS_PATTERN =
  /черновик\s+семантики|собери\s+семантику|семантик[ауи]\s+по\s+групп|семантическое\s+ядро|semantics?\s+draft/i;

/** Признаки сценария «создать страницу». */
const PAGE_PATTERN = /создай\s+страниц|страниц[ау]\s+по\s+черновику|страниц[ау]\s+по\s+кластер|site_page_create/i;

/** Признаки сценария «SEO-аудит сайта». */
const SEO_AUDIT_PATTERN =
  /seo[-\s]?аудит|аудит[аом]?\s+сайт|проведи\s+аудит|(?:site|website|seo)[\s-]?audit|audit\s+(?:of\s+)?(?:a\s+)?(?:web)?site/i;

/** Домены, которые не являются целью аудита (наша собственная инфраструктура). */
const STOP_DOMAINS = new Set([
  'onrender.com',
  'yougile.com',
  'yougile.ru',
  'rocketup.yougile.com',
  'telegram.org',
  'telegram.me',
  't.me',
  'z.ai',
  'api.z.ai',
]);

function detectWorkflow(text) {
  const value = toStr(text);
  if (PAGE_PATTERN.test(value)) return 'page';
  if (SEMANTICS_PATTERN.test(value)) return 'semantics';
  if (SEO_AUDIT_PATTERN.test(value)) return 'seo_audit';
  return null;
}

/**
 * Извлекает адрес сайта из текста задачи (чистая функция — тестируется).
 * Возвращает нормализованный hostname без протокола или null.
 * Email-адреса и собственная инфраструктура не принимаются за цель аудита.
 */
function extractDomain(text) {
  const value = toStr(text);
  const re = /(@)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})/gi;
  let match;

  while ((match = re.exec(value)) !== null) {
    if (match[1]) continue; // это email, пропускаем
    const host = match[2].toLowerCase().replace(/\.$/, '');
    if (!host || host.length > 253) continue;
    if (STOP_DOMAINS.has(host) || [...STOP_DOMAINS].some((stop) => host.endsWith(`.${stop}`))) continue;
    return host;
  }

  return null;
}

/** Ищет группу каталога, упомянутую в тексте задачи. */
function detectGroup(text) {
  const value = toStr(text).toLowerCase();
  let catalog;
  try {
    catalog = semantics.loadCatalog();
  } catch {
    return null;
  }

  const groups = catalog.sections.flatMap((section) => section.groups);

  // Точное совпадение id или названия, затем — упоминание названия в тексте
  for (const group of groups) {
    if (value.includes(group.id)) return group;
  }
  for (const group of groups) {
    const title = group.title.toLowerCase();
    if (title && value.includes(title)) return group;
  }

  // Упоминание подкатегории относит к её группе
  for (const group of groups) {
    for (const sub of group.subcategories || []) {
      const head = sub.split(',')[0].trim().toLowerCase();
      if (head.length > 4 && value.includes(head)) return group;
    }
  }

  return null;
}

/** Извлекает id черновика (8 hex-символов) и кластер в кавычках. */
function parsePageRequest(text) {
  const value = toStr(text);
  const draftMatch = value.match(/\b([a-f0-9]{8})\b/i);
  const clusterMatch = value.match(/кластер[^\«"']*[«"']([^»"']+)[»"']/i);

  return {
    draftId: draftMatch ? draftMatch[1].toLowerCase() : null,
    cluster: clusterMatch ? clusterMatch[1].trim() : null,
    kind: /стать|блог|article/i.test(value) ? 'article' : 'promo',
  };
}

/**
 * Сценарий «черновик семантики».
 * Всегда использует каталог владельца, всегда создаёт заявку на согласование
 * и всегда прикладывает файл черновика (или честно пишет, почему не смог).
 *
 * @returns {Promise<{summary:string, ok:boolean}>}
 */
async function runSemanticsWorkflow(taskId, text) {
  const group = detectGroup(text);

  if (!group) {
    let available = '';
    try {
      const catalog = semantics.loadCatalog();
      available = catalog.sections
        .map((section) => `${section.title}: ${section.groups.map((g) => g.id).join(', ')}`)
        .join(' | ');
    } catch {
      /* каталог недоступен */
    }
    return {
      ok: false,
      summary:
        'Не понял, по какой группе каталога собирать черновик. Укажи id или название группы, ' +
        `например «по группе seo-wordpress». Доступно: ${available}`,
    };
  }

  const draft = await semantics.buildDraft({
    groups: group.id,
    expand: true,
    taskId,
    comment: `Черновик по группе «${group.title}» собран автоматически по каталогу владельца.`,
  });

  if (!draft.success) {
    return { ok: false, summary: `Не удалось собрать черновик: ${draft.error}` };
  }

  const draftGroup = draft.groups[0];
  const ownerTop = draftGroup.queries
    .filter((query) => query.freqSource === 'owner')
    .slice(0, 8)
    .map((query) => `${query.q} (${query.freq})`)
    .join('; ');

  // Файл черновика создаёт САМ сценарий, а не модель по настроению
  let documentLine = '';
  try {
    const tables = [
      {
        name: group.title.slice(0, 31),
        headers: ['Запрос', 'Частотность', 'Источник частотности', 'W', 'Интент', 'Статус'],
        rows: draftGroup.queries.map((query) => [
          query.q,
          query.freq === null ? '' : String(query.freq),
          query.freqSource === 'owner' ? 'владелец' : 'кандидат (частотность не снята)',
          query.w === null || query.w === undefined ? '' : String(query.w),
          query.intent,
          'в черновике',
        ]),
      },
    ];

    const doc = await executors.createDocument(
      'xlsx',
      `semantics-${group.id}-${draft.id}`,
      `Черновик семантики: ${group.title}`,
      '',
      tables
    );

    documentLine = doc.success
      ? `📎 Файл черновика: ${doc.link}`
      : `⚠️ Файл черновика создать не удалось: ${doc.error || doc.hint || 'неизвестная ошибка'}`;
  } catch (error) {
    documentLine = `⚠️ Файл черновика создать не удалось: ${error.message}`;
  }

  const summary =
    `📋 Черновик семантики ${draft.id} по группе «${group.title}».\n\n` +
    `Запросов владельца (с твоими частотностями): ${draftGroup.ownerQueries}.\n` +
    `Кандидатов из подсказок (частотности снимаешь ты): ${draftGroup.suggestedQueries}.\n` +
    `Топ твоих запросов: ${ownerTop || 'нет'}.\n\n` +
    `${documentLine}\n\n` +
    `Дальше: скачать файл, проставить частотности кандидатам и прислать .xlsx обратно — ` +
    `в Telegram ответом на уведомление о черновике или кнопкой «Загрузить частотности» ` +
    `(подпись с id не обязательна, бот определит черновик сам). ` +
    `Затем одобрить командой /approve ${draft.approvalId}. ` +
    'Страницы по черновику создаются только после одобрения.';

  return { ok: true, summary, draftId: draft.id, approvalId: draft.approvalId };
}

/**
 * Сценарий «страница по одобренному черновику».
 * Гейты (одобрение, принадлежность кластера) обеспечивает site_page_create.
 */
async function runPageWorkflow(taskId, text) {
  const parsed = parsePageRequest(text);

  if (!parsed.draftId || !parsed.cluster) {
    return {
      ok: false,
      summary:
        'Для создания страницы нужны id одобренного черновика и кластер в кавычках, например: ' +
        '«создай страницу по черновику 1a2b3c4d, кластер "продвижение сайта на вордпресс"».',
    };
  }

  const result = await executors.sitePageCreate({
    draftId: parsed.draftId,
    cluster: parsed.cluster,
    kind: parsed.kind,
  });

  if (!result.success) {
    return { ok: false, summary: `Страница не создана: ${result.error}` };
  }

  const warnings = (result.warnings || []).length > 0 ? `\n⚠️ Замечания генератора: ${result.warnings.join('; ')}` : '';

  return {
    ok: true,
    summary:
      `📄 Страница создана ЧЕРНОВИКОМ (published=0).\n\n` +
      `ID ресурса: ${result.resourceId}\n` +
      `Alias: ${result.alias}\n` +
      `Title: ${result.pagetitle}\n` +
      `Description: ${result.description}\n` +
      `Шаблон: ${result.template}, родитель: ${result.parent}\n` +
      `Карточка в админке: ${result.managerUrl || 'см. дерево ресурсов'}\n` +
      `Частотность кластера (твоя): ${result.frequencyOwner ?? 'не снята'}${warnings}\n\n` +
      'Проверь текст в админке и опубликуй вручную, когда сочтёшь готовым.',
  };
}

/**
 * Сценарий «SEO-аудит сайта».
 * Детерминированный маршрут: механический аудит lib/seo-audit → отчёт .xlsx →
 * приоритетные рекомендации (модель, но только по фактам аудита; при сбое —
 * топ находок механически). Никакой свободной импровизации агента.
 */
const SEO_ADVICE_PROMPT =
  'Ты — технический SEO-аудитор. По результатам механического аудита (JSON) верни ТОЛЬКО JSON вида ' +
  '{"advice": ["рекомендация 1", "рекомендация 2", ...]} — 5-8 конкретных приоритетных рекомендаций ' +
  'владельцу сайта на русском языке, от самых важных к менее важным. Каждая рекомендация — одно ' +
  'предложение: что сделать и зачем. Оперируй ТОЛЬКО фактами из JSON, ничего не выдумывай.';

async function runSeoAuditWorkflow(taskId, text) {
  const domain = extractDomain(text);

  if (!domain) {
    return {
      ok: false,
      summary:
        'Не нашёл в тексте адрес сайта. Напиши явно, например: «Проведи SEO-аудит сайта example.ru».',
    };
  }

  const url = `https://${domain}`;
  console.log(`🔬 Сценарий seo_audit: ${url}`);

  let report;
  try {
    report = await executors.seoAudit(url);
  } catch (error) {
    report = { success: false, error: error.message };
  }

  if (!report || !report.success) {
    return {
      ok: false,
      summary: `SEO-аудит ${domain} не удался: ${report?.error || 'неизвестная ошибка'}. Проверь, что сайт доступен и адрес указан верно.`,
    };
  }

  const score = report.score || {};
  const byCategory = score.byCategory || {};
  const findings = Array.isArray(report.findings) ? report.findings : [];
  const errors = Array.isArray(report.errors) ? report.errors : [];
  const warnings = Array.isArray(report.warnings) ? report.warnings : [];
  const facts = report.facts || {};

  // Отчёт файлом — сценарий создаёт его сам, а не модель по настроению
  let documentLine = '';
  try {
    const summaryRows = [
      ['Сайт', domain],
      ['Проверенный URL', url],
      ['Итоговый балл', String(score.total ?? '')],
      ['Ошибок', String(errors.length)],
      ['Предупреждений', String(warnings.length)],
      ['Находок всего', String(findings.length)],
      ['Title', toStr(facts.title)],
      ['Title, длина', String(facts.titleLength ?? '')],
      ['Description, длина', String(facts.descriptionLength ?? '')],
      ['Слов на странице', String(facts.wordCount ?? '')],
      ['Микроразметка (типы)', (facts.schemaTypes || []).join(', ')],
      ...Object.entries(byCategory).map(([name, row]) => [
        `Категория: ${name}`,
        `${row && row.score !== undefined ? row.score : ''}`,
      ]),
    ];

    const doc = await executors.createDocument(
      'xlsx',
      `seo-audit-${domain}-${new Date().toISOString().slice(0, 10)}`,
      `SEO-аудит ${domain}`,
      '',
      [
        { name: 'Сводка', headers: ['Показатель', 'Значение'], rows: summaryRows },
        {
          name: 'Находки',
          headers: ['Важность', 'Проверка', 'Значение', 'Рекомендация'],
          rows: findings.map((finding) => [
            toStr(finding.severity),
            toStr(finding.check),
            toStr(finding.value),
            toStr(finding.recommendation),
          ]),
        },
        {
          name: 'Ошибки и предупреждения',
          headers: ['Тип', 'Текст'],
          rows: [
            ...errors.map((item) => ['ошибка', toStr(item)]),
            ...warnings.map((item) => ['предупреждение', toStr(item)]),
          ],
        },
      ]
    );

    documentLine = doc.success
      ? `📎 Полный отчёт: ${doc.link}`
      : `⚠️ Файл отчёта создать не удалось: ${doc.error || doc.hint || 'неизвестная ошибка'}`;
  } catch (error) {
    documentLine = `⚠️ Файл отчёта создать не удалось: ${error.message}`;
  }

  // Приоритетные рекомендации: модель — только по фактам аудита, с механическим откатом
  let advice = '';
  try {
    const { chatJson } = require('./glm-client');
    const parsed = await chatJson(
      SEO_ADVICE_PROMPT,
      JSON.stringify({
        domain,
        score: score.total,
        byCategory,
        errors,
        warnings,
        facts,
        findings: findings.slice(0, 40),
      }),
      { role: 'planner', timeout: 60000 }
    );
    if (parsed && Array.isArray(parsed.advice)) {
      advice = parsed.advice
        .map((item) => toStr(item).trim())
        .filter(Boolean)
        .slice(0, 8)
        .map((item, index) => `${index + 1}. ${item}`)
        .join('\n');
    }
  } catch (error) {
    console.warn(`⚠️ Рекомендации SEO-аудита: модель недоступна (${error.message}) — беру топ находок`);
  }

  if (!advice) {
    advice = findings
      .slice()
      .sort((a, b) => String(a.severity).localeCompare(String(b.severity)))
      .slice(0, 5)
      .map((finding, index) => `${index + 1}. [${toStr(finding.severity)}] ${toStr(finding.check)}: ${toStr(finding.recommendation)}`)
      .join('\n');
  }

  const categoriesLine = Object.entries(byCategory)
    .map(([name, row]) => `${name}: ${row && row.score !== undefined ? row.score : '?'}`)
    .join(', ');

  const summary =
    `🔍 SEO-аудит ${domain} выполнен.\n\n` +
    `Итоговый балл: ${score.total ?? '?'}/100 (ошибок: ${errors.length}, предупреждений: ${warnings.length}).\n` +
    (categoriesLine ? `Категории: ${categoriesLine}.\n` : '') +
    `\nПриоритетные рекомендации:\n${advice}\n\n${documentLine}`;

  return { ok: true, summary };
}

/**
 * Точка входа маршрутизации: возвращает null, если задача отдаётся свободному агенту.
 * @returns {Promise<{summary:string, ok:boolean}|null>}
 */
async function runDetectedWorkflow(taskId, title, description) {
  const text = `${title}\n${description}`;
  const workflow = detectWorkflow(text);

  if (workflow === 'semantics') return runSemanticsWorkflow(taskId, text);
  if (workflow === 'page') return runPageWorkflow(taskId, text);
  if (workflow === 'seo_audit') return runSeoAuditWorkflow(taskId, text);
  return null;
}

module.exports = {
  detectWorkflow,
  detectGroup,
  extractDomain,
  parsePageRequest,
  runSemanticsWorkflow,
  runPageWorkflow,
  runSeoAuditWorkflow,
  runDetectedWorkflow,
  SEMANTICS_PATTERN,
  PAGE_PATTERN,
  SEO_AUDIT_PATTERN,
};
