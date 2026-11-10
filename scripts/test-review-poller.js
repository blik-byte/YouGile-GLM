#!/usr/bin/env node
/**
 * scripts/test-review-poller.js
 * Тесты резервного канала приёмки (lib/review-poller.js): опрос чатов задач.
 */

'use strict';

const assert = require('assert');
const { createReviewPoller } = require('../lib/review-poller');

const PROJECT = 'AI агенты и YG';

function setup({ tasks, chats }) {
  const calls = { completed: [], comments: [] };

  const admin = {
    listProjects: async () => [{ id: 'p1', title: PROJECT }],
    listBoards: async () => [{ id: 'b1', title: 'Roadmap' }],
    listColumns: async () => [{ id: 'c1', title: '5. Оркестрация' }],
    listTasks: async () => tasks,
  };

  const yougile = {
    getChatMessages: async (taskId) => chats[taskId] || [],
  };

  const deps = {
    completeTask: async (id) => calls.completed.push(id),
    addComment: async (id, text) => calls.comments.push({ id, text }),
    notify: async () => {},
  };

  const poller = createReviewPoller({ admin, yougile, projectTitle: PROJECT, deps, pauseMs: 0 });
  return { poller, calls };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('«ок» в чате незакрытой задачи закрывает её', async () => {
  const { poller, calls } = setup({
    tasks: [{ id: 't1', title: 'Проверка', completed: false, assigned: ['u1'] }],
    chats: { t1: [{ label: 'AI', text: 'Отчёт по итерации' }, { text: 'ок' }] },
  });

  const stats = await poller.pollOnce();
  assert.strictEqual(stats.handled, 1);
  assert.deepStrictEqual(calls.completed, ['t1']);
});

test('повторный опрос не обрабатывает то же сообщение дважды', async () => {
  const { poller, calls } = setup({
    tasks: [{ id: 't1', title: 'Проверка', completed: false, assigned: ['u1'] }],
    chats: { t1: [{ label: 'AI', text: 'Отчёт' }, { id: 'm1', text: 'ок' }] },
  });

  await poller.pollOnce();
  const second = await poller.pollOnce();

  assert.strictEqual(second.handled, 0, 'второго закрытия быть не должно');
  assert.deepStrictEqual(calls.completed, ['t1']);
});

test('задача без исполнителя не проверяется', async () => {
  const { poller } = setup({
    tasks: [{ id: 't2', title: 'Без исполнителя', completed: false, assigned: [] }],
    chats: { t2: [{ label: 'AI', text: 'Отчёт' }, { text: 'ок' }] },
  });

  const stats = await poller.pollOnce();
  assert.strictEqual(stats.tasks, 0);
  assert.strictEqual(stats.handled, 0);
});

test('закрытая задача пропускается', async () => {
  const { poller, calls } = setup({
    tasks: [{ id: 't3', title: 'Уже закрыта', completed: true, assigned: ['u1'] }],
    chats: { t3: [{ label: 'AI', text: 'Отчёт' }, { text: 'ок' }] },
  });

  const stats = await poller.pollOnce();
  assert.strictEqual(stats.tasks, 0);
  assert.deepStrictEqual(calls.completed, []);
});

test('последнее сообщение агента не считается решением', async () => {
  const { poller, calls } = setup({
    tasks: [{ id: 't4', title: 'Ждёт ответа', completed: false, assigned: ['u1'] }],
    chats: { t4: [{ text: 'ок' }, { label: 'AI', text: '💡 Ответ: готово' }] },
  });

  const stats = await poller.pollOnce();
  assert.strictEqual(stats.handled, 0);
  assert.deepStrictEqual(calls.completed, []);
});

test('«не ок» не закрывает задачу', async () => {
  const { poller, calls } = setup({
    tasks: [{ id: 't5', title: 'На доработке', completed: false, assigned: ['u1'] }],
    chats: { t5: [{ label: 'AI', text: 'Отчёт' }, { text: 'не ок' }] },
  });

  const stats = await poller.pollOnce();
  assert.strictEqual(stats.handled, 1);
  assert.deepStrictEqual(calls.completed, []);
  assert.ok(calls.comments[0].text.includes('доработке'));
});

test('обычный текст в чате решением не считается', async () => {
  const { poller, calls } = setup({
    tasks: [{ id: 't6', title: 'Обсуждение', completed: false, assigned: ['u1'] }],
    chats: { t6: [{ label: 'AI', text: 'Отчёт' }, { text: 'а можно ещё поправить шапку?' }] },
  });

  const stats = await poller.pollOnce();
  assert.strictEqual(stats.decisions, 0);
  assert.deepStrictEqual(calls.completed, []);
});

(async () => {
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

  console.log(`\n${'='.repeat(60)}`);
  console.log(`review-poller: всего ${tests.length} | ✅ ${passed} | ❌ ${tests.length - passed}`);
  console.log('='.repeat(60));

  if (process.exitCode) process.exit(process.exitCode);
})();
