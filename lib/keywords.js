// lib/keywords.js
// Сбор и кластеризация семантики БЕЗ платных API и без Wordstat.
//
// ОТКУДА БЕРУТСЯ ДАННЫЕ (проверено живой выдачей с серверных IP):
//   1. Подсказки Яндекса  (suggest.yandex.net) — ближайшие бесплатные аналог
//      левого столбца Wordstat: народные формулировки и хвосты.
//   2. Подсказки Google   (suggestqueries.google.com, client=firefox) — JSON.
//   3. Подсказки DuckDuckGo (duckduckgo.com/ac) — третий независимый источник.
//   4. Алфавитная добыча: запрос «seed + буква» по русскому алфавиту вытаскивает
//      хвосты, которые не показываются на первой подсказке.
//   5. Первый-party данные (опционально, лучшие по качеству): Google Search
//      Console API и отчёт «поисковые фразы» Яндекс.Метрики дают РЕАЛЬНЫЕ
//      показы и клики по сайту. Подключаются отдельными токенами, см. README.
//
// ЧЕСТНО ПРО ЧАСТОТНОСТИ: реальных цифр Wordstat у нас нет и мы их НЕ выдумываем.
// Вместо этого — прокси-спрос: сколько раз формулировка встретилась независимо
// в разных источниках и на какой глубине подсказок. Метка high/medium/low
// всегда помечена как оценка, а не как частотность.

const { fetchJson } = require('./http');
const { config } = require('./config');
const { toStr } = require('./text');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** Буквы для алфавитной добычи хвостов. */
const ALPHABET = 'абвгдежзиклмнопрстуфхцчшщэюя'.split('');

/** Маркеры интентов для кластеризации. */
const INTENT_MARKERS = [
  ['commercial', /купить|заказать|цена|стоимость|прайс|недорого|дешев|скидк|акци/i],
  ['local', /москв|московск|спб|петербург|питер|екатеринбург|новосибирск|казан|нижн|краснодар|рядом|в городе|област/i],
  // \b в JS не работает с кириллицей, поэтому границы «или» задаём пробелами
  ['comparison', /(^|[\s,?!])или([\s,?!]|$)|\bvs\b|сравнени|лучше|отличи|разниц|аналог/i],
  ['reviews', /отзыв|рейтинг|обзор|мнени/i],
  ['info', /как|что такое|что это|это|почему|зачем|сколько|обучени|курс|гайд|инструкци|совет|пример|чек.?лист/i],
  ['navigation', /официальн|вход|скачать|личн|кабинет|поддержк|логин/i],
];

/**
 * Подсказки по неполному слову («сео аудит м») возвращают сросшиеся хвосты
 * вида «моссео» (= «мос» + «сео»). Такой токен содержит опорное слово
 * БЕЗ пробела и с огрызком спереди — это мусор, а не формулировка спроса.
 */
function isGluedToken(token, anchors) {
  for (const anchor of anchors) {
    if (anchor.length < 3) continue;
    if (token === anchor) continue;
    const position = token.indexOf(anchor);
    if (position > 0) {
      const remainder = token.slice(0, position);
      // огрызок спереди + целое опорное слово без пробела = склейка
      if (remainder.length >= 2) return true;
    }
  }
  return false;
}

