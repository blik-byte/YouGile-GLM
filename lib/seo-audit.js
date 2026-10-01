// lib/seo-audit.js
// Механический SEO-аудит страницы.
//
// Принцип разделения труда: всё, что можно проверить детерминированно
// (длины title/description, наличие canonical, типы schema.org, alt у картинок,
// наличие llms.txt и sitemap), проверяет КОД. Модель получает готовый отчёт
// с фактами и интерпретирует его вместе с чек-листами из prompts/checklists —
// вместо того чтобы «смотреть» страницу глазами и выдумывать метатеги.
//
// Категории и веса рубрики скоринга согласованы с методологией claude-seo v1.4.0
// (Technical 22%, Content 23%, AI Search 10%); остальные веса распределены
// по остальным группам проверок и в сумме дают 100.

const { fetchWithTimeout } = require('./http');
const { toStr } = require('./text');

const WEIGHTS = {
  technical: 22,
  content: 23,
  aiSearch: 10,
  structure: 15,
  schema: 12,
  linking: 10,
  performance: 8,
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** Пороги, вокруг которых строятся проверки. */
const LIMITS = {
  titleMin: 30,
  titleMax: 60,
  descriptionMin: 70,
  descriptionMax: 160,
  wordsMin: 300,
  maxRedirects: 2,
  maxPageKb: 1500,
  imagesAltWarnRatio: 0.5,
};

function finding(severity, category, check, value, recommendation) {
  return { severity, category, check, value, recommendation };
}

/** Разбор <head> без полноценного DOM-парсера — для аудита этого достаточно. */
function parseHead(html) {
  const headMatch = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  const head = headMatch ? headMatch[1] : html.slice(0, 20000);

  const attr = (tag, name) => {
    const match = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i'));
    return match ? match[1] : null;
  };

  const collect = (tagName) => {
    const re = new RegExp(`<${tagName}[^>]*>`, 'gi');
    const out = [];
    let match;
    while ((match = re.exec(head)) !== null) out.push(match[0]);
    return out;
  };

  const metas = collect('meta');
  const metaBy = (predicate) => {
    const tag = metas.find(predicate);
    return tag ? attr(tag, 'content') : null;
  };

  const titleTag = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);

  const jsonLd = [];
  const ldRe = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let ldMatch;
  while ((ldMatch = ldRe.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(ldMatch[1]);
      jsonLd.push(parsed);
    } catch {
      jsonLd.push({ __broken: true });
    }
  }

  return {
    title: titleTag ? titleTag[1].replace(/\s+/g, ' ').trim() : null,
    description: metaBy((t) => (attr(t, 'name') || '').toLowerCase() === 'description'),
    robots: metaBy((t) => (attr(t, 'name') || '').toLowerCase() === 'robots'),
    canonical: (() => {
      const tag = collect('link').find((t) => (attr(t, 'rel') || '').toLowerCase() === 'canonical');
      return tag ? attr(tag, 'href') : null;
    })(),
    viewport: metaBy((t) => (attr(t, 'name') || '').toLowerCase() === 'viewport'),
    ogTitle: metaBy((t) => (attr(t, 'property') || '').toLowerCase() === 'og:title'),
    ogImage: metaBy((t) => (attr(t, 'property') || '').toLowerCase() === 'og:image'),
    twitterCard: metaBy((t) => (attr(t, 'name') || '').toLowerCase() === 'twitter:card'),
    lang: (() => {
      const htmlTag = html.match(/<html[^>]*\slang\s*=\s*["']([^"']+)["']/i);
      return htmlTag ? htmlTag[1] : null;
    })(),
    jsonLd,
  };
}

function schemaTypes(jsonLd) {
  const types = new Set();

  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    const type = node['@type'];
    if (typeof type === 'string') types.add(type);
    if (Array.isArray(type)) type.forEach((t) => types.add(t));
    // Graph-обёртки
    if (node['@graph']) walk(node['@graph']);
  };

  jsonLd.forEach((node) => {
    if (node && node.__broken) return;
    walk(node);
  });

  return [...types];
}

function parseBody(html) {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : html;

  const count = (re) => (body.match(re) || []).length;

  const headings = {};
  for (let level = 1; level <= 6; level++) {
    headings[`h${level}`] = count(new RegExp(`<h${level}[\\s>]`, 'gi'));
  }

  const images = [...body.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const imagesWithAlt = images.filter((tag) => /alt\s*=\s*["'][^"']+["']/i.test(tag)).length;

  const internalLinks = [...body.matchAll(/<a\b[^>]*href\s*=\s*["'](\/[^"'#]*)["']/gi)].length;
  const externalLinks = [...body.matchAll(/<a\b[^>]*href\s*=\s*["']https?:\/\/[^"']+["']/gi)].length;

  const textOnly = body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    headings,
    imagesTotal: images.length,
    imagesWithAlt,
    internalLinks,
    externalLinks,
    wordCount: textOnly ? textOnly.split(' ').length : 0,
    textLength: textOnly.length,
    hasForm: /<form[\s>]/i.test(body),
    hasNav: /<nav[\s>]/i.test(body),
  };
}

