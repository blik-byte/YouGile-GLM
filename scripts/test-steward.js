#!/usr/bin/env node
/**
 * scripts/test-steward.js
 * Тесты lib/yougile-admin.js на подменённом слое запросов к YouGile.
 * Сеть не нужна: yougile.request подменяется функцией над объектом в памяти.
 */

'use strict';

const assert = require('assert');
const yougile = require('../lib/yougile-client');
const admin = require('../lib/yougile-admin');

const originalRequest = yougile.request;

let store;
let calls;
let counter;

function reset() {
  counter = 0;
  calls = [];
  store = {
    projects: [],
    boards: [],
    columns: [],
    tasks: [],
    users: [{ id: 'u1', email: 'owner@test', realName: 'Кирилл', deleted: null }],
  };
}

function nextId(prefix) {
  counter += 1;
  return `${prefix}-${counter}`;
}

/** Ответ списка в формате YouGile. */
function listResponse(items) {
  return { ok: true, status: 200, data: { content: items, paging: { next: false } } };
}

function fakeRequest(method, apiPath, options = {}) {
  const query = options.query || {};
  const body = options.body || {};
  calls.push({ method, path: apiPath, body, query });

  const [base, id] = apiPath.replace(/^\//, '').split('/');

  if (method === 'GET') {
    if (base === 'users' && id === 'me') {
      return { ok: true, status: 200, data: store.users[0] };
    }
    if (base === 'projects') return listResponse(store.projects);
    if (base === 'boards') return listResponse(store.boards.filter((b) => b.projectId === query.projectId));
    if (base === 'columns') return listResponse(store.columns.filter((c) => c.boardId === query.boardId));
    if (base === 'tasks') return listResponse(store.tasks.filter((t) => t.columnId === query.columnId));
    if (base === 'users') return listResponse(store.users);
  }

  if (method === 'POST') {
    const record = { id: nextId(base), deleted: null, ...body };
    if (base === 'projects') store.projects.push(record);
    if (base === 'boards') store.boards.push(record);
    if (base === 'columns') store.columns.push(record);
    if (base === 'tasks') store.tasks.push({ completed: false, ...record });
    return { ok: true, status: 200, data: { id: record.id } };
  }

  if (method === 'PUT' && base === 'tasks') {
    const task = store.tasks.find((item) => item.id === id);
    assert.ok(task, `PUT на несуществующую задачу ${id}`);
    Object.assign(task, body);
    return { ok: true, status: 200, data: { id } };
  }

  if (method === 'PUT' && ['projects', 'boards', 'columns'].includes(base)) {
    const collection = base === 'projects' ? store.projects : base === 'boards' ? store.boards : store.columns;
    const record = collection.find((item) => item.id === id);
    assert.ok(record, `PUT на несуществующий ${base}/${id}`);
    Object.assign(record, body);
    return { ok: true, status: 200, data: { id } };
  }

  throw new Error(`Неожиданный запрос: ${method} ${apiPath}`);
}

function taskByTitle(title) {
  return store.tasks.find((item) => item.title === title);
}

const basicPlan = {
  project: { title: 'Тест', description: 'описание проекта' },
  boards: [
    {
      title: 'Roadmap',
      columns: [{ title: '0. Техдолг' }, { title: '1. Контент' }],
      tasks: [
        {
          code: 'TD-01',
          column: '0. Техдолг',
          title: 'Первая задача',
          description: 'Что-то починить',
          checklist: ['Проверить лог', 'Написать тест'],
        },
        {
          code: 'CT-01',
          column: '1. Контент',
          title: 'Вторая задача',
          description: 'Написать статью',
          assignees: ['owner@test'],
        },
      ],
    },
  ],
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('маркеры: новый формат читается, старый распознаётся и вычищается', () => {
  assert.strictEqual(admin.extractCode('<!--plan:TD-09-->\nтекст'), 'TD-09');
  assert.strictEqual(admin.extractCode('[plan:TD-09]\n\nтекст'), 'TD-09');
  assert.strictEqual(admin.extractCode('обычный текст'), null);

  const cleaned = admin.withMarker('[plan:OLD-1]\n\nПолезный текст', 'NEW-1');
  assert.ok(cleaned.startsWith('<!--plan:NEW-1-->'));
  assert.ok(!cleaned.includes('[plan:OLD-1]'), 'старый маркер должен исчезнуть');
  assert.ok(cleaned.includes('Полезный текст'));
  assert.strictEqual(admin.stripMarkers(cleaned), 'Полезный текст');
});

test('dry-run ничего не пишет и показывает план работ', async () => {
  reset();
  const stats = await admin.applyPlan(basicPlan, { dryRun: true, writeDelayMs: 0 });

  const writes = calls.filter((call) => call.method !== 'GET');
  assert.strictEqual(writes.length, 0, 'в режиме проверки запись запрещена');
  assert.strictEqual(stats.dryRun, true);
  assert.strictEqual(stats.tasks.created, 2);
  assert.strictEqual(store.tasks.length, 0);
});

test('первое применение создаёт проект, доску, колонки и задачи', async () => {
  reset();
  const stats = await admin.applyPlan(basicPlan, { writeDelayMs: 0 });

  assert.strictEqual(stats.project.created, true);
  assert.strictEqual(stats.boards.created, 1);
  assert.strictEqual(stats.columns.created, 2);
  assert.strictEqual(stats.tasks.created, 2);
  assert.strictEqual(stats.errors.length, 0);

  const task = taskByTitle('Первая задача');
  assert.ok(!task.description.includes('[plan:'), 'старый формат не должен попадать в карточку');
  assert.ok(!task.description.includes('<!--'), 'HTML-комментарии YouGile вырезает — не отправляем');
  assert.strictEqual(task.description.trim(), 'Что-то починить');
  assert.strictEqual(task.checklists[0].items.length, 2);
  assert.strictEqual(task.checklists[0].items[0].isCompleted, false);
});

test('повторное применение ничего не меняет', async () => {
  reset();
  await admin.applyPlan(basicPlan, { writeDelayMs: 0 });
  calls.length = 0;

  const stats = await admin.applyPlan(basicPlan, { writeDelayMs: 0 });
  const writes = calls.filter((call) => call.method !== 'GET');

  assert.strictEqual(writes.length, 0, 'идемпотентность: ни одного POST/PUT');
  assert.strictEqual(stats.tasks.created, 0);
  assert.strictEqual(stats.tasks.updated, 0);
  assert.strictEqual(stats.tasks.skipped, 2);
});

test('изменение в плане обновляет только изменившиеся поля', async () => {
  reset();
  await admin.applyPlan(basicPlan, { writeDelayMs: 0 });
  calls.length = 0;

  const changed = JSON.parse(JSON.stringify(basicPlan));
  changed.boards[0].tasks[0].description = 'Другое описание';

  const stats = await admin.applyPlan(changed, { writeDelayMs: 0 });
  const puts = calls.filter((call) => call.method === 'PUT');

  assert.strictEqual(stats.tasks.updated, 1);
  assert.strictEqual(puts.length, 1);
  assert.ok(puts[0].body.description.includes('Другое описание'));
  assert.strictEqual(puts[0].body.title, undefined, 'название не менялось — не отправляем');
  assert.strictEqual(puts[0].body.checklists, undefined, 'чек-лист не менялся — не отправляем');
});

test('отметки чек-листа сохраняются при повторном применении', async () => {
  reset();
  await admin.applyPlan(basicPlan, { writeDelayMs: 0 });

  const task = taskByTitle('Первая задача');
  task.checklists[0].items[0].isCompleted = true;
  calls.length = 0;

  const stats = await admin.applyPlan(basicPlan, { writeDelayMs: 0 });
  const puts = calls.filter((call) => call.method === 'PUT');

  assert.strictEqual(stats.tasks.skipped, 2);
  assert.strictEqual(puts.length, 0, 'выполненный пункт не должен сбрасываться');
  assert.strictEqual(taskByTitle('Первая задача').checklists[0].items[0].isCompleted, true);
});

test('старый маркер в живой задаче вычищается при обновлении', async () => {
  reset();
  await admin.applyPlan(basicPlan, { writeDelayMs: 0 });

  const task = taskByTitle('Первая задача');
  task.description = `[plan:TD-01]\n\n[plan:TD-01]\n\nЧто-то починить`;
  calls.length = 0;

  const stats = await admin.applyPlan(basicPlan, { writeDelayMs: 0 });
  const puts = calls.filter((call) => call.method === 'PUT');

  assert.strictEqual(stats.tasks.updated, 1);
  assert.strictEqual(puts.length, 1);
  assert.ok(!taskByTitle('Первая задача').description.includes('[plan:'));
  assert.strictEqual(taskByTitle('Первая задача').description.trim(), 'Что-то починить');
});

test('текст с угловыми скобками экранируется и повторный прогон ничего не меняет', async () => {
  reset();
  const plan = JSON.parse(JSON.stringify(basicPlan));
  plan.boards[0].tasks[0].description = 'Ответ /approve <id> и стрелка ->';

  await admin.applyPlan(plan, { writeDelayMs: 0 });
  const task = taskByTitle('Первая задача');
  assert.ok(task.description.includes('&lt;id&gt;'), 'скобки должны быть экранированы');

  calls.length = 0;
  const stats = await admin.applyPlan(plan, { writeDelayMs: 0 });
  assert.strictEqual(stats.tasks.updated, 0, 'второй прогон не должен ничего обновлять');
});

test('вставки вида <id> не считаются расхождением: их всё равно вырежет API', async () => {
  reset();
  await admin.applyPlan(basicPlan, { writeDelayMs: 0 });

  const task = taskByTitle('Первая задача');
  task.description = 'Команда /approve .';
  calls.length = 0;

  const plan = JSON.parse(JSON.stringify(basicPlan));
  plan.boards[0].tasks[0].description = 'Команда /approve <id>.';

  const stats = await admin.applyPlan(plan, { writeDelayMs: 0 });
  assert.strictEqual(stats.tasks.updated, 0, 'не должно быть повторной перезаписи');
});

test('статусы и правка: закрыть, переместить, переименовать', async () => {
  reset();
  await admin.applyPlan(basicPlan, { writeDelayMs: 0 });

  const task = taskByTitle('Первая задача');
  const column = store.columns.find((item) => item.title === '1. Контент');

  await admin.setTaskCompleted(task.id, true);
  assert.strictEqual(task.completed, true);

  await admin.moveTaskToColumn(task.id, column.id);
  assert.strictEqual(task.columnId, column.id);

  await admin.updateTaskFields(task.id, { title: 'Новое имя' });
  assert.strictEqual(task.title, 'Новое имя');

  const project = store.projects[0];
  await admin.renameEntity('project', project.id, 'Проект 2');
  assert.strictEqual(project.title, 'Проект 2');
});

test('колонка ищется по названию, неоднозначность — ошибка', async () => {
  reset();
  await admin.applyPlan(basicPlan, { writeDelayMs: 0 });

  const column = await admin.findColumn('1. Контент');
  assert.strictEqual(column.title, '1. Контент');

  store.columns.push({ id: 'dup', title: '1. Контент', boardId: column.boardId, deleted: null });
  await assert.rejects(() => admin.findColumn('1. Контент'), /несколько/);
  await assert.rejects(() => admin.findColumn('9. Нет такой'), /не найдена/);
});

test('правка без полей отклоняется', async () => {
  reset();
  await admin.applyPlan(basicPlan, { writeDelayMs: 0 });
  const task = taskByTitle('Первая задача');
  await assert.rejects(() => admin.updateTaskFields(task.id, {}), /Нечего менять/);
});

test('исполнитель из плана подставляется по почте', async () => {
  reset();
  await admin.applyPlan(basicPlan, { writeDelayMs: 0 });

  const task = taskByTitle('Вторая задача');
  assert.deepStrictEqual(task.assigned, ['u1']);
});

test('неизвестный исполнитель не ломает применение', async () => {
  reset();
  const plan = JSON.parse(JSON.stringify(basicPlan));
  plan.boards[0].tasks[1].assignees = ['nobody@test'];

  const stats = await admin.applyPlan(plan, { writeDelayMs: 0 });
  const task = taskByTitle('Вторая задача');

  assert.strictEqual(stats.errors.length, 0);
  assert.strictEqual(task.assigned, undefined, 'неизвестный исполнитель просто не ставится');
});

test('задача с несуществующей колонкой попадает в ошибки, остальные создаются', async () => {
  reset();
  const plan = JSON.parse(JSON.stringify(basicPlan));
  plan.boards[0].tasks.push({ code: 'X-1', column: '9. Нет такой', title: 'Сирота', description: '' });

  const stats = await admin.applyPlan(plan, { writeDelayMs: 0 });

  assert.strictEqual(stats.tasks.created, 2);
  assert.strictEqual(stats.errors.length, 1);
  assert.ok(stats.errors[0].includes('9. Нет такой'));
});

(async () => {
  yougile.request = fakeRequest;

  let passed = 0;
  for (const { name, fn } of tests) {
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

  yougile.request = originalRequest;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`steward: всего ${tests.length} | ✅ ${passed} | ❌ ${tests.length - passed}`);
  console.log('='.repeat(60));

  if (process.exitCode) process.exit(process.exitCode);
})();