function normalize(keyword) {
  return toStr(keyword)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Подсказки одного источника.
 * @returns {Promise<string[]>}
 */
async function fetchSource(name, query) {
  try {
    if (name === 'yandex') {
      const url = new URL(config.suggestYandexUrl);
      url.searchParams.set('part', query);
      url.searchParams.set('lr', String(config.yandexRegion));
      const { ok, data } = await fetchJson(url.toString(), { headers: { 'User-Agent': UA } }, { timeout: 8000 });
      if (!ok || !Array.isArray(data)) return [];
      return data.filter((item) => typeof item === 'string');
    }

    if (name === 'google') {
      const url = new URL(config.suggestGoogleUrl);
      url.searchParams.set('client', 'firefox');
      url.searchParams.set('hl', 'ru');
      url.searchParams.set('q', query);
      const { ok, data } = await fetchJson(url.toString(), { headers: { 'User-Agent': UA } }, { timeout: 8000 });
      if (!ok || !Array.isArray(data) || !Array.isArray(data[1])) return [];
      return data[1].filter((item) => typeof item === 'string');
    }

    if (name === 'duckduckgo') {
      const url = new URL(config.suggestDdgUrl);
      url.searchParams.set('q', query);
      url.searchParams.set('kl', 'ru-ru');
      const { ok, data } = await fetchJson(url.toString(), { headers: { 'User-Agent': UA } }, { timeout: 8000 });
      if (!ok || !Array.isArray(data)) return [];
      return data.map((item) => item?.phrase).filter((item) => typeof item === 'string');
    }
  } catch (error) {
    console.warn(`⚠️ Подсказки ${name} недоступны: ${error.message.slice(0, 120)}`);
  }

  return [];
}

/**
 * Подсказки по запросу из всех источников, с нормализацией и дедупликацией.
 * @returns {Promise<Map<string, {keyword:string, sources:Set<string>, hits:number}>>}
 */
async function fetchSuggestions(query, collector = new Map()) {
  const results = await Promise.all(
    ['yandex', 'google', 'duckduckgo'].map(async (source) => [source, await fetchSource(source, query)])
  );

  const anchors = normalize(query).split(' ').filter((token) => token.length >= 3);

  for (const [source, items] of results) {
    for (const item of items) {
      const keyword = normalize(item);
      if (!keyword || keyword === normalize(query)) continue;

      const tokens = keyword.split(' ');
      if (tokens.some((token) => isGluedToken(token, anchors))) continue;

      const entry = collector.get(keyword) || { keyword, sources: new Set(), hits: 0 };
      entry.sources.add(source);
      entry.hits++;
      collector.set(keyword, entry);
    }
  }

  return collector;
}

/**
 * Прокси-спрос: метка по числу независимых встреч.
 * Явно помечается как оценка — реальных частотностей Wordstat у нас нет.
 */
function demandLabel(entry) {
  const weight = entry.hits + entry.sources.size * 2;
  if (weight >= 7) return 'high';
  if (weight >= 4) return 'medium';
  return 'low';
}

function intentOf(keyword) {
  for (const [intent, marker] of INTENT_MARKERS) {
    if (marker.test(keyword)) return intent;
  }
  return 'general';
}

/**
 * Алфавитная добыча хвостов: «seed + буква» раскрывает ветки, которых нет
 * в первой подсказке. Ограничено бюджетом запросов из вежливости к источникам.
 */
async function mineAlphabet(seed, collector, budget) {
  for (const letter of ALPHABET) {
    if (budget.used >= budget.max) break;
    budget.used++;
    await fetchSuggestions(`${seed} ${letter}`, collector);
  }
  return collector;
}

/**
 * Углубление: берём самые «жирные» подсказки первого уровня и спрашиваем дальше.
 */
async function deepen(seed, collector, budget, { topN = 8 } = {}) {
  const ranked = [...collector.values()]
    .filter((entry) => entry.keyword.startsWith(normalize(seed)))
    .sort((a, b) => b.hits - a.hits)
    .slice(0, topN);

  for (const entry of ranked) {
    if (budget.used >= budget.max) break;
    budget.used++;
    await fetchSuggestions(entry.keyword, collector);
  }

  return collector;
}

/**
 * Полный сбор семантики по опорному запросу.
 *
 * @param {string} seed
 * @param {object} [options]
 * @param {string} [options.city] - гео-модификатор: добавляет ветки «seed + город»
 * @param {number} [options.maxQueries=60] - бюджет запросов к подсказкам
 * @param {boolean} [options.alphabet=true] - алфавитная добыча
 * @returns {Promise<object>} кластеры, метки спроса и сырой список
 */
async function research(seed, options = {}) {
  const normalizedSeed = normalize(seed);
  if (!normalizedSeed) {
    return { success: false, error: 'Не задан опорный запрос (seed).' };
  }

  const budget = { max: Math.min(Number(options.maxQueries) || 60, 150), used: 0 };
  const collector = new Map();

  // Уровень 0: сам опорный запрос во всех источниках
  budget.used++;
  await fetchSuggestions(normalizedSeed, collector);

  // Гео-ветки
  const city = normalize(options.city || '');
  if (city) {
    budget.used++;
    await fetchSuggestions(`${normalizedSeed} ${city}`, collector);
  }

  // Алфавитная добыча хвостов
  if (options.alphabet !== false) {
    await mineAlphabet(normalizedSeed, collector, budget);
  }

  // Углубление по жирным подсказкам
  await deepen(normalizedSeed, collector, budget);

  if (collector.size === 0) {
    return {
      success: false,
      seed: normalizedSeed,
      error:
        'Ни один источник подсказок не вернул данных. Проверьте доступность ' +
        'suggest.yandex.net, suggestqueries.google.com и duckduckgo.com с сервера.',
    };
  }

  // Кластеризация по интенту
  const clusters = {};
  for (const entry of collector.values()) {
    const intent = intentOf(entry.keyword);
    if (!clusters[intent]) clusters[intent] = [];

    clusters[intent].push({
      keyword: entry.keyword,
      demand: demandLabel(entry),
      sources: [...entry.sources],
      hits: entry.hits,
    });
  }

  for (const intent of Object.keys(clusters)) {
    clusters[intent].sort((a, b) => b.hits - a.hits);
  }

  const sorted = [...collector.values()].sort((a, b) => b.hits - a.hits);

  return {
    success: true,
    seed: normalizedSeed,
    city: city || null,
    queriesUsed: budget.used,
    collected: collector.size,
    clusters,
    clusterSizes: Object.fromEntries(Object.entries(clusters).map(([intent, items]) => [intent, items.length])),
    top: sorted.slice(0, 30).map((entry) => ({
      keyword: entry.keyword,
      demand: demandLabel(entry),
      sources: [...entry.sources],
      hits: entry.hits,
    })),
    note:
      'demand — прокси-спрос по числу независимых встреч в подсказках, а не частотность Wordstat. ' +
      'Реальные показы даёт только Search Console / Метрика (подключаются отдельно).',
  };
}

module.exports = {
  research,
  fetchSuggestions,
  fetchSource,
  normalize,
  demandLabel,
  intentOf,
  INTENT_MARKERS,
  ALPHABET,
};
