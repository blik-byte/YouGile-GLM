// lib/semantics.js
// Черновики семантического ядра с обязательным согласованием владельцем.
//
// ПРОЦЕСС, СОГЛАСОВАННЫЙ С ВЛАДЕЛЬЦЕМ:
//   1. Агент собирает черновик: запросы владельца (с ЕГО частотностями) плюс
//      до-расширение подсказками поисковиков (без частотностей, с пометкой).
//   2. Черновик уходит владельцу на согласование (заявка + документ).
//   3. СТРАНИЦЫ СОЗДАЮТСЯ ТОЛЬКО ПО ОДОБРЕННОМУ черновику: assertApproved()
//      будет вызываться инструментом создания страниц и отклонять работу
//      по неодобренной семантике.
//
// ЧАСТОТНОСТИ: цифры владельца (freqSource='owner') неприкосновенны — агент
// не пересчитывает и не заменяет их. Всё, что добыто подсказками, идёт с
// freq=null и freqSource='suggest': это кандидаты, а не измерения.
// Владелец снимает частотности своим расширением и проставляет сам.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const db = require('../db');
const approvals = require('./approvals');
const keywords = require('./keywords');
const { toStr } = require('./text');

const COLLECTION = 'semantics_drafts';
// ВАЖНО: каталог лежит в catalog/, а не в data/, потому что в .gitignore проекта
// исторически есть строка data/ (локальные данные MongoDB) — из-за неё файл
// каталога не попадал в репозиторий и отсутствовал на Render.
const CATALOG_PATH = path.join(__dirname, '..', 'catalog', 'semantics-catalog.json');

function loadCatalog() {
  try {
    return JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  } catch (error) {
    throw new Error(`Не удалось прочитать каталог семантики ${CATALOG_PATH}: ${error.message}`);
  }
}

function shortId() {
  return crypto.randomBytes(4).toString('hex');
}

function normalizeQuery(query) {
  return keywords.normalize(query);
}

/**
 * Группы, которые владелец решил не развивать (см. catalog.excluded).
 * Возвращает причину вместе с id, чтобы отказ был объяснимым.
 */
function excludedGroups(catalog) {
  return new Map((catalog.excluded || []).map((entry) => [entry.id, entry.reason || 'исключено решением владельца']));
}

/** Поиск группы по id или по названию (нечувствительно к регистру и пробелам). */
function findGroups(catalog, selector) {
  const excluded = excludedGroups(catalog);

  const all = catalog.sections.flatMap((section) =>
    section.groups.map((group) => ({ ...group, sectionTitle: section.title, sectionId: section.id }))
  );

  if (!selector || (Array.isArray(selector) && selector.length === 0)) {
    // Без явного выбора исключённые группы в работу не попадают
    return all.filter((group) => !excluded.has(group.id));
  }

  const wanted = (Array.isArray(selector) ? selector : [selector]).map((value) =>
    toStr(value).toLowerCase().replace(/\s+/g, ' ').trim()
  );

  return all.filter(
    (group) =>
      (wanted.includes(group.id) || wanted.includes(group.title.toLowerCase())) &&
      !excluded.has(group.id)
  );
}

/**
 * Явно запрошена ли исключённая группа — чтобы объяснить отказ,
 * а не молча вернуть пустой результат.
 */
function findExcludedMatch(catalog, selector) {
  if (!selector) return null;
  const wanted = (Array.isArray(selector) ? selector : [selector]).map((value) =>
    toStr(value).toLowerCase().replace(/\s+/g, ' ').trim()
  );
  const entry = (catalog.excluded || []).find(
    (item) => wanted.includes(item.id) || wanted.includes(toStr(item.title).toLowerCase())
  );
  return entry || null;
}

/**
 * Опорные запросы для до-расширения группы.
 * - Если у группы есть запросы владельца — расширяем вокруг самых частотных.
 * - Если только подкатегории — строим семена из них.
 */
function buildSeeds(group) {
  const ownerQueries = (group.queries || [])
    .filter((query) => query.freq > 0)
    .sort((a, b) => b.freq - a.freq);

  if (ownerQueries.length > 0) {
    return ownerQueries.slice(0, 4).map((query) => query.q);
  }

  const subs = group.subcategories || [];
  if (subs.length > 0) {
    return subs.slice(0, 6).map((sub) => `продвижение сайта ${sub.split(',')[0].trim()}`);
  }

  return [`продвижение ${group.title.toLowerCase()}`];
}

