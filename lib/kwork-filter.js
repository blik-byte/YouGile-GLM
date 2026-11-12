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
  const hasInclude = Array.isArray(filters.include) || Array.isArray(filters.strongInclude);
  if (!hasInclude || !Array.isArray(filters.hardExclude)) {
    throw new Error('Неверный формат критериев: нужны hardExclude[] и include[] (или strongInclude[])');
  }
  return filters;
}

/**
 * Проверяет заказ по критериям.
 * Логика: SEO-термины (strongInclude) решают сами; общие слова (contextInclude)
 * вроде «аудит» и «оптимизация» считаются только рядом со словом про сайт.
 * Иначе «аудит бухгалтерии» или «консультация юриста» попадали в подходящие.
 * @returns {{verdict: 'accept'|'reject'|'unknown', labels: string[], reason: string|null, title: string}}
 */
function classify(title, filters) {
  const rules = filters || loadFilters();
  const text = normalize(title);

  const excluded = (rules.hardExclude || []).find((rule) => text.includes(normalize(rule.pattern)));
  if (excluded) {
    return { verdict: 'reject', labels: [], reason: excluded.reason, title: String(title || '') };
  }

  const strong = (rules.strongInclude || [])
    .filter((rule) => text.includes(normalize(rule.pattern)))
    .map((rule) => rule.label || rule.pattern);

  if (strong.length > 0) {
    return { verdict: 'accept', labels: [...new Set(strong)], reason: null, title: String(title || '') };
  }

  const hasContext = (rules.contextWords || []).some((word) => text.includes(normalize(word)));
  const context = (rules.contextInclude || [])
    .filter((rule) => text.includes(normalize(rule.pattern)))
    .map((rule) => rule.label || rule.pattern);

  if (context.length > 0 && hasContext) {
    return { verdict: 'accept', labels: [...new Set(context)], reason: null, title: String(title || '') };
  }

  const weak = (rules.weakInclude || [])
    .filter((rule) => text.includes(normalize(rule.pattern)))
    .map((rule) => rule.label || rule.pattern);

  return {
    verdict: 'unknown',
    labels: [...new Set(weak)],
    reason: context.length > 0 ? 'слово из SEO-темы без привязки к сайту' : 'нет явных признаков SEO-заказа',
    title: String(title || ''),
  };
}

/**
 * Проверка заказа с разделением контекста.
 * Исключения ищем во всём тексте (включая описание): если в заказе написано
 * «оплата за результат» или «по России» — это видно и в теле.
 * «Подходит» решаем только по заголовку и категории: в длинном описании SEO-слова
 * встречаются случайно («сайт», «оптимизация»), и по ним в ленту попадал мусор.
 */
function classifyOrder({ title = '', category = '', description = '' }, filters) {
  const rules = filters || loadFilters();
  const all = normalize(`${title} ${category} ${description}`);

  const excluded = (rules.hardExclude || []).find((rule) => all.includes(normalize(rule.pattern)));
  if (excluded) {
    return { verdict: 'reject', labels: [], reason: excluded.reason, title: String(title || '') };
  }

  // Главное решают слова в заголовке: рубрика на площадке слишком широкая
  // («Продвижение сайтов (SEO) / Управление репутацией» — это тоже про отзывы).
  const head = normalize(title);
  const strong = (rules.strongInclude || [])
    .filter((rule) => head.includes(normalize(rule.pattern)))
    .map((rule) => rule.label || rule.pattern);
  if (strong.length > 0) {
    return { verdict: 'accept', labels: [...new Set(strong)], reason: null, title: String(title || '') };
  }

  const context = (rules.contextInclude || [])
    .filter((rule) => head.includes(normalize(rule.pattern)))
    .map((rule) => rule.label || rule.pattern);
  const hasContext = (rules.contextWords || []).some((word) => head.includes(normalize(word)));
  if (context.length > 0 && hasContext) {
    return { verdict: 'accept', labels: [...new Set(context)], reason: null, title: String(title || '') };
  }

  const weak = (rules.weakInclude || [])
    .filter((rule) => head.includes(normalize(rule.pattern)))
    .map((rule) => rule.label || rule.pattern);

  return {
    verdict: 'unknown',
    labels: [...new Set(weak)],
    reason: context.length > 0 ? 'слово из SEO-темы без привязки к сайту' : 'в заголовке нет SEO-признаков',
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

module.exports = { normalize, loadFilters, classify, classifyOrder, classifyMany, DEFAULT_FILTERS };
