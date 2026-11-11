#!/usr/bin/env node
/**
 * scripts/test-kwork-digest.js
 * Тесты сборки дайджеста Kwork (lib/kwork-digest.js) — без базы и без сети.
 */

'use strict';

const assert = require('assert');
const digest = require('../lib/kwork-digest');

const items = [
  {
    projectId: '1',
    title: 'SEO-разведка для тревел-блога',
    category: 'SEO и трафик > Семантическое ядро',
    price: '30 000 Р',
    priceValue: 30000,
    verdict: 'accept',
    reason: null,
    projectUrl: 'https://kwork.ru/projects/1',
  },
  {
    projectId: '2',
    title: 'SEO-оптимизация зарубежного магазина',
    category: 'SEO и трафик > SEO аудиты',
    price: '15 000 Р',
    priceValue: 15000,
    verdict: 'reject',
    reason: 'сайт зарубежный, работаю только с русскоязычными',
    projectUrl: 'https://kwork.ru/projects/2',
  },
  {
    projectId: '3',
    title: 'Дизайн логотипа',
    category: '',
    price: '',
    priceValue: 0,
    verdict: 'unknown',
    reason: 'нет явных признаков SEO-заказа',
    projectUrl: 'https://kwork.ru/projects/3',
  },
];

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('цена переводится в число', () => {
  assert.strictEqual(digest.parsePrice('30 000 Р'), 30000);
  assert.strictEqual(digest.parsePrice('2 000 ₽'), 2000);
  assert.strictEqual(digest.parsePrice(''), 0);
  assert.strictEqual(digest.parsePrice(null), 0);
});

test('дайджест начинается с одного списка, затем черновики для подходящих', () => {
  const messages = digest.buildDigest(items);

  assert.strictEqual(messages.length, 2, 'список + один черновик (для accept)');
  assert.ok(messages[0].includes('3 новых проекта'));
  assert.ok(messages[0].includes('SEO-разведка'));
  assert.ok(messages[0].includes('⛔'));
  assert.ok(messages[0].includes('❔'));
  assert.ok(messages[1].includes('Черновик отклика'));
});

test('у отклонённых видна причина отказа', () => {
  const [list] = digest.buildDigest(items);
  assert.ok(list.includes('зарубежный'));
});

test('без подходящих проектов черновиков нет', () => {
  const onlyRejected = items.filter((item) => item.verdict !== 'accept');
  const messages = digest.buildDigest(onlyRejected);
  assert.strictEqual(messages.length, 1);
});

test('пустой список — пустой результат', () => {
  assert.deepStrictEqual(digest.buildDigest([]), []);
});

test('склонение «проект / проекта / проектов» работает', () => {
  assert.ok(digest.buildDigest([items[0]])[0].includes('1 новый проект'));
  assert.ok(digest.buildDigest([items[0], items[1]])[0].includes('2 новых проекта'));
  assert.ok(digest.buildDigest([...items, ...items])[0].includes('6 новых проектов'));
});

test('HTML в названии экранируется', () => {
  const [list] = digest.buildDigest([{ ...items[0], title: 'SEO <script> & сайт' }]);
  assert.ok(list.includes('&lt;script&gt;'));
  assert.ok(list.includes('&amp;'));
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
  console.log(`kwork-digest: всего ${tests.length} | ✅ ${passed} | ❌ ${tests.length - passed}`);
  console.log('='.repeat(60));

  if (process.exitCode) process.exit(process.exitCode);
})();
