#!/usr/bin/env node
/**
 * scripts/test-rules.js
 * Тесты движка правил на настоящих файлах v1.0.0 + v1.1.0.
 */

'use strict';

const assert = require('assert');
const rules = require('../lib/rules');

const config = rules.loadRules();

const strong = {
  title: 'Провести технический аудит интернет-магазина',
  category: 'SEO',
  description: 'Интернет-магазин на OpenCart, 12 000 страниц. После переезда просел трафик. Нужен аудит: техническая часть, контент, ссылки. Сайт: example.ru. Бюджет 45 000 ₽.',
  budgetValue: 45000,
  budgetKind: 'fixed',
  publishedAt: new Date(Date.now() - 3600000),
  responses: 3,
  client: { rating: 4.9 },
  employment: 'one_time',
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('эффективная версия — 1.1.0, обе части changelog на месте', () => {
  assert.strictEqual(config.meta.rules_version, '1.1.0');
  assert.deepStrictEqual(config.meta.version_chain, ['1.0.0', '1.1.0']);
  const versions = config.meta.changelog.map((entry) => entry.version);
  assert.ok(versions.includes('1.0.0') && versions.includes('1.1.0'));
  assert.ok(config.hard_filters.some((filter) => filter.id === 'HF-07'), 'HF-07 из v1.1.0 не подмешан');
  assert.ok(config.flags.some((flag) => flag.id === 'FL-08'), 'FL-08 из v1.1.0 не подмешан');
});

test('HF-01: оплата за результат — отказ', () => {
  const result = rules.scoreOrder({ ...strong, title: 'SEO с оплатой за результат', description: 'Оплата за результат: вышли в топ — получили деньги.' }, config);
  assert.strictEqual(result.verdict, 'reject');
  assert.ok(result.reasons.some((reason) => reason.id === 'HF-01'));
});

test('HF-06: контекстная реклама — отказ', () => {
  const result = rules.scoreOrder({ ...strong, title: 'Настроить Яндекс Директ', description: 'Кампании, минусовка, цели в Метрике.' }, config);
  assert.strictEqual(result.verdict, 'reject');
  assert.ok(result.reasons.some((reason) => reason.id === 'HF-06'));
});

test('HF-07: разработка сайта — отказ (добавка v1.1.0)', () => {
  const result = rules.scoreOrder({ ...strong, title: 'Разработка сайта на WordPress', description: 'Сделать корпоративный сайт под ключ, 10 страниц.' }, config);
  assert.strictEqual(result.verdict, 'reject');
  assert.ok(result.reasons.some((reason) => reason.id === 'HF-07'));
});

test('HF-03: Украина — отказ', () => {
  const result = rules.scoreOrder({ ...strong, title: 'SEO продвижение в Украине', description: 'Продвижение сайта в Украине, русскоязычный сайт.' }, config);
  assert.strictEqual(result.verdict, 'reject');
  assert.ok(result.reasons.some((reason) => reason.id === 'HF-03'));
});

test('сумма компонентов равна баллу', () => {
  const result = rules.scoreOrder(strong, config);
  const sum = Object.values(result.components).reduce((total, part) => total + part.points, 0);
  assert.ok(Math.abs(sum - result.score) < 1, `сумма ${sum} не равна баллу ${result.score}`);
});

test('полосы бюджета соответствуют правилам', () => {
  assert.strictEqual(rules.budgetNorm({ budgetValue: 3000, budgetKind: 'fixed' }, config.weights.budget), 0.2);
  assert.strictEqual(rules.budgetNorm({ budgetValue: 5000, budgetKind: 'fixed' }, config.weights.budget), 0.4);
  assert.strictEqual(rules.budgetNorm({ budgetValue: 45000, budgetKind: 'fixed' }, config.weights.budget), 0.9);
  assert.strictEqual(rules.budgetNorm({ budgetValue: 90000, budgetKind: 'fixed' }, config.weights.budget), 1.0);
  assert.strictEqual(rules.budgetNorm({ budgetValue: 60000, budgetKind: 'monthly' }, config.weights.budget), 1.0);
  assert.ok(Math.abs(rules.budgetNorm({ budgetValue: 45000, budgetKind: 'from' }, config.weights.budget) - 0.72) < 0.01);
});

test('фактор свежести соответствует таблице', () => {
  assert.strictEqual(rules.freshnessFactor(1), 1.0);
  assert.strictEqual(rules.freshnessFactor(5), 0.85);
  assert.strictEqual(rules.freshnessFactor(20), 0.6);
  assert.strictEqual(rules.freshnessFactor(40), 0.35);
  assert.strictEqual(rules.freshnessFactor(100), 0.15);
});

test('категория вне профиля отсекается до весов', () => {
  const cases = [
    { title: 'Рассылка писем 350 шт через UNISENDER', category: 'Реклама и Маркетинг / Email-маркетинг' },
    { title: 'Blur wheel in real time beamng drive 3d', category: 'Игры / Steam' },
    { title: 'Закрытое тестирование 4 Android-приложений', category: 'Mobile / Приложения для Android' },
    { title: 'Создать AI-Reels о коттеджном посёлке', category: 'Аудио/Видео/Фото / Вертикальные видео' },
  ];

  for (const item of cases) {
    const result = rules.scoreOrder({ ...strong, ...item, description: 'Описание заказа на 200 символов, сайт и задача указаны, бюджет есть.' }, config);
    assert.strictEqual(result.verdict, 'reject', `должен быть отклонён: ${item.title}`);
    assert.ok(result.reasons.some((reason) => reason.id === 'HF-07'));
  }
});

test('заказ без признаков SEO-услуги отклоняется', () => {
  const result = rules.scoreOrder(
    { ...strong, title: 'Поиск 2-3 клиентов на бухгалтерские услуги', category: '', description: 'Нужно найти клиентов, сайт есть, задача описана, бюджет 40 000 ₽.' },
    config
  );
  assert.strictEqual(result.verdict, 'reject');
  assert.ok(result.reasons.some((reason) => reason.text.includes('нет признаков SEO')));
});

test('сильный заказ проходит порог', () => {
  const result = rules.scoreOrder(strong, config);
  assert.strictEqual(result.verdict, 'accept', JSON.stringify(result.reasons));
  assert.ok(result.score >= config.meta.suitable_threshold);
});

test('слабый заказ становится спорным с FL-07', () => {
  const result = rules.scoreOrder(
    {
      ...strong,
      title: 'Настроить метрику',
      description: 'Поставить счётчик',
      budgetValue: 2000,
      budgetKind: 'fixed',
      publishedAt: new Date(Date.now() - 10 * 86400000),
      responses: 40,
      client: {},
    },
    config
  );
  assert.strictEqual(result.verdict, 'unknown');
  assert.ok(result.reasons.some((reason) => reason.id === 'FL-07'));
});

test('FL-01: тестовое задание делает заказ спорным', () => {
  const result = rules.scoreOrder({ ...strong, description: 'Нужен аудит. Сначала тестовое задание на 200 страниц, потом оплата. Сайт: example.ru, бюджет 45 000 ₽.' }, config);
  assert.ok(result.reasons.some((reason) => reason.id === 'FL-01'));
  assert.strictEqual(result.verdict, 'unknown');
});

test('FL-08: пустое описание', () => {
  const result = rules.scoreOrder({ ...strong, description: '' }, config);
  assert.ok(result.reasons.some((reason) => reason.id === 'FL-08'));
});

test('приоритет считается по формуле из meta', () => {
  const result = rules.scoreOrder(strong, config);
  const fresh = rules.freshnessFactor(rules.ageHours(strong.publishedAt));
  const budget = rules.budgetNorm(strong, config.weights.budget);
  const expected = Math.round(result.score * fresh * (0.7 + 0.3 * budget));
  assert.strictEqual(result.priority, expected);
});

test('тип услуги определяется: штат важнее общих слов', () => {
  assert.strictEqual(rules.serviceType('ищем seo-специалиста в штат', config), 'employment');
  assert.strictEqual(rules.serviceType('субподряд для агентства, seo', config), 'subcontract');
  assert.strictEqual(rules.serviceType('seo аудит сайта', config), 'whitelist');
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