/**
 * Сборка черновика семантики по группам каталога.
 *
 * @param {object} [options]
 * @param {string[]|string} [options.groups] - id или названия групп; по умолчанию все
 * @param {boolean} [options.expand=true] - до-расширять подсказками поисковиков
 * @param {number} [options.maxQueriesPerSeed=25] - бюджет подсказок на одно семя
 * @param {string} [options.taskId]
 * @param {string} [options.comment] - пояснение владельцу, уйдёт в заявку
 * @returns {Promise<object>} черновик с approvalId
 */
async function buildDraft(options = {}) {
  const catalog = loadCatalog();
  const excludedMatch = findExcludedMatch(catalog, options.groups);

  if (excludedMatch) {
    return {
      success: false,
      error:
        `Группа «${excludedMatch.title}» исключена из каталога решением владельца: ${excludedMatch.reason}. ` +
        'Если решение изменилось — группу нужно явно вернуть в data/semantics-catalog.json.',
    };
  }

  const groups = findGroups(catalog, options.groups);

  if (groups.length === 0) {
    const available = catalog.sections
      .flatMap((section) => section.groups.map((group) => `${group.id} (${group.title})`))
      .join(', ');
    return { success: false, error: `Группы не найдены. Доступно: ${available}` };
  }

  const expand = options.expand !== false;
  const draftGroups = [];

  for (const group of groups) {
    const queries = new Map();

    // 1. Запросы владельца — неприкосновенны, с его частотностями
    for (const query of group.queries || []) {
      const key = normalizeQuery(query.q);
      if (!key) continue;
      queries.set(key, {
        q: key,
        freq: Number(query.freq) || 0,
        w: query.w ?? null,
        freqSource: 'owner',
        intent: keywords.intentOf(key),
        origin: 'каталог владельца',
      });
    }

    // 2. До-расширение подсказками: кандидаты БЕЗ частотностей
    if (expand) {
      for (const seed of buildSeeds(group)) {
        try {
          const research = await keywords.research(seed, {
            maxQueries: Math.min(Number(options.maxQueriesPerSeed) || 25, 60),
            alphabet: true,
          });

          if (!research.success) continue;

          for (const item of research.top || []) {
            const key = normalizeQuery(item.keyword);
            if (!key || queries.has(key)) continue;

            queries.set(key, {
              q: key,
              freq: null,
              w: null,
              freqSource: 'suggest',
              demand: item.demand,
              intent: keywords.intentOf(key),
              origin: `подсказки по «${seed}»`,
            });
          }
        } catch (error) {
          console.warn(`⚠️ Расширение группы ${group.id} по «${seed}» не удалось: ${error.message}`);
        }
      }
    }

    const list = [...queries.values()].sort((a, b) => {
      // Сначала запросы владельца по убыванию частоты, затем кандидаты
      if (a.freqSource !== b.freqSource) return a.freqSource === 'owner' ? -1 : 1;
      return (b.freq || 0) - (a.freq || 0);
    });

    draftGroups.push({
      id: group.id,
      title: group.title,
      section: group.sectionTitle,
      seeds: buildSeeds(group),
      ownerQueries: list.filter((query) => query.freqSource === 'owner').length,
      suggestedQueries: list.filter((query) => query.freqSource === 'suggest').length,
      queries: list,
    });
  }

  const draft = {
    id: shortId(),
    title: `Семантика: ${draftGroups.map((group) => group.title).join(', ').slice(0, 120)}`,
    status: 'pending',
    groups: draftGroups,
    totals: {
      ownerQueries: draftGroups.reduce((sum, group) => sum + group.ownerQueries, 0),
      suggestedQueries: draftGroups.reduce((sum, group) => sum + group.suggestedQueries, 0),
    },
    createdAt: new Date(),
    taskId: options.taskId ? String(options.taskId) : null,
  };

  const connection = await db.getDb();
  await connection.collection(COLLECTION).insertOne(draft);

  // Заявка на согласование: владелец видит сводку и одобряет или отклоняет
  const request = await approvals.createRequest({
    kind: 'semantics_draft',
    target: draft.id,
    reason:
      toStr(options.comment, '') ||
      `Черновик семантики: ${draft.totals.ownerQueries} запросов владельца с частотностями + ` +
        `${draft.totals.suggestedQueries} кандидатов из подсказок (без частотностей). ` +
        'Частотности кандидатам проставляет владелец. Страницы по черновику не создаются до одобрения.',
    taskId: draft.taskId,
  });

  await connection.collection(COLLECTION).updateOne({ id: draft.id }, { $set: { approvalId: request.id } });
  draft.approvalId = request.id;

  console.log(`📋 Черновик семантики ${draft.id}: групп ${draftGroups.length}, заявок ${request.id}`);
  return { success: true, ...draft };
}

