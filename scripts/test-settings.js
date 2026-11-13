#!/usr/bin/env node
/**
 * scripts/test-settings.js
 * Тесты нормализации настроек (без базы).
 */

'use strict';

const assert = require('assert');
const settings = require('../lib/settings');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('значения по умолчанию на месте', () => {
  assert.strictEqual(settings.DEFAULTS.hotScore, 80);
  assert.strictEqual(settings.DEFAULTS.followUpDays, 3);
  assert.strictEqual(settings.DEFAULTS.sourceDownHours, 6);
});

test('числа парсятся и ограничиваются сверху', () => {
  const result = settings.normalize({ hotScore: '95', followUpDays: '999', sourceDownHours: '0' });
  assert.strictEqual(result.hotScore, 95);
  assert.strictEqual(result.followUpDays, 60, 'должно ограничиться 60');
  assert.strictEqual(result.sourceDownHours, 1, 'должно ограничиться 1');
});

test('мусор и пустые значения игнорируются', () => {
  const result = settings.normalize({ hotScore: 'abc', hotAgeHours: '', followUpDays: null });
  assert.deepStrictEqual(result, {});
});

test('дробные значения округляются', () => {
  assert.strictEqual(settings.normalize({ hotAgeHours: '2.6' }).hotAgeHours, 3);
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
  console.log(`settings: всего ${tests.length} | ✅ ${passed} | ❌ ${tests.length - passed}`);
  console.log('='.repeat(60));

  if (process.exitCode) process.exit(process.exitCode);
})();
