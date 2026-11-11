#!/usr/bin/env node
/**
 * scripts/test-kwork-reply.js
 * Тесты сборки черновика отклика (lib/kwork-reply.js).
 */

'use strict';

const assert = require('assert');
const reply = require('../lib/kwork-reply');

const replies = reply.loadReplies();

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('тип определяется по заголовку', () => {
  assert.strictEqual(reply.detectType('Технический аудит сайта', replies), 'audit');
  assert.strictEqual(reply.detectType('Юзабилити аудит интернет-магазина', replies), 'audit');
  assert.strictEqual(reply.detectType('Наращивание ссылочной массы', replies), 'links');
  assert.strictEqual(reply.detectType('Консультация по SEO', replies), 'consult');
  assert.strictEqual(reply.detectType('SEO продвижение сайта', replies), 'seo');
  assert.strictEqual(reply.detectType('Дизайн логотипа', replies), 'generic');
});

test('подстановка цены и подписи работает', () => {
  const { text } = reply.buildReply('SEO продвижение сайта', { replies });
  assert.ok(text.includes('15 000'), 'цена должна попасть в письмо');
  assert.ok(text.includes('С 2008 года') || text.includes('с 2008 года'), 'подпись должна быть');
  assert.ok(!text.includes('{{pricing}}'), 'плейсхолдер не должен остаться');
});

test('аудит не обещает цену продвижения', () => {
  const { text } = reply.buildReply('Технический аудит сайта', { replies });
  assert.ok(!text.includes('15 000'), 'в аудите цена подписки не нужна');
  assert.ok(text.includes('приоритет'));
});

test('в шаблоне нет пустых блоков и двойных переводов строк подряд больше двух', () => {
  for (const key of Object.keys(replies.templates)) {
    const { text } = reply.buildReply('', { replies, type: key });
    assert.ok(text.length > 80, `шаблон ${key} слишком короткий`);
    assert.ok(!/\n{4,}/.test(text), `в шаблоне ${key} лишние пустые строки`);
  }
});

test('писем без «низкие цены» — это не аргумент', () => {
  for (const key of Object.keys(replies.templates)) {
    const { text } = reply.buildReply('', { replies, type: key });
    assert.ok(!/низк(ие|ая) цен/i.test(text), `в шаблоне ${key} остался довод «низкие цены»`);
  }
});

test('неизвестный тип безопасно падает в generic', () => {
  const { type, text } = reply.buildReply('Что-то непонятное', { replies, type: 'нет-такого' });
  assert.strictEqual(type, 'нет-такого');
  assert.ok(text.includes('пришлите адрес сайта'));
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
  console.log(`kwork-reply: всего ${tests.length} | ✅ ${passed} | ❌ ${tests.length - passed}`);
  console.log('='.repeat(60));

  if (process.exitCode) process.exit(process.exitCode);
})();
