// lib/kwork-filter.js
// Отбор заказов Kwork по заголовку письма.
//
// Почему по заголовку: Kwork присылает в письме только название заказа и ссылку,
// а полное описание открывается лишь под аккаунтом. Значит парсить карточку
// нельзя, и правило «подходит / не подходит» строится на названии.
// Заказы без явных признаков не отбрасываем молча: они уходят в «спорные»,
// чтобы владелец сам посмотрел — лучше лишний раз показать, чем пропустить.

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_FILTERS = path.join(__dirname, '..', 'config', 'kwork-filters.json');

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

function loadFilters(file = DEFAULT_FILTERS) {
  const filters = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(filters.include) || !Array.isArray(filters.hardExclude)) {
    throw new Error('Неверный формат критериев: нужны include[] и hardExclude[]');
  }
  return filters;
}

/**
 * Проверяет заголовок заказа по критериям.
 * @returns {{verdict: 'accept'|'reject'|'unknown', labels: string[], reason: string|null, title: string}}
 */
function classify(title, filters) {
  const rules = filters || loadFilters();
  const text = normalize(title);

  const excluded = (rules.hardExclude || []).find((rule) => text.includes(normalize(rule.pattern)));
  if (excluded) {
    return { verdict: 'reject', labels: [], reason: excluded.reason, title: String(title || '') };
  }

  const labels = (rules.include || [])
    .filter((rule) => text.includes(normalize(rule.pattern)))
    .map((rule) => rule.label || rule.pattern);

  const unique = [...new Set(labels)];
  if (unique.length > 0) {
    return { verdict: 'accept', labels: unique, reason: null, title: String(title || '') };
  }

  const weak = (rules.weakInclude || [])
    .filter((rule) => text.includes(normalize(rule.pattern)))
    .map((rule) => rule.label || rule.pattern);

  return {
    verdict: 'unknown',
    labels: [...new Set(weak)],
    reason: 'нет явных признаков SEO-заказа',
    title: String(title || ''),
  };
}

/** Группирует пачку заголовков на три корзины. */
function classifyMany(titles, filters) {
  const result = { accept: [], unknown: [], reject: [] };
  for (const title of titles) {
    const item = classify(title, filters);
    result[item.verdict].push(item);
  }
  return result;
}

module.exports = { normalize, loadFilters, classify, classifyMany, DEFAULT_FILTERS };
