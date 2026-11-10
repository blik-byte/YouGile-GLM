#!/usr/bin/env node
/**
 * scripts/test-review.js
 * Тесты петли приёмки (lib/review-loop.js). Сеть не нужна.
 */

'use strict';

const assert = require('assert');
const review = require('../lib/review-loop');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function aiMessage(text) {
  return { label: 'AI', text };
}

function userMessage(text) {
  return { label: 'Кирилл', text };
}

function deps() {
  const calls = { complete: [], comments: [], notifications: [] };
  return {
    calls,
    completeTask: async (id) => calls.complete.push(id),
    addComment: async (id, text) => calls.comments.push({ id, text }),
    notify: async (text) => calls.notifications.push(text),
  };
}

test('«ок» и его формы распознаются как согласие', () => {
  for (const text of ['ок', 'ОК', 'ок!', 'окей', 'ok', 'Okay', '@YouGileBot ок', 'принято', '✅']) {
    assert.strictEqual(review.classify(text), 'accept', `не распознано: ${text}`);
  }
});

test('«не ок» и его формы распознаются как отказ', () => {
  for (const text of ['не ок', 'Не ок!', 'неок', 'нет', 'мимо', 'переделай', '❌']) {
    assert.strictEqual(review.classify(text), 'reject', `не распознано: ${text}`);
  }
});

test('развёрнутый текст решением не считается', () => {
  assert.strictEqual(review.classify('ок, но переделай шапку'), null);
  assert.strictEqual(review.classify('в целом ок, только поправь отступы'), null);
  assert.strictEqual(review.classify(''), null);
  assert.strictEqual(review.classify('   '), null);
  assert.strictEqual(review.classify('a'.repeat(80)), null);
});

test('отчёт агента в чате определяется', () => {
  assert.strictEqual(review.hasAgentReport([aiMessage('Отчёт по итерации')]), true);
  assert.strictEqual(review.hasAgentReport([{ label: 'AI', text: 'просто строка' }]), true);
  assert.strictEqual(review.hasAgentReport([userMessage('Отчёт по итерации')]), false);
  assert.strictEqual(review.hasAgentReport([]), false);
  assert.strictEqual(review.hasAgentReport([{ label: 'AI', text: '   ' }]), false);
});

test('«ок» закрывает задачу и отвечает в чате', async () => {
  const d = deps();
  const result = await review.handleReviewMessage({
    taskId: 't1',
    taskTitle: 'Проверка',
    text: 'ок',
    messages: [aiMessage('Отчёт по итерации (ветка feat/x)')],
    deps: d,
  });

  assert.deepStrictEqual(result, { handled: true, action: 'accept' });
  assert.deepStrictEqual(d.calls.complete, ['t1']);
  assert.strictEqual(d.calls.comments.length, 1);
  assert.ok(d.calls.comments[0].text.includes('Принято'));
  assert.strictEqual(d.calls.notifications.length, 1);
});

test('«не ок» не закрывает задачу и просит уточнение', async () => {
  const d = deps();
  const result = await review.handleReviewMessage({
    taskId: 't2',
    taskTitle: 'Проверка',
    text: 'не ок',
    messages: [aiMessage('Отчёт по итерации')],
    deps: d,
  });

  assert.deepStrictEqual(result, { handled: true, action: 'reject' });
  assert.deepStrictEqual(d.calls.complete, []);
  assert.strictEqual(d.calls.comments.length, 1);
  assert.ok(d.calls.comments[0].text.includes('доработке'));
});

test('без отчёта агента решение не принимается', async () => {
  const d = deps();
  const result = await review.handleReviewMessage({
    taskId: 't3',
    text: 'ок',
    messages: [userMessage('ок'), userMessage('просто болтаю')],
    deps: d,
  });

  assert.deepStrictEqual(result, { handled: false, reason: 'no-report' });
  assert.deepStrictEqual(d.calls.complete, []);
  assert.strictEqual(d.calls.comments.length, 0);
});

test('закрытую задачу повторно не трогаем', async () => {
  const d = deps();
  const result = await review.handleReviewMessage({
    taskId: 't4',
    completed: true,
    text: 'ок',
    messages: [aiMessage('Отчёт')],
    deps: d,
  });

  assert.deepStrictEqual(result, { handled: false, reason: 'already-completed' });
  assert.deepStrictEqual(d.calls.complete, []);
});

test('обычный текст в задаче не считается решением', async () => {
  const d = deps();
  const result = await review.handleReviewMessage({
    taskId: 't5',
    text: 'А можно ещё поправить заголовок?',
    messages: [aiMessage('Отчёт')],
    deps: d,
  });

  assert.deepStrictEqual(result, { handled: false, reason: 'not-a-decision' });
  assert.strictEqual(d.calls.comments.length, 0);
});

test('падение уведомления не ломает обработку решения', async () => {
  const d = deps();
  d.notify = async () => {
    throw new Error('Telegram недоступен');
  };

  const result = await review.handleReviewMessage({
    taskId: 't6',
    taskTitle: 'Проверка',
    text: 'ок',
    messages: [aiMessage('Отчёт')],
    deps: d,
  });

  assert.deepStrictEqual(result, { handled: true, action: 'accept' });
  assert.deepStrictEqual(d.calls.complete, ['t6']);
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
  console.log(`review: всего ${tests.length} | ✅ ${passed} | ❌ ${tests.length - passed}`);
  console.log('='.repeat(60));

  if (process.exitCode) process.exit(process.exitCode);
})();
