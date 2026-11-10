// lib/bot-steward.js
// Команды Telegram-бота для управления YouGile: проекты, доски, колонки, задачи.
//
// Зачем отдельный модуль: telegram-bot.js уже 1300 строк, а здесь чистая логика
// «запрос -> текст ответа», которую можно покрыть тестами без сети и бота.

'use strict';

const yougile = require('./yougile-client');
const admin = require('./yougile-admin');
const { escapeTelegram } = require('./text');

const MAX_ITEMS = 25;

function line(text) {
  return escapeTelegram(String(text || ''));
}

function shortId(id) {
  return String(id || '').slice(0, 8);
}

/** Поиск по названию или по id/префиксу id. */
function resolve(items, reference) {
  const ref = String(reference || '').trim().toLowerCase();
  if (!ref) return { item: null, candidates: [] };

  const byId = items.filter((item) => String(item.id || '').toLowerCase().startsWith(ref));
  if (byId.length === 1) return { item: byId[0], candidates: [] };

  const byTitle = items.filter((item) => String(item.title || '').trim().toLowerCase() === ref);
  if (byTitle.length === 1) return { item: byTitle[0], candidates: [] };

  const loose = items.filter((item) => String(item.title || '').toLowerCase().includes(ref));
  if (loose.length === 1) return { item: loose[0], candidates: [] };

  return { item: null, candidates: byTitle.length ? byTitle : loose };
}

function ambiguous(kind, candidates) {
  const list = candidates
    .slice(0, MAX_ITEMS)
    .map((item) => `• ${line(item.title)} — <code>${shortId(item.id)}</code>`)
    .join('\n');
  return `🤔 ${kind} несколько. Уточните названием или id:\n${list}`;
}

function notFound(kind, reference) {
  return `❌ ${kind} «${line(reference)}» не найден. Список: /${kind === 'Проект' ? 'project' : 'board'}`;
}

/** Все проекты. */
async function projects() {
  const items = await admin.listProjects();
  if (!items.length) return '📁 Проектов пока нет. Создать: /project new Название';

  const rows = items
    .slice(0, MAX_ITEMS)
    .map((item, index) => `${index + 1}. ${line(item.title)} — <code>${shortId(item.id)}</code>`);

  return `📁 <b>Проекты</b> (${items.length})\n${rows.join('\n')}\n\nДоски проекта: /project Название`;
}

/** Доски проекта или создание проекта. */
async function projectCommand(arg) {
  const value = String(arg || '').trim();
  if (!value) return projects();

  if (/^new\s+/i.test(value)) {
    const title = value.replace(/^new\s+/i, '').trim();
    if (!title) return 'Использование: /project new Название проекта';
    const result = await admin.ensureProject({ title });
    return result.created
      ? `✅ Проект создан: ${line(title)} — <code>${shortId(result.id)}</code>`
      : `ℹ️ Проект уже есть: ${line(title)} — <code>${shortId(result.id)}</code>`;
  }

  const items = await admin.listProjects();
  const { item, candidates } = resolve(items, value);
  if (!item) return candidates.length ? ambiguous('Проектов', candidates) : notFound('Проект', value);

  const boards = await admin.listBoards(item.id);
  if (!boards.length) return `📋 У проекта ${line(item.title)} пока нет досок.`;

  const rows = boards.map((board) => `• ${line(board.title)} — <code>${shortId(board.id)}</code>`);
  return `📋 <b>${line(item.title)}</b> — доски (${boards.length})\n${rows.join('\n')}\n\nКолонки: /board Название доски`;
}

/** Все доски компании или колонки конкретной доски. */
async function boardCommand(arg) {
  const value = String(arg || '').trim();

  if (!value) {
    const items = await admin.listProjects();
    const blocks = [];
    for (const project of items) {
      const boards = await admin.listBoards(project.id);
      if (!boards.length) continue;
      const rows = boards.map((board) => `  • ${line(board.title)} — <code>${shortId(board.id)}</code>`);
      blocks.push(`📁 ${line(project.title)}\n${rows.join('\n')}`);
    }
    return blocks.length ? `📋 <b>Доски</b>\n\n${blocks.join('\n\n')}` : '📋 Досок пока нет.';
  }

  if (/^new\s+/i.test(value)) {
    const [projectRef, title] = value.replace(/^new\s+/i, '').split('|').map((part) => part.trim());
    if (!projectRef || !title) return 'Использование: /board new Проект | Название доски';

    const project = resolve(await admin.listProjects(), projectRef);
    if (!project.item) {
      return project.candidates.length
        ? ambiguous('Проектов', project.candidates)
        : notFound('Проект', projectRef);
    }

    const result = await admin.ensureBoard({ projectId: project.item.id, title });
    return result.created
      ? `✅ Доска создана: ${line(title)} в проекте ${line(project.item.title)} — <code>${shortId(result.id)}</code>`
      : `ℹ️ Доска уже есть: ${line(title)} — <code>${shortId(result.id)}</code>`;
  }

  const board = await findBoard(value);
  if (board.error) return board.error;

  const columns = await admin.listColumns(board.item.id);
  if (!columns.length) return `📊 У доски ${line(board.item.title)} пока нет колонок.`;

  const rows = columns.map((column) => `• ${line(column.title)} — <code>${shortId(column.id)}</code>`);
  return `📊 <b>${line(board.item.title)}</b> — колонки (${columns.length})\n${rows.join('\n')}\n\nСоздать задачу: /task new Колонка | Заголовок`;
}

