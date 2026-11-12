#!/usr/bin/env node
/**
 * scripts/test-kwork-filter.js
 * Тесты отбора заказов Kwork по заголовку (lib/kwork-filter.js).
 */

'use strict';

const assert = require('assert');
const filter = require('../lib/kwork-filter');

const rules = filter.loadFilters();

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('подходящие заказы распознаются', () => {
  const cases = [
    'SEO продвижение сайта',
    'Комплексное продвижение сайта в Яндексе',
    'Технический аудит сайта',
    'Юзабилити аудит интернет-магазина',
    'Комплексный аудит сайта',
    'Наращивание ссылочной массы',
    'Внешняя оптимизация сайта',
    'Консультация по SEO',
    'Разовая оптимизация сайта',
    'Сбор семантического ядра',
  ];

  for (const title of cases) {
    const result = filter.classify(title, rules);
    assert.strictEqual(result.verdict, 'accept', `не распознан: ${title}`);
  }
});

test('неподходящие заказы отсекаются с причиной', () => {
  const cases = [
    ['Продвижение сайта за результат', 'оплата за результат'],
    ['SEO за процент от продаж', 'оплата процентом'],
    ['Продвижение сайта по России', 'продвижение только по России'],
    ['Продвижение по городам России', 'продвижение по городам России'],
    ['SEO-продвижение в Украине', 'продвижение в Украине'],
    ['Продвижение сайта в Европе', 'продвижение в Европе'],
  ];

  for (const [title, reasonPart] of cases) {
    const result = filter.classify(title, rules);
    assert.strictEqual(result.verdict, 'reject', `должен быть отклонён: ${title}`);
    assert.ok(result.reason.includes(reasonPart), `неверная причина для «${title}»: ${result.reason}`);
  }
});

test('исключение сильнее включения', () => {
  // В заголовке есть и «SEO», и «по России» — отказ должен победить.
  const result = filter.classify('SEO продвижение сайта по России', rules);
  assert.strictEqual(result.verdict, 'reject');
});

test('неизвестные темы уходят в спорные, а не в отказ', () => {
  for (const title of ['Нужен дизайн логотипа', 'Настроить контекстную рекламу', 'Переписать тексты на сайте']) {
    const result = filter.classify(title, rules);
    assert.strictEqual(result.verdict, 'unknown', `должен быть спорным: ${title}`);
  }
});

test('регистр и ё не мешают: «Ссылочная масса» = «ссылочная масса»', () => {
  assert.strictEqual(filter.classify('ССЫЛОЧНАЯ МАССА', rules).verdict, 'accept');
  assert.strictEqual(filter.classify('Ссылочная масса', rules).verdict, 'accept');
});

test('пачка распределяется по трём корзинам', () => {
  const result = filter.classifyMany(
    ['SEO продвижение сайта', 'Продвижение за результат', 'Дизайн логотипа'],
    rules
  );

  assert.strictEqual(result.accept.length, 1);
  assert.strictEqual(result.reject.length, 1);
  assert.strictEqual(result.unknown.length, 1);
});

test('описание не делает заказ подходящим: решают заголовок и категория', () => {
  const withNoise = filter.classifyOrder(
    {
      title: 'Оставить отзыв с Карт',
      category: 'Тексты / Постинг',
      description: 'Нужно написать отзыв про сайт и продвижение, добавить ссылки',
    },
    rules
  );
  assert.strictEqual(withNoise.verdict, 'unknown');

  const realSeo = filter.classifyOrder(
    { title: 'SEO-продвижение сайта', category: 'Сайты', description: 'подробности в лс' },
    rules
  );
  assert.strictEqual(realSeo.verdict, 'accept');

  const excluded = filter.classifyOrder(
    { title: 'SEO-специалист', category: 'Сайты', description: 'продвижение только по России' },
    rules
  );
  assert.strictEqual(excluded.verdict, 'reject', 'исключение из описания должно работать');
});

test('пустой заголовок не ломает проверку', () => {
  assert.strictEqual(filter.classify('', rules).verdict, 'unknown');
  assert.strictEqual(filter.classify(null, rules).verdict, 'unknown');
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
  console.log(`kwork-filter: всего ${tests.length} | ✅ ${passed} | ❌ ${tests.length - passed}`);
  console.log('='.repeat(60));

  if (process.exitCode) process.exit(process.exitCode);
})();
