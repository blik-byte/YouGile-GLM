// lib/leads-page.js
// Отдача макета v3 с реальными данными.
//
// Подход: не переписывать 2000 строк макета, а подменить в нём демо-массивы
// (RAW, SOURCES, NEWS, SITES, REPLIES, PENDING) на данные из базы. Вся вёрстка
// и рендер остаются дизайнерскими — меняется только источник данных.
// Так макет и прод выглядят одинаково, а расхождений «в макете одно, в жизни другое» нет.

'use strict';

const fs = require('fs');
const path = require('path');

const TEMPLATE = path.join(__dirname, '..', 'public', 'leads-v3.html');

/** Часы с публикации — макет ждёт число часов, а не дату. */
function hoursSince(publishedAt, now) {
  if (!publishedAt) return 48;
  const time = new Date(publishedAt).getTime();
  if (!Number.isFinite(time)) return 48;
  return Math.round(((now - time) / 3600000) * 10) / 10;
}

/** Тип заказа для выбора черновика отклика. */
function draftType(title) {
  const text = String(title || '').toLowerCase();
  if (/аудит|юзабилити/.test(text)) return 'audit';
  if (/ссыл|линкбилд/.test(text)) return 'links';
  if (/консультац/.test(text)) return 'consult';
  if (/продвижен|seo|оптимизац|семантик/.test(text)) return 'seo';
  return 'generic';
}

/** Документ из базы → объект, который понимает макет. */
function mapLead(doc, now = Date.now()) {
  const reasons = Array.isArray(doc.reasons) ? doc.reasons : [];
  return {
    id: `${doc.source}-${doc.externalId}`,
    src: doc.source,
    t: doc.title,
    cat: doc.category || '',
    bt: doc.budget || '',
    bv: doc.budgetValue || 0,
    bk: doc.budgetKind || 'fixed',
    h: hoursSince(doc.publishedAt, now),
    v: doc.verdict,
    vr: reasons.length ? reasons.map((reason) => reason.text).join(' · ') : 'жёстких причин нет',
    sk: doc.serviceType || 'whitelist',
    eng: doc.employment || 'one_time',
    resp: doc.responses,
    st: doc.status || 'new',
    type: draftType(doc.title),
    desc: doc.description || '',
    score: doc.score,
    priority: doc.priority,
    reasons,
    components: doc.components || {},
    rulesVersion: doc.rulesVersion,
    notes: doc.notes || '',
    next: doc.next || null,
  };
}

/** Строка «последняя проверка» для таблицы источников. */
function lastCheckText(state) {
  if (!state || !state.lastAttemptAt) return 'не проверялся';
  const minutes = Math.max(0, Math.round((Date.now() - new Date(state.lastAttemptAt).getTime()) / 60000));
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  return `${hours} ч назад`;
}

/** Источники: в MVP только FL.ru. */
function buildSources(state) {
  return [
    {
      id: 'fl',
      name: 'FL.ru',
      url: 'fl.ru',
      type: 'заказы',
      method: 'RSS',
      freq: 'сбор каждые 20 мин',
      fit: 'число откликов, бюджет, категория',
      verdict: 'active',
      pr: 1,
      health: state && state.down ? 'err' : 'ok',
      last: lastCheckText(state),
      comment: state && state.lastError ? String(state.lastError).slice(0, 120) : 'основной источник',
    },
  ];
}

function safeJson(value) {
  return JSON.stringify(value).replace(/<\//g, '<\\/');
}

/** Подмена одного демо-массива: `var NAME = [ ... ];` в любом форматировании. */
function replaceArray(html, name, value) {
  // Не жёстко к переносу строки: в макете часть массивов однострочные,
  // и привязка к «\n];» съедала следующий массив.
  const pattern = new RegExp(`var ${name} = \\[[\\s\\S]*?\\];`);
  if (!pattern.test(html)) {
    throw new Error(`В макете не найден массив ${name}`);
  }
  return html.replace(pattern, `var ${name} = ${safeJson(value)};`);
}

/** Подстановка реальных данных в макет. */
function injectData(html, { orders = [], health = null, replies = [], now = Date.now() } = {}) {
  let output = html;

  output = replaceArray(output, 'RAW', orders);
  output = replaceArray(output, 'PENDING', []);
  output = replaceArray(output, 'NEWS', []);
  output = replaceArray(output, 'NEWS_TOPICS', []);
  output = replaceArray(output, 'SOURCES', buildSources(health));
  output = replaceArray(output, 'REPLIES', replies);
  output = replaceArray(output, 'SITES', []);

  // Версия правил в подвале должна совпадать с той, что пришла в данных.
  const rulesVersion = orders.find((order) => order.rulesVersion && order.rulesVersion) ;

  return output;
}

/** Читает шаблон один раз и кеширует. */
let cachedTemplate = null;

function loadTemplate() {
  if (!cachedTemplate) cachedTemplate = fs.readFileSync(TEMPLATE, 'utf8');
  return cachedTemplate;
}

module.exports = {
  TEMPLATE,
  mapLead,
  buildSources,
  lastCheckText,
  replaceArray,
  injectData,
  loadTemplate,
  draftType,
};
