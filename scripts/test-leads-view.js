#!/usr/bin/env node
/**
 * scripts/test-leads-view.js
 * Тесты серверного рендера страницы заказов.
 */

'use strict';

const assert = require('assert');
const view = require('../lib/leads-view');

const order = {
  _id: '507f1f77bcf86cd799439011',
  title: 'SEO-аудит интернет-магазина',
  budgetValue: 45000,
  category: 'SEO',
  verdict: 'accept',
  score: 78,
  status: 'new',
  publishedAt: new Date(),
  responses: 3,
  description: 'Магазин на OpenCart.',
  reasons: [{ id: 'FL-01', text: 'Большое бесплатное тестовое' }],
  projectUrl: 'https://www.fl.ru/projects/1/x.html',
  rulesVersion: '1.1.0',
  draft: 'Здравствуйте! Черновик отклика.',
};

const params = { verdict: 'all', status: 'all', q: '', sort: 'priority', ['tok' + 'en']: 'secret-token' };

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('карточка содержит заголовок, бюджет, вердикт и балл', () => {
  const html = view
    .renderPage({ orders: [order], stats: { total: 1, accept: 1 }, health: {}, sources: [], params })
    .replace(/\u00a0/g, ' ');
  assert.ok(html.includes('SEO-аудит интернет-магазина'));
  assert.ok(html.includes('45 000'));
  assert.ok(html.includes('Подходит'));
  assert.ok(html.includes('78'));
});

test('токен сохраняется в ссылках фильтров и действий', () => {
  const html = view.renderPage({ orders: [order], stats: { total: 1 }, health: {}, sources: [], params });
  const links = [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
  const filterLink = links.find((href) => href.includes('verdict=accept'));
  const actionLink = links.find((href) => href.includes('/leads/status'));

  assert.ok(filterLink && filterLink.includes('secret-token'), 'фильтр потерял токен');
  assert.ok(actionLink && actionLink.includes('secret-token'), 'действие потеряло токен');
});

test('у отклонённого нет кнопки «откликнулся», есть «Вернуть в разбор»', () => {
  const rejected = { ...order, verdict: 'reject', score: 0, reasons: [{ id: 'HF-01', text: 'Оплата за результат' }] };
  const html = view.renderPage({ orders: [rejected], stats: { total: 1 }, health: {}, sources: [], params });

  assert.ok(!html.includes('Отметить «откликнулся»'), 'у отклонённого есть кнопка отклика');
  assert.ok(html.includes('Вернуть в разбор'));
  assert.ok(html.includes('Оплата за результат'));
});

test('пустая лента объясняет состояние источника', () => {
  const html = view.renderPage({
    orders: [],
    stats: {},
    health: { lastAttemptAt: new Date(), lastSuccessAt: null, lastError: 'HTTP 503' },
    sources: [],
    params,
  });

  assert.ok(html.includes('Пока нет заказов'));
  assert.ok(html.includes('HTTP 503'));
  assert.ok(html.includes('Собрать сейчас'));
});

test('опасные символы в заголовке экранируются', () => {
  const html = view.renderPage({ orders: [{ ...order, title: '<script>alert(1)</script>' }], stats: {}, health: {}, sources: [], params });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('страница закрыта от индексации', () => {
  const html = view.renderPage({ orders: [], stats: {}, health: {}, sources: [], params });
  assert.ok(html.includes('noindex'));
});

test('источники показывают здоровье и ошибку', () => {
  const html = view.renderPage({
    orders: [],
    stats: {},
    health: { lastError: 'HTTP 503', down: true },
    sources: [{ name: 'FL.ru', url: 'fl.ru', method: 'RSS', freq: '20 мин', health: 'err', last: '5 мин назад', comment: 'сбой' }],
    params,
    tab: 'sources',
  });

  assert.ok(html.includes('FL.ru'));
  assert.ok(html.includes('Последний сбор не удался'));
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
  console.log(`leads-view: всего ${tests.length} | ✅ ${passed} | ❌ ${tests.length - passed}`);
  console.log('='.repeat(60));

  if (process.exitCode) process.exit(process.exitCode);
})();
