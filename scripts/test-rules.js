#!/usr/bin/env node
/**
 * scripts/test-rules.js
 * Тесты движка правил: HF/FL, компоненты, сумма = балл, версия.
 */

'use strict';

const assert = require('assert');
const rules = require('../lib/rules');

const config = rules.loadRules();

const base = {
  title: 'SEO-аудит интернет-магазина',
  category: 'SEO',
  description: 'Нужен полный аудит: техническая часть, контент, ссылки. Магазин на OpenCart, около 12 тысяч страниц, после переезда просел трафик.',
  budgetValue: 45000,
  publishedAt: new Date(Date.now() - 2 * 3600000),
  responses: 3,
  client: { rating: 4.9 },
  employment: 'one_time',
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('жёсткий фильтр даёт отказ с id HF', () => {
  const result = rules.scoreOrder({ ...base, title: 'Продвижение за результат', description: 'оплата за результат по KPI' }, config);
  assert.strictEqual(result.verdict, 'reject');
  assert.ok(result.reasons.some((reason) => reason.id === 'HF-01'));
});

test('контекстная реклама отсекается как HF-06', () => {
  const result = rules.scoreOrder({ ...base, title: 'Настроить Яндекс Директ', description: 'кампании, минусовка' }, config);
  assert.strictEqual(result.verdict, 'reject');
  assert.ok(result.reasons.some((reason) => reason.id === 'HF-06'));
});

test('сумма компонентов равна баллу', () => {
  const result = rules.scoreOrder(base, config);
  const sum = Object.values(result.components).reduce((total, part) => total + part.points, 0);
  assert.ok(Math.abs(sum - result.score) < 1, `сумма ${sum} не равна баллу ${result.score}`);
});

test('версия правил попадает в результат', () => {
  const result = rules.scoreOrder(base, config);
  assert.strictEqual(result.rulesVersion, config.version);
  assert.strictEqual(result.rulesVersion, '1.1.0');
});

test('сильный заказ проходит порог', () => {
  const result = rules.scoreOrder(base, config);
  assert.strictEqual(result.verdict, 'accept');
  assert.ok(result.score >= config.threshold, `балл ${result.score} ниже порога`);
});

test('дешёвый и старый заказ не проходит порог', () => {
  const result = rules.scoreOrder(
    {
      ...base,
      title: 'Настроить метрику',
      budgetValue: 3000,
      publishedAt: new Date(Date.now() - 10 * 86400000),
      responses: 28,
      client: {},
    },
    config
  );
  assert.strictEqual(result.verdict, 'unknown');
  assert.ok(result.reasons.some((reason) => reason.id === 'FL-07'));
});

test('флаг «бесплатное тестовое» делает заказ спорным', () => {
  const result = rules.scoreOrder(
    { ...base, description: 'Сначала бесплатное тестовое задание, потом оплата. Аудит 200 страниц.' },
    config
  );
  assert.strictEqual(result.verdict, 'unknown');
  assert.ok(result.reasons.some((reason) => reason.id === 'FL-01'));
});

test('пустое описание даёт FL-08', () => {
  const result = rules.scoreOrder({ ...base, description: '' }, config);
  assert.ok(result.reasons.some((reason) => reason.id === 'FL-08'));
});

test('компоненты содержат пояснения для поповера', () => {
  const result = rules.scoreOrder(base, config);
  for (const part of Object.values(result.components)) {
    assert.ok(typeof part.note === 'string' && part.note.length > 0, 'у компонента нет пояснения');
  }
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
  console.log(`rules: всего ${tests.length} | ✅ ${passed} | ❌ ${tests.length - passed}`);
  console.log('='.repeat(60));

  if (process.exitCode) process.exit(process.exitCode);
})();
