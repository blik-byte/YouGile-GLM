// lib/yougile-admin.js
// Администрирование YouGile: проекты, доски, колонки, задачи.
//
// Зачем отдельный модуль: lib/yougile-client.js умеет работать только с задачами
// одной доски, а scripts/seed-board.js писал собственный HTTP-клиент с ретраями
// и rate-limit. Здесь — один набор операций поверх yougile-client.request():
// поиск по названию, создание при отсутствии, обновление при изменении.
//
// Идемпотентность держится на маркере в описании задачи:
//   <!--plan:TD-01-->  — HTML-комментарий, в карточке не виден
// Старый формат [plan:TD-01] тоже распознаётся и заменяется при обновлении.

'use strict';

const fs = require('fs');
const path = require('path');

const yougile = require('./yougile-client');

const CHECKLIST_TITLE = 'Чек-лист выполнения';
const PAGE_LIMIT = 100;
const MAX_PAGES = 20;

// Пауза между записями: YouGile держит лимит 50 запросов в минуту.
const DEFAULT_WRITE_DELAY = Number(process.env.STEWARD_WRITE_DELAY_MS || 1300);

const LEGACY_MARKER = /^\s*\[plan:([A-Za-z0-9_-]+)\]\s*/;
const HTML_MARKER = /<!--\s*plan:([A-Za-z0-9_-]+)\s*-->/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Поиск сущности по названию.
 * YouGile сам добавляет суффикс к дублям: «Доска», «Доска (2)», «Доска (3)».
 * Точное совпадение важнее, иначе берём самый старый вариант с суффиксом.
 */
function pickByTitle(items, title) {
  const list = (items || []).filter(Boolean);
  const exact = list.find((item) => item.title === title);
  if (exact) return exact;

  const pattern = new RegExp(`^${escapeRegExp(title)}\\s\\(\\d+\\)$`);
  const similar = list.filter((item) => pattern.test(String(item.title || '')));
  if (similar.length === 0) return null;

  similar.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  return similar[0];
}

/** Код задачи из описания: сначала новый формат, затем старый. */
function extractCode(description = '') {
  const text = String(description || '');
  const html = text.match(HTML_MARKER);
  if (html) return html[1];
  const legacy = text.match(LEGACY_MARKER);
  return legacy ? legacy[1] : null;
}

/** Убирает оба вида маркеров из текста. */
function stripMarkers(description = '') {
  return String(description || '')
    .replace(/<!--\s*plan:[A-Za-z0-9_-]+\s*-->\s*/g, '')
    .replace(/^\s*\[plan:[A-Za-z0-9_-]+\]\s*/gm, '')
    .trim();
}

/** Ставит маркер в начало описания в виде HTML-комментария. */
function withMarker(description, code) {
  const body = stripMarkers(description);
  if (!code) return body;
  return `<!--plan:${code}-->\n${body}`;
}

/**
 * Сравнение текстов описания для решения «обновлять или нет».
 * YouGile при сохранении обрезает края и может менять переводы строк,
 * а HTML-комментарии (маркеры) из описания вырезает целиком —
 * поэтому сравниваем уже очищенный текст.
 */
