#!/usr/bin/env node
/**
 * scripts/test-bot-steward.js
 * Тесты команд бота (lib/bot-steward.js) на подменённых данных YouGile.
 */

'use strict';

const assert = require('assert');
const admin = require('../lib/yougile-admin');
const yougile = require('../lib/yougile-client');
const bot = require('../lib/bot-steward');

const original = {
  listProjects: admin.listProjects,
  listBoards: admin.listBoards,
  listColumns: admin.listColumns,
  ensureProject: admin.ensureProject,
  ensureBoard: admin.ensureBoard,
  ensureColumn: admin.ensureColumn,
  loadPlan: admin.loadPlan,
  applyPlan: admin.applyPlan,
  createTask: yougile.createTask,
};

const data = {
  projects: [
    { id: 'p1aaaaaa', title: 'AI агенты и YG' },
    { id: 'p2bbbbbb', title: 'premium-flowers.ru' },
  ],
  boards: {
    p1aaaaaa: [{ id: 'b1cccccc', title: 'Roadmap' }],
    p2bbbbbb: [],
  },
  columns: {
    b1cccccc: [
      { id: 'c1dddddd', title: '0. Техдолг' },
      { id: 'c2eeeeee', title: '5. Оркестрация' },
    ],
  },
};

let created;

function stubAll() {
  created = { project: 0, board: 0, column: 0, task: 0 };

  admin.listProjects = async () => data.projects;
  admin.listBoards = async (projectId) => data.boards[projectId] || [];
  admin.listColumns = async (boardId) => data.columns[boardId] || [];
  admin.ensureProject = async ({ title }) => ({ id: `p-new-${title}`, created: true });
  admin.ensureBoard = async ({ title }) => ({ id: `b-new-${title}`, created: true });
  admin.ensureColumn = async ({ title }) => ({ id: `c-new-${title}`, created: true });
  admin.loadPlan = () => ({ project: { title: 'AI агенты и YG' }, boards: [] });
  admin.applyPlan = async (plan, options) => ({
    dryRun: Boolean(options && options.dryRun),
    project: { title: 'AI агенты и YG', created: false },
    boards: { created: 0, existing: 1 },
    columns: { created: 0, existing: 7 },
    tasks: { created: 0, updated: 0, skipped: 58 },
    errors: [],
  });
  yougile.createTask = async ({ title }) => {
    created.task += 1;
    return { id: `t-${created.task}`, title };
  };
}

function restore() {
  for (const [key, value] of Object.entries(original)) {
    if (key === 'createTask') yougile.createTask = value;
    else admin[key] = value;
  }
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('поиск по названию, id и неоднозначность', () => {
  const items = [
    { id: 'abcdef12', title: 'Roadmap' },
    { id: 'abcdef34', title: 'Roadmap старая' },
    { id: 'aaaaaaaa', title: 'Поток' },
  ];

  assert.strictEqual(bot.resolve(items, 'Поток').item.id, 'aaaaaaaa');
  assert.strictEqual(bot.resolve(items, 'поток').item.id, 'aaaaaaaa');
  assert.strictEqual(bot.resolve(items, 'abcdef12').item.title, 'Roadmap');
  assert.strictEqual(bot.resolve(items, 'нет такого').item, null);
});

test('/project без аргумента показывает список', async () => {
  stubAll();
  const text = await bot.projects();
  assert.ok(text.includes('Проекты'));
  assert.ok(text.includes('AI агенты и YG'));
  assert.ok(text.includes('premium-flowers.ru'));
});

test('/project Название показывает доски', async () => {
  stubAll();
  const text = await bot.projectCommand('AI агенты и YG');
  assert.ok(text.includes('Roadmap'));
  assert.ok(text.includes('доски'));
});

test('/project new создаёт проект', async () => {
  stubAll();
  const text = await bot.projectCommand('new Новый проект');
  assert.ok(text.includes('Проект создан'));
  assert.ok(text.includes('Новый проект'));
});

test('/board Название показывает колонки', async () => {
  stubAll();
  const text = await bot.boardCommand('Roadmap');
  assert.ok(text.includes('0. Техдолг'));
  assert.ok(text.includes('5. Оркестрация'));
});

test('/board new требует разделитель и создаёт доску', async () => {
  stubAll();
  const bad = await bot.boardCommand('new Только проект');
  assert.ok(bad.includes('Использование'));

  const good = await bot.boardCommand('new AI агенты и YG | Новая доска');
  assert.ok(good.includes('Доска создана'));
});

test('/column Название дублирует показ колонок', async () => {
  stubAll();
  const text = await bot.columnCommand('Roadmap');
  assert.ok(text.includes('колонки'));
});

test('/column new создаёт колонку', async () => {
  stubAll();
  const text = await bot.columnCommand('new Roadmap | Новая колонка');
  assert.ok(text.includes('Колонка создана'));
});

test('/task new Колонка | Заголовок создаёт задачу', async () => {
  stubAll();
  const text = await bot.taskCommand('5. Оркестрация | Проверить деплой');
  assert.ok(text.includes('Задача создана'));
  assert.ok(text.includes('5. Оркестрация'));
  assert.strictEqual(created.task, 1);
});

test('/task new без разделителя просит формат', async () => {
  stubAll();
  const text = await bot.taskCommand('5. Оркестрация без заголовка');
  assert.ok(text.includes('Использование'));
  assert.strictEqual(created.task, 0);
});

test('/steward без аргумента — только проверка', async () => {
  stubAll();
  const text = await bot.stewardCommand('');
  assert.ok(text.includes('Проверка плана'));
  assert.ok(text.includes('ничего не записано'));
  assert.ok(text.includes('58'));
});

test('/steward apply применяет план', async () => {
  stubAll();
  const text = await bot.stewardCommand('apply');
  assert.ok(text.includes('План применён'));
  assert.ok(!text.includes('ничего не записано'));
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) {
    stubAll();
    try {
      await fn();
      console.log(`  ✅ ${name}`);
      passed += 1;
    } catch (error) {
      console.error(`  ❌ ${name}`);
      console.error(`     ${error.message}`);
      process.exitCode = 1;
    }
  }

  restore();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`bot-steward: всего ${tests.length} | ✅ ${passed} | ❌ ${tests.length - passed}`);
  console.log('='.repeat(60));

  if (process.exitCode) process.exit(process.exitCode);
})();
