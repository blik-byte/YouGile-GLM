// lib/rules.js
// Движок правил: заказ → балл, компоненты, вердикт, причины.
//
// Контракт из ТЗ: сумма компонентов равна баллу, вердикт выводится порогом,
// у каждого решения есть reasons[] с id (HF-xx / FL-xx). Всё это уходит в
// таблицу order_scores вместе с версией правил, чтобы пересчёт был проверяемым.

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_RULES = path.join(__dirname, '..', 'config', 'rules-v1.1.0.json');

function loadRules(file = DEFAULT_RULES) {
  const rules = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!rules.weights || !Array.isArray(rules.hard_filters)) {
    throw new Error('Неверный формат правил: нужны weights и hard_filters');
  }
  return rules;
}

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Границы нормализации компонентов 0..1. */
const COMPONENT_BOUNDS = {
  budget: [0, 100000],
  freshness: [0, 72], // часы; 0 — только что, 72 — трое суток и старше
  competition: [0, 30], // отклики
  client: [0, 5], // рейтинг
};

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function scale(value, [min, max]) {
  if (!Number.isFinite(value)) return 0;
  if (max === min) return 0;
  return clamp01((value - min) / (max - min));
}

/** Часы с момента публикации. */
function ageHours(publishedAt) {
  if (!publishedAt) return 96;
  const time = new Date(publishedAt).getTime();
  if (!Number.isFinite(time)) return 96;
  return Math.max(0, (Date.now() - time) / 3600000);
}

/** Компоненты 0..1 с пояснениями: что и почему дало столько. */
function computeComponents(order) {
  const text = normalize(`${order.title} ${order.category || ''} ${order.description || ''}`);
  const whitelistHits = ['аудит', 'продвижен', 'seo', 'ссыл', 'семантик', 'юзабилити', 'оптимизац', 'консультац']
    .filter((word) => text.includes(word));

  const budget = Number(order.budgetValue) || 0;
  const hours = ageHours(order.publishedAt);
  const responses = Number(order.responses) || 0;
  const rating = Number(order.client && order.client.rating) || 0;
  const hasDescription = String(order.description || '').trim().length >= 80;
  const employment = order.employment || 'one_time';

  return {
    service: {
      value: whitelistHits.length ? 1 : 0,
      note: whitelistHits.length ? `совпадение: ${whitelistHits.slice(0, 3).join(', ')}` : 'нет совпадений с whitelist',
    },
    budget: {
      value: scale(budget, COMPONENT_BOUNDS.budget),
      note: budget ? `${Math.round(budget).toLocaleString('ru-RU')} ₽` : 'бюджет не указан',
    },
    freshness: {
      value: 1 - scale(hours, COMPONENT_BOUNDS.freshness),
      note: hours < 1 ? 'меньше часа' : `${Math.round(hours)} ч назад`,
    },
    competition: {
      value: 1 - scale(responses, COMPONENT_BOUNDS.competition),
      note: responses ? `${responses} откликов` : 'откликов нет',
    },
    client: {
      value: rating ? scale(rating, COMPONENT_BOUNDS.client) : 0.5,
      note: rating ? `рейтинг ${rating}` : 'рейтинг неизвестен',
    },
    engagement: {
      value: employment === 'recurring' || employment === 'employment' ? 1 : 0.6,
      note: employment === 'recurring' ? 'постоянная работа' : employment === 'employment' ? 'в штат' : 'разовая',
    },
    clarity: {
      value: hasDescription ? 1 : 0,
      note: hasDescription ? 'описание достаточное' : 'описание короткое или отсутствует',
    },
  };
}

/**
 * Оценка заказа.
 * @returns {{score:number, verdict:'accept'|'unknown'|'reject', reasons:Array, components:Object, rulesVersion:string}}
 */
function scoreOrder(order, rules) {
  const config = rules || loadRules();
  const text = normalize(`${order.title} ${order.category || ''} ${order.description || ''}`);

  const reasons = [];

  for (const filter of config.hard_filters) {
    const hit = (filter.patterns || []).find((pattern) => text.includes(normalize(pattern)));
    if (hit) {
      reasons.push({ id: filter.id, name: filter.name, text: `${filter.name}: «${hit}»` });
    }
  }

  if (reasons.length > 0) {
    return {
      score: 0,
      verdict: 'reject',
      reasons,
      components: {},
      rulesVersion: config.version,
    };
  }

  for (const flag of config.flags || []) {
    if (!flag.patterns || flag.patterns.length === 0) continue;
    const hit = flag.patterns.find((pattern) => text.includes(normalize(pattern)));
    if (hit) reasons.push({ id: flag.id, name: flag.name, text: `${flag.name}: «${hit}»` });
  }

  if (String(order.description || '').trim().length < 20) {
    const emptyFlag = (config.flags || []).find((flag) => flag.id === 'FL-08');
    if (emptyFlag) reasons.push({ id: emptyFlag.id, name: emptyFlag.name, text: emptyFlag.name });
  }

  const components = computeComponents(order);

  // Баллы по компонентам: вес × норма 0..1. Сумма баллов и есть итоговый балл —
  // так требует контракт order_scores (сумма компонентов = балл).
  let total = 0;
  for (const [key, part] of Object.entries(components)) {
    const weight = config.weights[key] || 0;
    part.weight = weight;
    part.points = Math.round(weight * part.value * 100) / 100;
    total += part.points;
  }

  const score = Math.round(total);

  const threshold = Number(config.threshold) || 60;
  let verdict = 'accept';

  if (score < threshold) {
    verdict = 'unknown';
    const low = (config.flags || []).find((flag) => flag.id === 'FL-07');
    reasons.push({
      id: low ? low.id : 'FL-07',
      name: low ? low.name : 'Балл ниже порога',
      text: `балл ${score} ниже порога ${threshold}`,
    });
  }

  if (reasons.length > 0) verdict = 'unknown';

  return { score, verdict, reasons, components, rulesVersion: config.version };
}

module.exports = { loadRules, scoreOrder, computeComponents, ageHours, normalize };