/** Колонки доски или создание колонки. */
async function columnCommand(arg) {
  const value = String(arg || '').trim();
  if (!value) return 'Использование: /column Название доски | /column new Доска | Название колонки';

  if (/^new\s+/i.test(value)) {
    const [boardRef, title] = value.replace(/^new\s+/i, '').split('|').map((part) => part.trim());
    if (!boardRef || !title) return 'Использование: /column new Доска | Название колонки';

    const board = await findBoard(boardRef);
    if (board.error) return board.error;

    const result = await admin.ensureColumn({ boardId: board.item.id, title });
    return result.created
      ? `✅ Колонка создана: ${line(title)} — <code>${shortId(result.id)}</code>`
      : `ℹ️ Колонка уже есть: ${line(title)} — <code>${shortId(result.id)}</code>`;
  }

  return boardCommand(value);
}

async function findBoard(reference) {
  const projects = await admin.listProjects();
  let all = [];
  for (const project of projects) {
    const boards = await admin.listBoards(project.id);
    all = all.concat(boards.map((board) => ({ ...board, projectTitle: project.title })));
  }

  const { item, candidates } = resolve(all, reference);
  if (item) return { item };
  if (candidates.length) return { error: ambiguous('Досок', candidates) };
  return { error: `❌ Доска «${line(reference)}» не найдена. Список: /board` };
}

/** Создание задачи в конкретной колонке: «Колонка | Заголовок». */
async function taskCommand(arg) {
  const value = String(arg || '').trim();
  const [columnRef, title] = value.split('|').map((part) => part.trim());

  if (!columnRef || !title) {
    return 'Использование: /task new Колонка | Заголовок задачи\n\nПример: /task new 5. Оркестрация | Проверить деплой';
  }

  const projects = await admin.listProjects();
  let columns = [];
  for (const project of projects) {
    const boards = await admin.listBoards(project.id);
    for (const board of boards) {
      const items = await admin.listColumns(board.id);
      columns = columns.concat(
        items.map((column) => ({ ...column, boardTitle: board.title, projectId: project.id }))
      );
    }
  }

  const { item, candidates } = resolve(columns, columnRef);
  if (!item) return candidates.length ? ambiguous('Колонок', candidates) : `❌ Колонка «${line(columnRef)}» не найдена.`;

  const created = await yougile.createTask({ title, columnId: item.id });
  const id = created.id || created;
  return `✅ Задача создана: ${line(title)}\nКолонка: ${line(item.title)} (${line(item.boardTitle)})\n<code>${shortId(id)}</code>`;
}

/** Применение плана steward: без аргумента — проверка, с apply — запись. */
async function stewardCommand(arg) {
  const mode = String(arg || '').trim().toLowerCase();
  const apply = mode === 'apply';

  const plan = admin.loadPlan('ai-agents-yg.json');
  const stats = await admin.applyPlan(plan, { dryRun: !apply });

  const head = apply ? '⚙️ <b>План применён</b>' : '🔍 <b>Проверка плана</b> (ничего не записано)';
  const rows = [
    `Проект: ${line(stats.project.title)}`,
    `Досок: создано ${stats.boards.created}, было ${stats.boards.existing}`,
    `Колонок: создано ${stats.columns.created}, было ${stats.columns.existing}`,
    `Задач: создано ${stats.tasks.created}, обновлено ${stats.tasks.updated}, без изменений ${stats.tasks.skipped}`,
  ];

  if (stats.errors.length) {
    rows.push(`⚠️ Ошибок: ${stats.errors.length}`);
    rows.push(...stats.errors.slice(0, 5).map((text) => `• ${line(text)}`));
  }
  if (!apply) rows.push('\nЗаписать изменения: /steward apply');

  return `${head}\n\n${rows.join('\n')}`;
}

module.exports = {
  projects,
  projectCommand,
  boardCommand,
  columnCommand,
  taskCommand,
  stewardCommand,
  resolve,
};