async function getDraft(id) {
  const connection = await db.getDb();
  return connection.collection(COLLECTION).findOne({ id: String(id) });
}

/**
 * Разбор подписи к файлу частотностей.
 * Владелец естественно копирует тот id, который видел последним: либо id задачи
 * YouGile (uuid с дефисами), либо id черновика (8 hex). Поддерживаем оба.
 *
 * @returns {{draftId: string|null, taskUuid: string|null}}
 */
function parseCaptionReference(caption) {
  const text = toStr(caption);
  const taskUuid = (text.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i) || [])[1] || null;
  const draftId = taskUuid ? null : (text.match(/\b([a-f0-9]{8})\b/i) || [])[1] || null;
  return { draftId: draftId ? draftId.toLowerCase() : null, taskUuid: taskUuid ? taskUuid.toLowerCase() : null };
}

/** Поиск черновика по id задачи YouGile, которой он был создан. */
async function findDraftByTaskId(taskId) {
  const connection = await db.getDb();
  return connection
    .collection(COLLECTION)
    .find({ taskId: String(taskId) })
    .sort({ createdAt: -1 })
    .limit(1)
    .toArray()
    .then((rows) => rows[0] || null);
}

async function listDrafts(limit = 20) {
  const connection = await db.getDb();
  return connection
    .collection(COLLECTION)
    .find({})
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
}

/**
 * Фактический статус черновика:Own поле status + решение по заявке.
 * Одобренная заявка переводит черновик в approved автоматически.
 */
async function draftStatus(draft) {
  if (!draft) return null;
  if (draft.status === 'denied') return 'denied';

  if (draft.approvalId) {
    const request = await approvals.get(draft.approvalId);
    if (request?.status === 'approved') return 'approved';
    if (request?.status === 'denied') return 'denied';
  }

  return draft.status || 'pending';
}

/**
 * ГЕЙТ: страницы и правки контента разрешены только по одобренному черновику.
 * @returns {Promise<{ok:boolean, status?:string, error?:string, draft?:object}>}
 */
async function assertApproved(draftId) {
  const draft = await getDraft(draftId);
  if (!draft) {
    return { ok: false, error: `Черновик семантики ${draftId} не найден` };
  }

  const status = await draftStatus(draft);
  if (status !== 'approved') {
    return {
      ok: false,
      status,
      draft,
      error:
        `Семантика черновика ${draftId} не одобрена владельцем (статус: ${status}). ` +
        'Создание страниц по неодобренной семантике запрещено процессом. ' +
        'Дождись /approve от владельца или подготовь новый черновик с учётом его правок.',
    };
  }

  return { ok: true, status, draft };
}

/**
 * Правки черновика владельцем через агента: убрать или добавить запросы.
 * Доступно только пока черновик не одобрен.
 */
async function reviseDraft(draftId, { remove = [], add = [] }) {
  const draft = await getDraft(draftId);
  if (!draft) return { success: false, error: `Черновик ${draftId} не найден` };

  const status = await draftStatus(draft);
  if (status === 'approved') {
    return {
      success: false,
      error: 'Черновик уже одобрен: правки возможны только новым черновиком (процесс согласования).',
    };
  }

  const removeSet = new Set(remove.map(normalizeQuery));

  for (const group of draft.groups) {
    group.queries = group.queries.filter((query) => !removeSet.has(query.q));

    for (const item of add) {
      const key = normalizeQuery(item.q || item);
      if (!key || group.queries.some((query) => query.q === key)) continue;
      if (item.group && item.group !== group.id) continue;

      group.queries.push({
        q: key,
        freq: item.freq ?? null,
        w: item.w ?? null,
        freqSource: item.freq ? 'owner' : 'suggest',
        intent: keywords.intentOf(key),
        origin: 'добавлено при правке черновика',
      });
    }

    group.ownerQueries = group.queries.filter((query) => query.freqSource === 'owner').length;
    group.suggestedQueries = group.queries.filter((query) => query.freqSource === 'suggest').length;
  }

  const connection = await db.getDb();
  await connection.collection(COLLECTION).updateOne({ id: draftId }, { $set: { groups: draft.groups, revisedAt: new Date() } });

  return { success: true, id: draftId, groups: draft.groups.length };
}