/**
 * Проверка вспомогательных файлов домена: robots.txt, sitemap.xml, llms.txt.
 * @returns {Promise<object>}
 */
async function probeDomainFiles(origin) {
  const result = {};

  for (const file of ['robots.txt', 'sitemap.xml', 'llms.txt']) {
    try {
      const response = await fetchWithTimeout(`${origin}/${file}`, { headers: { 'User-Agent': UA } }, { timeout: 10000 });
      const text = response.ok ? await response.text() : '';
      result[file] = {
        status: response.status,
        ok: response.ok && text.trim().length > 0,
        size: text.length,
      };
    } catch {
      result[file] = { status: 0, ok: false, size: 0 };
    }
  }

  return result;
}

/**
 * Полный механический аудит страницы.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {boolean} [options.probeDomain=true] - проверять robots/sitemap/llms.txt
 * @returns {Promise<object>} отчёт с находками по категориям и скорингом
 */
async function auditPage(url, options = {}) {
  const target = toStr(url).trim();
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return { success: false, error: `Некорректный URL: ${target}` };
  }

  if (!/^https?:$/.test(parsed.protocol)) {
    return { success: false, error: `Поддерживаются только http(s): ${parsed.protocol}` };
  }

  const findings = [];
  const startedAt = Date.now();

  // Замер цепочки редиректов: redirect: 'manual' не поддерживается везде одинаково,
  // поэтому считаем через fetch с redirect:'follow' и сравниваем итоговый URL
  let response;
  let finalUrl = parsed.href;
  let redirectHops = 0;

  try {
    response = await fetchWithTimeout(
      parsed.href,
      { headers: { 'User-Agent': UA, 'Accept-Language': 'ru,en;q=0.8' }, redirect: 'follow' },
      { timeout: 30000 }
    );
    finalUrl = response.url || parsed.href;
    redirectHops = finalUrl !== parsed.href ? 1 : 0; // точное число ходов fetch не отдаёт
  } catch (error) {
    return { success: false, url: target, error: `Страница недоступна: ${error.message}` };
  }

  if (!response.ok) {
    return { success: false, url: target, error: `Сервер вернул ${response.status}` };
  }

  const html = await response.text();
  const head = parseHead(html);
  const body = parseBody(html);
  const types = schemaTypes(head.jsonLd);
  const brokenLd = head.jsonLd.some((node) => node && node.__broken);

  /* ---------------- Technical ---------------- */

  if (response.status >= 300 && response.status < 400) {
    findings.push(finding('error', 'technical', 'status', response.status, 'Страница отдаёт редирект как итоговый ответ'));
  }

  if (redirectHops > LIMITS.maxRedirects) {
    findings.push(finding('warn', 'technical', 'redirects', redirectHops, 'Убрать лишние hops редиректов'));
  }

  // Локальные и служебные хосты не обязаны иметь https: аудит staging-копии
  // или мок-сервера не должен кричать про сертификат
  const isLoopback = /^(localhost$|127\.|::1$|\[::1\]$)|\.local$/i.test(parsed.hostname);

  if (parsed.protocol === 'http:' && !isLoopback) {
    findings.push(finding('error', 'technical', 'https', 'http', 'Перевести сайт на https'));
  }

  if (!head.canonical) {
    findings.push(finding('warn', 'technical', 'canonical', null, 'Добавить <link rel="canonical">'));
  } else if (head.canonical !== finalUrl) {
    findings.push(
      finding('info', 'technical', 'canonical-mismatch', head.canonical, 'Проверить, что canonical указывает на итоговый URL без параметров')
    );
  }

  if (head.robots && /noindex/i.test(head.robots)) {
    findings.push(finding('error', 'technical', 'robots-meta', head.robots, 'Страница закрыта от индексации — проверить, осознанно ли'));
  }

  /* ---------------- Structure ---------------- */

  if (!head.title) {
    findings.push(finding('error', 'structure', 'title-missing', null, 'Добавить <title>'));
  } else {
    const length = head.title.length;
    if (length < LIMITS.titleMin) {
      findings.push(finding('warn', 'structure', 'title-short', `${length} симв.`, `Довести title до ${LIMITS.titleMin}-${LIMITS.titleMax} символов`));
    } else if (length > LIMITS.titleMax) {
      findings.push(finding('warn', 'structure', 'title-long', `${length} симв.`, `Сократить title до ${LIMITS.titleMax} символов — хвост обрежется в выдаче`));
    }
  }

  if (!head.description) {
    findings.push(finding('warn', 'structure', 'description-missing', null, 'Добавить meta description'));
  } else {
    const length = head.description.length;
    if (length < LIMITS.descriptionMin || length > LIMITS.descriptionMax) {
      findings.push(
        finding('warn', 'structure', 'description-length', `${length} симв.`, `Оптимум ${LIMITS.descriptionMin}-${LIMITS.descriptionMax} символов`)
      );
    }
  }

  if (head.title && head.description && head.title.trim() === head.description.trim()) {
    findings.push(finding('warn', 'structure', 'title-equals-description', head.title, 'Title и description дублируют друг друга'));
  }

  if (body.headings.h1 === 0) {
    findings.push(finding('error', 'structure', 'h1-missing', 0, 'Добавить единственный <h1>'));
  } else if (body.headings.h1 > 1) {
    findings.push(finding('warn', 'structure', 'h1-multiple', body.headings.h1, 'Оставить один <h1> на страницу'));
  }

  if (body.headings.h2 === 0 && body.wordCount > LIMITS.wordsMin) {
    findings.push(finding('warn', 'structure', 'h2-missing', 0, 'Разбить текст подзаголовками <h2>'));
  }

  if (!head.lang) {
    findings.push(finding('info', 'structure', 'lang-missing', null, 'Задать <html lang="ru">'));
  }

  if (!head.viewport) {
    findings.push(finding('error', 'structure', 'viewport-missing', null, 'Без viewport страница не mobile-friendly'));
  }

  /* ---------------- Schema ---------------- */

  if (types.length === 0) {
    findings.push(finding('warn', 'schema', 'jsonld-missing', 0, 'Добавить разметку schema.org (JSON-LD)'));
  } else {
    // ProfessionalService, Store, Dentist и т.д. — подтипы LocalBusiness в schema.org,
    // строковое имя типа наследование не отражает, поэтому список семейств явный
    const ORG_FAMILY = new RegExp(
      [
        'Organization', 'LocalBusiness', 'ProfessionalService', 'Corporation', 'NGO',
        'PerformingGroup', 'SportsOrganization', 'AutomotiveBusiness', 'FinancialService',
        'FoodEstablishment', 'GovernmentOffice', 'HealthAndBeautyBusiness',
        'HomeAndConstructionBusiness', 'LegalService', 'MedicalBusiness', 'Store',
        'TouristInformationCenter', 'TravelAgency', 'EducationalOrganization',
        'EmploymentAgency', 'RealEstateAgent',
      ].join('|')
    );
    const hasOrg = types.some((t) => ORG_FAMILY.test(t));
    const hasPage = types.some((t) => /WebPage|Article|BlogPosting|Service|Product|FAQPage|Breadcrumb/.test(t));
    if (!hasOrg) findings.push(finding('info', 'schema', 'org-missing', types.join(', '), 'Добавить Organization/LocalBusiness'));
    if (!hasPage) findings.push(finding('warn', 'schema', 'page-type-missing', types.join(', '), 'Указать тип страницы (Article/Service/FAQPage и т.д.)'));
  }

  if (brokenLd) {
    findings.push(finding('error', 'schema', 'jsonld-broken', null, 'Один из блоков JSON-LD не парсится как JSON — поиск его игнорирует'));
  }

  /* ---------------- Content ---------------- */

  if (body.wordCount < LIMITS.wordsMin) {
    findings.push(
      finding('warn', 'content', 'thin-content', `${body.wordCount} слов`, `Для конкурентных запросов обычно нужно от ${LIMITS.wordsMin} слов осмысленного текста`)
    );
  }

  if (body.imagesTotal > 0 && body.imagesWithAlt / body.imagesTotal < LIMITS.imagesAltWarnRatio) {
    findings.push(
      finding(
        'warn',
        'content',
        'images-alt',
        `${body.imagesWithAlt}/${body.imagesTotal} с alt`,
        'Заполнить alt у изображений: это и доступность, и картиночная выдача'
      )
    );
  }

  /* ---------------- Linking ---------------- */

  if (body.internalLinks === 0) {
    findings.push(finding('warn', 'linking', 'no-internal-links', 0, 'Добавить перелинковку на смежные страницы'));
  } else if (body.internalLinks < 3 && body.wordCount > LIMITS.wordsMin) {
    findings.push(finding('info', 'linking', 'few-internal-links', body.internalLinks, 'Больше внутренних ссылок по теме'));
  }

  /* ---------------- AI Search (GEO/AEO) ---------------- */

  let domainFiles = null;
  if (options.probeDomain !== false) {
    domainFiles = await probeDomainFiles(parsed.origin);

    if (!domainFiles['llms.txt'].ok) {
      findings.push(
        finding('info', 'aiSearch', 'llms-txt-missing', null, 'Добавить llms.txt: ИИ-ассистенты всё чаще читают сайт через него')
      );
    }
    if (!domainFiles['sitemap.xml'].ok) {
      findings.push(finding('warn', 'aiSearch', 'sitemap-missing', null, 'Добавить sitemap.xml'));
    }
    if (!domainFiles['robots.txt'].ok) {
      findings.push(finding('warn', 'technical', 'robots-missing', null, 'Добавить robots.txt'));
    }
  }

  const hasFaqSchema = types.includes('FAQPage');
  const hasAnswerFirst = /<h2[^>]*>[^<]*(\?|как|почему|что|сколько)/i.test(html);
  if (!hasFaqSchema && !hasAnswerFirst) {
    findings.push(
      finding('info', 'aiSearch', 'no-answer-blocks', null, 'Добавить блоки «вопрос-ответ» и разметку FAQPage: их забирают ИИ-ответы поисковиков')
    );
  }

  if (!head.ogTitle || !head.ogImage) {
    findings.push(finding('info', 'aiSearch', 'og-missing', null, 'Заполнить og:title и og:image — их используют соцсети и ИИ-агрегаторы'));
  }

  /* ---------------- Performance (оценка по весу страницы) ---------------- */

  const pageKb = Math.round(Buffer.byteLength(html) / 1024);
  if (pageKb > LIMITS.maxPageKb) {
    findings.push(
      finding('warn', 'performance', 'html-weight', `${pageKb} КБ HTML`, 'Тяжёлый HTML обычно тянет за собой тяжёлые стили и скрипты — проверить CWV в PageSpeed')
    );
  }

  const scriptCount = (html.match(/<script[\s>]/gi) || []).length;
  if (scriptCount > 25) {
    findings.push(finding('info', 'performance', 'script-count', scriptCount, 'Много скриптов — вероятны просадки по INP/CLS'));
  }

  /* ---------------- Скоринг ---------------- */

  const penalty = { error: 1, warn: 0.5, info: 0.15 };
  const byCategory = {};

  for (const [category, weight] of Object.entries(WEIGHTS)) {
    const categoryFindings = findings.filter((f) => f.category === category);
    const loss = categoryFindings.reduce((sum, f) => sum + (penalty[f.severity] || 0), 0);
    // Две «ошибки» (или четыре предупреждения) обнуляют категорию: страница,
    // у которой категория провалена, не должна тянуть итоговую оценку вверх.
    // info-находки дешёвые (0.15) — это рекомендации на вырост, а не поломки.
    const score = Math.max(0, Math.round(weight * Math.max(0, 1 - loss / 2)));
    byCategory[category] = { weight, score, findings: categoryFindings.length };
  }

  const total = Object.values(byCategory).reduce((sum, row) => sum + row.score, 0);

  const severityOrder = { error: 0, warn: 1, info: 2 };
  findings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return {
    success: true,
    url: target,
    finalUrl,
    auditedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    score: { total, max: 100, byCategory },
    weights: WEIGHTS,
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warn').length,
    infos: findings.filter((f) => f.severity === 'info').length,
    findings,
    facts: {
      title: head.title,
      titleLength: head.title ? head.title.length : 0,
      description: head.description,
      descriptionLength: head.description ? head.description.length : 0,
      canonical: head.canonical,
      robotsMeta: head.robots,
      lang: head.lang,
      viewport: Boolean(head.viewport),
      headings: body.headings,
      wordCount: body.wordCount,
      images: { total: body.imagesTotal, withAlt: body.imagesWithAlt },
      links: { internal: body.internalLinks, external: body.externalLinks },
      schemaTypes: types,
      schemaBroken: brokenLd,
      og: { title: Boolean(head.ogTitle), image: Boolean(head.ogImage) },
      twitterCard: head.twitterCard,
      pageKb,
      scriptCount,
      domainFiles,
    },
  };
}

module.exports = { auditPage, parseHead, parseBody, schemaTypes, probeDomainFiles, WEIGHTS, LIMITS };
