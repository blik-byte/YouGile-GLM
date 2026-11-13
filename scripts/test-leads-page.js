#!/usr/bin/env node
/**
 * scripts/test-leads-page.js
 * Тесты подстановки реальных данных в макет v3.
 */

'use strict';

const assert = require('assert');
const page = require('../lib/leads-page');

const fixture = `
<script>
var RAW = [
  {id:'demo', t:'Демо заказ'}
];
var PENDING = [
  {id:'p1'}
];
var NEWS = [
  {t:'новость'}
];
var NEWS_TOPICS = ['a'];
var SOURCES = [
  {id:'kw', name:'Kwork'}
];
var REPLIES = [
  {lead:'kw-1'}
];
var SITES = [
  {name:'demo.ru'}
];
</script>`;

const leadDoc = {
  source: 'fl',
  externalId: '774211',
  title: 'Провести SEO-аудит интернет-магазина',
  description: 'Магазин на OpenCart, 12 000 страниц.',
  category: 'SEO',
  budget: '45 000 ₽',
  budgetValue: 45000,
  budgetKind: 'fixed',
  publishedAt: new Date(Date.now() - 3600000),
  responses: 3,
  employment: 'one_time',
  verdict: 'accept',
  score: 78,
  priority: 61,
  serviceType: 'whitelist',
  rulesVersion: '1.1.0',
  status: 'new',
  reasons: [{ id: 'FL-01', text: 'Большое бесплатное тестовое: «тестовое задание»' }],
  components: { service_match: { weight: 30, value: 1, points: 30, note: 'тип услуги: whitelist' } },
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('документ базы превращается в объект макета', () => {
  const item = page.mapLead(leadDoc);

  assert.strictEqual(item.id, 'fl-774211');
  assert.strictEqual(item.src, 'fl');
  assert.strictEqual(item.t, 'Провести SEO-аудит интернет-магазина');
  assert.strictEqual(item.v, 'accept');
  assert.strictEqual(item.score, 78);
  assert.strictEqual(item.type, 'audit');
  assert.ok(item.h >= 0 && item.h <= 2, `часы посчитаны неверно: ${item.h}`);
  assert.ok(item.vr.includes('FL-01') || item.vr.includes('тестовое'));
});

test('пустые причины дают понятную строку, а не пустоту', () => {
  const item = page.mapLead({ ...leadDoc, reasons: [] });
  assert.strictEqual(item.vr, 'жёстких причин нет');
});

test('тип черновика определяется по заголовку', () => {
  assert.strictEqual(page.draftType('Технический аудит сайта'), 'audit');
  assert.strictEqual(page.draftType('Наращивание ссылочной массы'), 'links');
  assert.strictEqual(page.draftType('Консультация по SEO'), 'consult');
  assert.strictEqual(page.draftType('SEO продвижение сайта'), 'seo');
  assert.strictEqual(page.draftType('Что-то непонятное'), 'generic');
});

test('подстановка заменяет все демо-массивы', () => {
  const html = page.injectData(fixture, { orders: [page.mapLead(leadDoc)], health: null });

  assert.ok(html.includes('SEO-аудит интернет-магазина'), 'реальные данные не попали');
  assert.ok(!html.includes('Демо заказ'), 'демо-заказ остался');
  assert.ok(!html.includes('Kwork'), 'источник Kwork остался');
  assert.ok(html.includes('FL.ru'), 'источник FL.ru не добавлен');
  assert.ok(/var PENDING = \[\];/.test(html), 'PENDING не очищен');
  assert.ok(/var NEWS = \[\];/.test(html), 'NEWS не очищены');
  assert.ok(/var SITES = \[\];/.test(html), 'SITES не очищены');
});

test('источник один — FL.ru, и он показывает здоровье', () => {
  const down = page.buildSources({ down: true, lastAttemptAt: new Date(), lastError: 'HTTP 503' });
  assert.strictEqual(down.length, 1);
  assert.strictEqual(down[0].id, 'fl');
  assert.strictEqual(down[0].health, 'err');
  assert.ok(down[0].comment.includes('503'));

  const ok = page.buildSources({ down: false, lastAttemptAt: new Date(Date.now() - 90 * 60000), lastError: null });
  assert.strictEqual(ok[0].health, 'ok');
  assert.strictEqual(ok[0].last, '2 ч назад');
});

test('отсутствие массива в макете — явная ошибка, а не тихая поломка', () => {
  assert.throws(() => page.replaceArray('<script></script>', 'RAW', []), /не найден массив RAW/);
});

test('JSON внутри скрипта не ломает страницу закрывающим тегом', () => {
  const html = page.injectData(fixture, { orders: [page.mapLead({ ...leadDoc, title: 'Закрыть </script>' })] });
  assert.ok(html.includes('<\\/script>'), 'тег не экранирован');
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
  console.log(`leads-page: всего ${tests.length} | ✅ ${passed} | ❌ ${tests.length - passed}`);
  console.log('='.repeat(60));

  if (process.exitCode) process.exit(process.exitCode);
})();