/**
 * Импорт частотностей владельца из xlsx в черновик.
 *
 Формат файла — как у владельца: строки «Группа: <название>» начинают группу,
 * далее строки «запрос | частотность | W». Частотности владельца authoritative:
 * они перезаписывают кандидатские null и помечают запрос как owner.
 * Запросы из файла, которых нет в черновике, добавляются в подходящую группу.
 *
 * Доступно только пока черновик не одобрен.
 *
 * @param {string} draftId
 * @param {Buffer} buffer
 * @returns {Promise<object>}
 */
async function mergeOwnerFrequencies(draftId, buffer) {
  const draft = await getDraft(draftId);
  if (!draft) return { success: false, error: `Черновик ${draftId} не найден` };

  const status = await draftStatus(draft);
  if (status === 'approved') {
    return { success: false, error: 'Черновик одобрен: частотности правятся только новым черновиком' };
  }

  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const parsedGroups = [];
  let current = null;

  workbook.worksheets.forEach((worksheet) => {
    worksheet.eachRow((row) => {
      const values = row.values
        .slice(1)
        .map((value) => (value === null || value === undefined ? '' : String(value).replace(/\s+/g, ' ').trim()));
      if (!values.some((value) => value)) return;

      const groupMatch = values[0].match(/^Группа:\s*(.+)$/i);
      if (groupMatch) {
        current = { title: groupMatch[1].trim(), queries: [] };
        parsedGroups.push(current);
        return;
      }

      if (!current || !values[0]) return;
      const freq = Number(String(values[1]).replace(/\s/g, '')) || 0;
      const w = values[2] === '' ? null : Number(values[2]);
      current.queries.push({ q: normalizeQuery(values[0]), freq, w: Number.isFinite(w) ? w : null });
    });
  });

  if (parsedGroups.length === 0) {
    return { success: false, error: 'В файле не найдено ни одной группы вида «Группа: <название>»' };
  }

  let updated = 0;
  let added = 0;
  const unmatched = [];

  for (const parsed of parsedGroups) {
    const target =
      draft.groups.find((group) => group.title.toLowerCase() === parsed.title.toLowerCase()) ||
      draft.groups.find((group) => group.title.toLowerCase().includes(parsed.title.toLowerCase().split(' ')[0])) ||
      draft.groups[0];

    for (const item of parsed.queries) {
      if (!item.q) continue;

      const existing = target.queries.find((query) => query.q === item.q);
      if (existing) {
        existing.freq = item.freq;
        existing.w = item.w;
        existing.freqSource = 'owner';
        existing.origin = 'частотности владельца из файла';
        updated++;
      } else {
        target.queries.push({
          q: item.q,
          freq: item.freq,
          w: item.w,
          freqSource: 'owner',
          intent: keywords.intentOf(item.q),
          origin: 'добавлен из файла частотностей владельца',
        });
        added++;
      }
    }

    if (!parsed.queries.length) unmatched.push(parsed.title);
  }

  for (const group of draft.groups) {
    group.ownerQueries = group.queries.filter((query) => query.freqSource === 'owner').length;
    group.suggestedQueries = group.queries.filter((query) => query.freqSource === 'suggest').length;
    group.queries.sort((a, b) => {
      if (a.freqSource !== b.freqSource) return a.freqSource === 'owner' ? -1 : 1;
      return (b.freq || 0) - (a.freq || 0);
    });
  }

  const connection = await db.getDb();
  await connection
    .collection(COLLECTION)
    .updateOne({ id: draftId }, { $set: { groups: draft.groups, frequenciesImportedAt: new Date() } });

  return { success: true, updated, added, groups: parsedGroups.length, unmatchedGroups: unmatched };
}

module.exports = {
  loadCatalog,
  findGroups,
  findExcludedMatch,
  excludedGroups,
  buildDraft,
  getDraft,
  findDraftByTaskId,
  parseCaptionReference,
  listDrafts,
  draftStatus,
  assertApproved,
  reviseDraft,
  mergeOwnerFrequencies,
  COLLECTION,
};
