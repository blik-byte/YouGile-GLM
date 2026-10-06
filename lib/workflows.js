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

function detectWorkflow(text) {
  const value = toStr(text);
  if (PAGE_PATTERN.test(value)) return 'page';
  if (SEMANTICS_PATTERN.test(value)) return 'semantics';
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
    `Дальше: просмотреть и поправить («убери …, добавь … с частотностью …»), затем одобрить командой /approve ${draft.approvalId}. ` +
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
 * Точка входа маршрутизации: возвращает null, если задача отдаётся свободному агенту.
 * @returns {Promise<{summary:string, ok:boolean}|null>}
 */
async function runDetectedWorkflow(taskId, title, description) {
  const text = `${title}\n${description}`;
  const workflow = detectWorkflow(text);

  if (workflow === 'semantics') return runSemanticsWorkflow(taskId, text);
  if (workflow === 'page') return runPageWorkflow(taskId, text);
  return null;
}

module.exports = {
  detectWorkflow,
  detectGroup,
  parsePageRequest,
  runSemanticsWorkflow,
  runPageWorkflow,
  runDetectedWorkflow,
  SEMANTICS_PATTERN,
  PAGE_PATTERN,
};
