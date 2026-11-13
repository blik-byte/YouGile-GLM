#!/usr/bin/env node
/**
 * scripts/test-fl-ru.js
 * Тесты сбора FL.ru: разбор RSS, бюджет, приоритет.
 */

'use strict';

const assert = require('assert');
const fl = require('../lib/fl-ru');
const health = require('../lib/source-health');

const RSS = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel>
  <title>Заказы на FL.ru</title>
  <item>
    <title><![CDATA[SEO-продвижение сайта (Бюджет: 30 000 ₽)]]></title>
    <link>https://www.fl.ru/projects/5528001/seo-prodvizhenie.html</link>
    <description><![CDATA[Нужно продвинуть сайт по Москве. Бюджет: 30 000 ₽. Сайт на русском.]]></description>
    <category><![CDATA[SEO / Продвижение]]></category>
    <pubDate>Wed, 11 Nov 2026 09:00:00 GMT</pubDate>
  </item>
  <item>
    <title><![CDATA[Установить моноблок]]></title>
    <link>https://www.fl.ru/projects/5528002/monoblok.html</link>
    <description><![CDATA[Настроить компьютер &amp; ассистента.]]></description>
    <category><![CDATA[Администрирование]]></category>
    <pubDate>Wed, 11 Nov 2026 08:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Без ссылки</title>
    <description>мусор</description>
  </item>
</channel></rss>`;

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('RSS разбирается: заголовок, ссылка, описание, категория', () => {
  const orders = fl.parseRss(RSS);
  assert.strictEqual(orders.length, 2, 'запись без ссылки на проект отбрасывается');

  const first = orders[0];
  assert.strictEqual(first.source, 'fl');
  assert.strictEqual(first.externalId, '5528001');
  assert.strictEqual(first.title, 'SEO-продвижение сайта (Бюджет: 30 000 ₽)');
  assert.ok(first.description.includes('Бюджет: 30 000 ₽'));
  assert.strictEqual(first.category, 'SEO / Продвижение');
  assert.strictEqual(first.budgetValue, 30000);
  assert.strictEqual(first.projectUrl, 'https://www.fl.ru/projects/5528001/seo-prodvizhenie.html');
});

test('HTML-сущности в описании декодируются', () => {
  const orders = fl.parseRss(RSS);
  assert.ok(orders[1].description.includes('компьютер & ассистента'));
});

test('бюджет вытаскивается из разных формулировок', () => {
  assert.strictEqual(fl.parseBudget('(Бюджет: 1 000 ₽)').budgetValue, 1000);
  assert.strictEqual(fl.parseBudget('Бюджет 15000 руб').budgetValue, 15000);
  assert.strictEqual(fl.parseBudget('Бюджет: 3 500 ₽ за проект').budgetValue, 3500);
  assert.strictEqual(fl.parseBudget('без бюджета').budgetValue, 0);
});

test('здоровье источника: свежий успех — не авария, старый — авария', () => {
  const now = new Date('2026-11-13T12:00:00Z');

  const fresh = health.describe(
    { source: 'fl', lastSuccessAt: new Date('2026-11-13T11:00:00Z'), lastAttemptAt: now, consecutiveFailures: 0, lastCount: 60 },
    { downAlertHours: 6, now }
  );
  assert.strictEqual(fresh.down, false);
  assert.strictEqual(fresh.hoursSinceSuccess, 1);

  const stale = health.describe(
    { source: 'fl', lastSuccessAt: new Date('2026-11-13T02:00:00Z'), lastAttemptAt: now, consecutiveFailures: 3 },
    { downAlertHours: 6, now }
  );
  assert.strictEqual(stale.down, true);

  const never = health.describe({ source: 'fl' }, { downAlertHours: 6, now });
  assert.strictEqual(never.down, true, 'без единого успеха источник считается лежащим');
});

test('битый XML не роняет разбор', () => {
  assert.deepStrictEqual(fl.parseRss('<rss><channel></channel></rss>'), []);
  assert.deepStrictEqual(fl.parseRss(''), []);
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
  console.log(`fl-ru: всего ${tests.length} | ✅ ${passed} | ❌ ${tests.length - passed}`);
  console.log('='.repeat(60));

  if (process.exitCode) process.exit(process.exitCode);
})();