function normalizeDescription(value) {
  return decodeEntities(
    stripMarkers(String(value || ''))
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .trim()
  )
    // Вставки вида <id> YouGile вырезает как HTML-тег, вернуть их через API нельзя.
    // Считаем такие места незначащими, иначе каждый прогон переписывает ту же задачу.
    .replace(/<[^>]{0,40}>/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** HTML-сущности обратно в символы — для сравнения «что было / что нужно». */
function decodeEntities(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/**
 * Текст плана в безопасный для YouGile вид.
 * Поле описания рендерится как HTML: `<id>` без экранирования принимается за тег
 * и вырезается вместе с содержимым (так пострадали три задачи в Roadmap).
 */
function escapeText(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Постранично забирает все сущности списка. */
async function listAll(apiPath, query = {}) {
  const items = [];
  let offset = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    let data;
    try {
      ({ data } = await yougile.request('GET', apiPath, {
        query: { ...query, limit: PAGE_LIMIT, offset: offset || undefined },
      }));
    } catch (error) {
      // Старые инсталляции не принимают offset — повторяем один раз без него.
      if (page === 0 && /offset|should not exist|Bad Request/i.test(error.message)) {
        ({ data } = await yougile.request('GET', apiPath, { query: { ...query, limit: PAGE_LIMIT } }));
      } else {
        throw error;
      }
    }

    const chunk = yougile.extractList(data);
    items.push(...chunk);

    const paging = data && data.paging;
    if (!paging || paging.next === false || chunk.length === 0) break;
    offset += chunk.length;
  }

  return items;
}

async function listProjects() {
  return (await listAll('/projects')).filter((item) => !item.deleted);
}

async function listBoards(projectId) {
  return (await listAll('/boards', { projectId })).filter((item) => !item.deleted);
}

async function listColumns(boardId) {
  return (await listAll('/columns', { boardId })).filter((item) => !item.deleted);
}

async function listTasks(columnId) {
  return (await listAll('/tasks', { columnId })).filter((item) => !item.deleted);
}

async function listUsers() {
  return (await listAll('/users')).filter((item) => !item.deleted);
}

let cachedMe = null;

/** Кто мы для API: нужен, чтобы созданный проект был доступен создателю. */
async function getMe() {
  if (cachedMe) return cachedMe;
  const { data } = await yougile.request('GET', '/users/me');
  cachedMe = data;
  return cachedMe;
}

/** Проект по точному названию. */
async function ensureProject({ title, description = '' }, ctx = {}) {
  const projects = await listProjects();
  const found = pickByTitle(projects, title);
  if (found) return { id: found.id, created: false };

  if (ctx.dryRun) return { id: null, created: true, planned: true };
  // API v2 не принимает description у проекта: 400 "property description should not exist".
  // users обязателен: без него проект создаётся без участников и потом не виден даже создателю.
  const me = await getMe();
  const { data } = await yougile.request('POST', '/projects', {
    body: { title, users: me && me.id ? { [me.id]: 'admin' } : undefined },
  });
  await ctx.pause();
  return { id: data.id || data, created: true };
}

/** Доска внутри проекта. */
async function ensureBoard({ projectId, title }, ctx = {}) {
  const boards = await listBoards(projectId);
  const found = pickByTitle(boards, title);
  if (found) return { id: found.id, created: false };

  if (ctx.dryRun) return { id: null, created: true, planned: true };
  const { data } = await yougile.request('POST', '/boards', { body: { projectId, title } });
  await ctx.pause();
  return { id: data.id || data, created: true };
}

/** Колонка внутри доски. */
async function ensureColumn({ boardId, title }, ctx = {}) {
  const columns = await listColumns(boardId);
  const found = pickByTitle(columns, title);
  if (found) return { id: found.id, created: false };

  if (ctx.dryRun) return { id: null, created: true, planned: true };
  const { data } = await yougile.request('POST', '/columns', { body: { boardId, title } });
  await ctx.pause();
  return { id: data.id || data, created: true };
}

/** Исполнители плана: почта или ФИО -> массив UUID. */
async function resolveAssignees(values = []) {
  if (!values.length) return [];
  const users = await listUsers();
  const ids = [];

  for (const value of values) {
    const needle = String(value).trim().toLowerCase();
    const user = users.find(
      (item) =>
        String(item.email || '').toLowerCase() === needle ||
        String(item.realName || '').toLowerCase() === needle
    );
    if (user) ids.push(user.id);
    else console.warn(`⚠️ steward: исполнитель «${value}» не найден в YouGile`);
  }

  return ids;
}

/**
 * Чек-лист из плана: массив строк или объектов.
 * Отметки о выполнении сохраняются, если пункт с таким же текстом уже был.
 */
function buildChecklists(items, existing = []) {
  if (!Array.isArray(items) || items.length === 0) return undefined;

  const doneTitles = new Set();
  for (const list of existing || []) {
    for (const item of list.items || []) {
      if (item.isCompleted) doneTitles.add(String(item.title || '').trim());
    }
  }

  return [
    {
      title: CHECKLIST_TITLE,
      items: items.map((raw) => {
        const title = String(typeof raw === 'string' ? raw : raw.title || '').trim();
        return { title, isCompleted: doneTitles.has(title) };
      }),
    },
  ];
}

function sameChecklists(next, current) {
  if (!next) return true;
  const currentItems = (current && current[0] && current[0].items) || [];
  if (currentItems.length !== next[0].items.length) return false;
  return next[0].items.every(
    (item, index) =>
      String(currentItems[index].title || '').trim() === item.title &&
      Boolean(currentItems[index].isCompleted) === Boolean(item.isCompleted)
  );
}

function sameIds(a = [], b = []) {
  const left = [...a].map(String).sort();
  const right = [...b].map(String).sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Создаёт задачу или приводит существующую к виду из плана.
 * Существующая ищется по маркеру code, затем по точному заголовку.
 */
async function upsertTask(spec, ctx = {}) {
  const tasks = spec.columnId ? await listTasks(spec.columnId) : [];
  const byCode = spec.code ? tasks.find((item) => extractCode(item.description) === spec.code) : null;
  // HTML-комментарии YouGile вырезает, поэтому основной ключ — заголовок.
  const existing = byCode || pickByTitle(tasks, spec.title) || null;

  const description = spec.plainText
    ? escapeText(stripMarkers(spec.description))
    : stripMarkers(spec.description);
  const checklists = buildChecklists(spec.checklist, existing && existing.checklists);
  const assigned = spec.assigned || [];

  if (!existing) {
    if (ctx.dryRun) return { created: true, planned: true };
    const body = { columnId: spec.columnId, title: spec.title, description };
    if (checklists) body.checklists = checklists;
    if (assigned.length) body.assigned = assigned;
    await yougile.request('POST', '/tasks', { body });
    await ctx.pause();
    return { created: true };
  }

  const patch = {};
  if (existing.title !== spec.title) patch.title = spec.title;

  // Маркеры в карточке видны как текст ([plan:CODE]) — если они есть, чистим принудительно,
  // даже когда сам текст не менялся.
  const hasMarkers = /<!--\s*plan:[A-Za-z0-9_-]+\s*-->|\[\s*plan:[A-Za-z0-9_-]+\s*\]/.test(
    String(existing.description || '')
  );
  if (hasMarkers || normalizeDescription(existing.description) !== normalizeDescription(spec.description)) {
    patch.description = stripMarkers(spec.description);
  }
  if (checklists && !sameChecklists(checklists, existing.checklists)) patch.checklists = checklists;
  if (assigned.length && !sameIds(assigned, existing.assigned || [])) patch.assigned = assigned;

  if (Object.keys(patch).length === 0) return { skipped: true };
  if (ctx.dryRun) return { updated: true, planned: true, fields: Object.keys(patch) };

  await yougile.request('PUT', `/tasks/${existing.id}`, { body: patch });
  await ctx.pause();
  return { updated: true, fields: Object.keys(patch) };
}

/** Загружает план из папки plans: только имя файла, без выхода за пределы каталога. */
function loadPlan(planPath) {
  const plansDir = path.join(__dirname, '..', 'plans');
  const file = path.isAbsolute(planPath)
    ? planPath
    : path.join(plansDir, path.basename(String(planPath || 'ai-agents-yg.json')));

  if (!fs.existsSync(file)) throw new Error(`План не найден: ${file}`);

  const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!plan.project || !Array.isArray(plan.boards)) {
    throw new Error('Неверная структура плана: нужны project и boards[]');
  }
  return plan;
}

/**
 * Применяет план целиком: проект, доски, колонки, задачи.
 * @returns {Promise<object>} статистика применения
 */
async function applyPlan(plan, options = {}) {
  const ctx = {
    dryRun: Boolean(options.dryRun),
    pause: () => sleep(options.writeDelayMs ?? DEFAULT_WRITE_DELAY),
  };

  const stats = {
    dryRun: ctx.dryRun,
    project: null,
    boards: { created: 0, existing: 0 },
    columns: { created: 0, existing: 0 },
    tasks: { created: 0, updated: 0, skipped: 0 },
    errors: [],
  };

  const project = await ensureProject(
    { title: plan.project.title, description: plan.project.description || '' },
    ctx
  );
  stats.project = { title: plan.project.title, id: project.id, created: project.created };

  for (const boardSpec of plan.boards) {
    const board = await ensureBoard({ projectId: project.id, title: boardSpec.title }, ctx);
    if (board.created) stats.boards.created += 1;
    else stats.boards.existing += 1;

    const columnIds = {};
    for (const columnSpec of boardSpec.columns || []) {
      const column = await ensureColumn({ boardId: board.id, title: columnSpec.title }, ctx);
      if (column.created) stats.columns.created += 1;
      else stats.columns.existing += 1;
      columnIds[columnSpec.title] = column.id;
    }

    for (const taskSpec of boardSpec.tasks || []) {
      if (!columnIds[taskSpec.column] && !ctx.dryRun) {
        stats.errors.push(`${taskSpec.code || taskSpec.title}: нет колонки «${taskSpec.column}»`);
        continue;
      }

      try {
        const assigned = await resolveAssignees(taskSpec.assignees || []);
        const result = await upsertTask(
          {
            columnId: columnIds[taskSpec.column] || null,
            code: taskSpec.code,
            title: taskSpec.title,
            description: taskSpec.description || '',
            plainText: true,
            checklist: taskSpec.checklist || [],
            assigned,
          },
          ctx
        );

        if (result.created) stats.tasks.created += 1;
        else if (result.updated) stats.tasks.updated += 1;
        else stats.tasks.skipped += 1;
      } catch (error) {
        stats.errors.push(`${taskSpec.code || taskSpec.title}: ${error.message}`);
      }
    }
  }

  return stats;
}

module.exports = {
  extractCode,
  stripMarkers,
  withMarker,
  normalizeDescription,
  escapeText,
  decodeEntities,
  listProjects,
  listBoards,
  listColumns,
  listTasks,
  listUsers,
  getMe,
  pickByTitle,
  ensureProject,
  ensureBoard,
  ensureColumn,
  upsertTask,
  buildChecklists,
  resolveAssignees,
  loadPlan,
  applyPlan,
  CHECKLIST_TITLE,
};
