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
const CATALOG_PATH = path.join(__dirname, '..', 'data', 'semantics-catalog.json');

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

/** Поиск группы по id или по названию (нечувствительно к регистру и пробелам). */
function findGroups(catalog, selector) {
  const all = catalog.sections.flatMap((section) =>
    section.groups.map((group) => ({ ...group, sectionTitle: section.title, sectionId: section.id }))
  );

  if (!selector || (Array.isArray(selector) && selector.length === 0)) return all;

  const wanted = (Array.isArray(selector) ? selector : [selector]).map((value) =>
    toStr(value).toLowerCase().replace(/\s+/g, ' ').trim()
  );

  return all.filter(
    (group) => wanted.includes(group.id) || wanted.includes(group.title.toLowerCase())
  );
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

module.exports = {
  loadCatalog,
  findGroups,
  buildDraft,
  getDraft,
  listDrafts,
  draftStatus,
  assertApproved,
  reviseDraft,
  COLLECTION,
};
