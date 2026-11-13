// lib/rules.js
// Движок правил по машиночитаемым файлам дизайнера.
//
// Источник истины: config/rules/v1.0.0.json (база) и v1.1.0.json (дельта).
// Загрузчик собирает «эффективные» правила: база + добавки + версия 1.1.0.
// Так сохраняется история изменений и выполняется требование ТЗ «единая
// эффективная версия во всех местах интерфейса».
//
// Контракт: score = сумма весов × норм (0..100), причина у каждого решения
// имеет id HF-xx или FL-xx, вердикт — по порогу suitable_threshold.

'use strict';

const fs = require('fs');
const path = require('path');

const RULES_DIR = path.join(__dirname, '..', 'config', 'rules');
const BASE_FILE = path.join(RULES_DIR, 'v1.0.0.json');
const DELTA_FILE = path.join(RULES_DIR, 'v1.1.0.json');
const PROFILE_FILE = path.join(RULES_DIR, 'profile.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

/**
 * Эффективные правила: база + дельта.
 * @returns {object} rules
 */
function loadRules({ baseFile = BASE_FILE, deltaFile = DELTA_FILE, profileFile = PROFILE_FILE } = {}) {
  const base = readJson(baseFile);
  const delta = readJson(deltaFile);
  const profile = fs.existsSync(profileFile) ? readJson(profileFile) : { blocked_categories: [], min_service_norm: 0.5 };

  const changelog = [
    ...(base.meta.changelog || []),
    ...((delta.meta && delta.meta.changelog) || []),
  ];

  const hardFilters = [...(base.hard_filters || []), ...(delta.hard_filters_add || [])];
  const flags = [...(base.flags || []), ...(delta.flags_add || [])];

  return {
    ...base,
    meta: {
      ...base.meta,
      rules_version: delta.meta.rules_version,
      updated: delta.meta.updated || base.meta.updated,
      changelog,
      version_chain: ['1.0.0', delta.meta.rules_version],
    },
    hard_filters: hardFilters,
    flags,
    profile,
    client_schema: delta.client_schema || null,
    delta,
  };
}

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

function hitAny(text, words) {
  for (const word of words || []) {
    const needle = normalize(word);
    if (!needle) continue;
    if (text.includes(needle)) return word;

    // Простое склонение только для одиночных слов: «Украина» → «Украине».
    // Для фраз вроде «контекстная реклама» обрезание дало бы ложные срабатывания
    // («конте» ловит «контент»).
    const isPhrase = needle.includes(' ');
    if (!isPhrase && needle.length >= 6 && text.includes(needle.slice(0, 5))) return word;
  }
  return null;
}

/** Часы с момента публикации; неизвестная дата считается старой. */
function ageHours(publishedAt) {
  if (!publishedAt) return 96;
  const time = new Date(publishedAt).getTime();
  if (!Number.isFinite(time)) return 96;
  return Math.max(0, (Date.now() - time) / 3600000);
}

/** Норма свежести по таблице factor. */
function freshnessFactor(hours) {
  if (hours <= 2) return 1.0;
  if (hours <= 6) return 0.85;
  if (hours <= 24) return 0.6;
  if (hours <= 48) return 0.35;
  return 0.15;
}

/** Норма бюджета по полосам с учётом типа: разовый, месячный, «от». */
function budgetNorm(order, weights) {
  const value = Number(order.budgetValue) || 0;
  if (!value) return 0.3;

  const kind = order.budgetKind || 'fixed';
  const bands = kind === 'monthly' ? weights.bands_monthly : weights.bands_fixed;

  let norm = 0.2;
  for (const [band, point] of Object.entries(bands)) {
    const value_ = Number(String(band).replace(/[<>]/g, '').trim());
    let from = 0;
    let to = Infinity;

    if (String(band).startsWith('<')) {
      to = value_;
    } else if (String(band).startsWith('>')) {
      from = value_;
    } else {
      const [rawFrom, rawTo] = String(band).split('-');
      from = Number(rawFrom) || 0;
      to = rawTo === undefined ? Infinity : Number(rawTo) || Infinity;
    }

    if (value >= from && value < to) {
      norm = point;
      break;
    }
  }

  if (kind === 'from') norm *= Number(weights.from_prefix_confidence) || 0.8;
  return norm;
}

/** Норма конкуренции по числу откликов. */
function competitionNorm(responses) {
  if (responses === undefined || responses === null || Number.isNaN(Number(responses))) return 0.5;
  const count = Number(responses);
  if (count <= 5) return 1.0;
  if (count <= 15) return 0.7;
  if (count <= 30) return 0.4;
  return 0.15;
}

/** Норма заказчика: рейтинг СБ. Неизвестно — нейтрально 0.5. */
function clientNorm(client) {
  const rating = Number(client && client.rating);
  if (!rating) return 0.5;
  if (rating >= 4.5) return 1.0;
  if (rating >= 4) return 0.8;
  if (rating >= 3) return 0.5;
  return 0.2;
}

/**
 * Тип услуги по тексту: whitelist / employment / subcontract / other_seo / adjacent_other.
 * Порядок важен: «в штат» и «субподряд» сильнее общих слов про SEO.
 */
function serviceType(text, rules) {
  if (/в штат|в команду|ставка|вакансия/.test(text)) return 'employment';
  if (/субподряд|для агентства|партнер|партнёр/.test(text)) return 'subcontract';

  const whitelistHits = ['аудит', 'продвижен', 'seo', 'семантик', 'ссыл', 'юзабилити', 'консультац', 'оптимизац']
    .filter((word) => text.includes(word));
  if (whitelistHits.length) return 'whitelist';

  if (text.includes('seo')) return 'other_seo';
  return 'adjacent_other';
}

/** Норма ясности: сколько из трёх (сайт, задача, бюджет) есть в заказе. */
function clarityNorm(order) {
  const text = normalize(`${order.title} ${order.description || ''}`);
  const hasSite = /сайт|интернет-магазин|лендинг|домен|https?:\/\//.test(text);
  const hasTask = String(order.description || '').trim().length >= 80;
  const hasBudget = Number(order.budgetValue) > 0;

  const count = [hasSite, hasTask, hasBudget].filter(Boolean).length;
  if (count === 3) return 1.0;
  if (count === 2) return 0.6;
  if (count === 1) return 0.3;
  return 0.1;
}

/**
 * Оценка заказа.
 * @returns {{
 *   score:number, priority:number, verdict:'accept'|'unknown'|'reject',
 *   reasons:Array<{id:string,name:string,text:string}>,
 *   components:Object, rulesVersion:string, serviceType:string
 * }}
 */
function scoreOrder(order, rules) {
  const config = rules || loadRules();
  const text = normalize(`${order.title} ${order.category || ''} ${order.description || ''}`);
  const reasons = [];

  // 1. Жёсткие фильтры
  for (const filter of config.hard_filters) {
    if (filter.keywords) {
      const hit = hitAny(text, filter.keywords);
      if (hit) reasons.push({ id: filter.id, name: filter.name, text: `${filter.reason}: «${hit}»` });
      continue;
    }

    if (filter.id === 'HF-03') {
      const hit = hitAny(text, filter.reject_examples);
      if (hit) reasons.push({ id: filter.id, name: filter.name, text: `${filter.reason}: «${hit}»` });
      continue;
    }

    if (filter.id === 'HF-04') {
      const hit = hitAny(text, ['англ', 'немец', 'француз', 'испан', 'english', 'deutsch']);
      if (hit) reasons.push({ id: filter.id, name: filter.name, text: `${filter.reason}: «${hit}»` });
    }
  }

  // Тип услуги определяем по заголовку и категории, без описания:
  // в длинном тексте слово «SEO» встречается случайно (например, «нужен PHP-разработчик,
  // сайт продвигаем сами»).
  const head = normalize(`${order.title} ${order.category || ''}`);
  const service = serviceType(head, config);

  // Профиль владельца: чужие категории отсекаем до весов,
  // иначе «рассылка писем» или «Blur wheel» набирают балл свежестью и ясностью.
  const profile = config.profile || { blocked_categories: [], min_service_norm: 0.5 };
  const category = normalize(order.category || '');
  const blockedCategory = (profile.blocked_categories || []).find((item) => category.includes(normalize(item)));

  if (blockedCategory) {
    reasons.push({
      id: 'HF-07',
      name: 'out_of_profile',
      text: `вне профиля: категория «${blockedCategory}»`,
    });
  }

  const serviceNorm =
    config.weights.service_match.norm[service] !== undefined ? config.weights.service_match.norm[service] : 0.3;

  if (serviceNorm < (profile.min_service_norm || 0.5)) {
    reasons.push({
      id: 'HF-07',
      name: 'out_of_profile',
      text: 'вне профиля: в заказе нет признаков SEO-услуги',
    });
  }

  if (reasons.length > 0) {
    return {
      score: 0,
      priority: 0,
      verdict: 'reject',
      reasons,
      components: {},
      rulesVersion: config.meta.rules_version,
      serviceType: service,
    };
  }

  // 2. Флаги
  for (const flag of config.flags) {
    if (flag.keywords) {
      const hit = hitAny(text, flag.keywords);
      if (hit) reasons.push({ id: flag.id, name: flag.name, text: `${flag.reason}: «${hit}»` });
    }
  }

  if (String(order.description || '').trim().length < 20) {
    const noDescription = config.flags.find((flag) => flag.id === 'FL-08');
    if (noDescription) {
      reasons.push({ id: noDescription.id, name: noDescription.name, text: noDescription.reason });
    }
  }

  // 3. Компоненты
  const weights = config.weights;
  const hours = ageHours(order.publishedAt);
  const fresh = freshnessFactor(hours);
  const budget = budgetNorm(order, weights.budget);

  const components = {
    service_match: {
      weight: weights.service_match.weight,
      value: weights.service_match.norm[service] !== undefined ? weights.service_match.norm[service] : 0.3,
      note: `тип услуги: ${service}`,
    },
    budget: {
      weight: weights.budget.weight,
      value: budget,
      note: Number(order.budgetValue) ? `${Math.round(order.budgetValue).toLocaleString('ru-RU')} ₽ (${order.budgetKind || 'fixed'})` : 'бюджет не указан',
    },
    freshness: {
      weight: weights.freshness.weight,
      value: fresh,
      note: hours < 1 ? 'меньше часа' : `${Math.round(hours)} ч назад`,
    },
    competition: {
      weight: weights.competition.weight,
      value: competitionNorm(order.responses),
      note: order.responses === undefined ? 'отклики неизвестны' : `${order.responses} откликов`,
    },
    client_quality: {
      weight: weights.client_quality.weight,
      value: clientNorm(order.client),
      note: order.client && order.client.rating ? `рейтинг ${order.client.rating}` : 'рейтинг неизвестен',
    },
    engagement: {
      weight: weights.engagement.weight,
      value: weights.engagement.norm[order.employment || (service === 'employment' ? 'employment' : 'one_time')] || 0.6,
      note: `занятость: ${order.employment || 'one_time'}`,
    },
    clarity: {
      weight: weights.clarity.weight,
      value: clarityNorm(order),
      note: 'сайт, задача, бюджет — сколько есть',
    },
  };

  let total = 0;
  for (const part of Object.values(components)) {
    part.points = Math.round(part.weight * part.value * 100) / 100;
    total += part.points;
  }

  const score = Math.round(total);
  const threshold = Number(config.meta.suitable_threshold) || 60;

  let verdict = 'accept';
  if (reasons.length > 0 || score < threshold) {
    verdict = 'unknown';
    if (score < threshold) {
      const low = config.flags.find((flag) => flag.id === 'FL-07');
      reasons.push({
        id: low ? low.id : 'FL-07',
        name: low ? low.name : 'low_score',
        text: `балл ${score} ниже порога ${threshold}`,
      });
    }
  }

  // Приоритет из meta: score * свежесть * (0.7 + 0.3 * бюджет)
  const priority = Math.round(score * fresh * (0.7 + 0.3 * budget));

  return {
    score,
    priority,
    verdict,
    reasons,
    components,
    rulesVersion: config.meta.rules_version,
    serviceType: service,
  };
}

module.exports = {
  loadRules,
  scoreOrder,
  serviceType,
  ageHours,
  freshnessFactor,
  budgetNorm,
  competitionNorm,
  clientNorm,
  clarityNorm,
  normalize,
};
