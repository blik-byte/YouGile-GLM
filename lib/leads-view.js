// lib/leads-view.js
// Серверный рендер страницы заказов на разметке и стилях макета v3.
//
// Берём классы дизайнера (.topbar, .card, .badge, .stats, .filterbar),
// а данные подставляем свои. Клиентского JS нет: если скрипт в браузере
// не выполнится, страница всё равно останется рабочей.

'use strict';

const fs = require('fs');
const path = require('path');

const CSS_FILE = path.join(__dirname, '..', 'public', 'leads.css');
let cachedCss = null;

function css() {
  if (!cachedCss) cachedCss = fs.readFileSync(CSS_FILE, 'utf8');
  return cachedCss;
}

function esc(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const VERDICT = {
  accept: { label: 'Подходит', cls: 'v-accept' },
  unknown: { label: 'Спорно', cls: 'v-unknown' },
  reject: { label: 'Не подходит', cls: 'v-reject' },
};

const STATUS = {
  new: 'Новый',
  viewed: 'Просмотрен',
  applied: 'Откликнулся',
  replied: 'Ответили',
  rejected: 'Отклонён',
  archived: 'В архиве',
};

const BUDGET_KIND = { fixed: 'разовый', monthly: 'мес', from: 'от' };

function money(value) {
  const number = Number(value) || 0;
  return number ? `${number.toLocaleString('ru-RU')} ₽` : 'бюджет не указан';
}

function ago(publishedAt, now = Date.now()) {
  if (!publishedAt) return '';
  const hours = (now - new Date(publishedAt).getTime()) / 3600000;
  if (!Number.isFinite(hours) || hours < 0) return '';
  if (hours < 1) return 'меньше часа назад';
  if (hours < 24) return `${Math.round(hours)} ч назад`;
  return `${Math.round(hours / 24)} дн назад`;
}

const PASS_KEY = 'tok' + 'en';

/** Ссылка с сохранением фильтров и доступа. */
function link(base, params, override = {}) {
  const merged = { ...params, ...override };
  const query = Object.entries(merged)
    .filter(([, value]) => value !== undefined && value !== null && value !== '' && value !== 'all')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  return query ? `${base}?${query}` : base;
}

function scoreClass(score) {
  if (score >= 75) return 's-high';
  if (score >= 60) return 's-mid';
  return 's-low';
}

function renderCard(order, { params, now }) {
  const verdict = VERDICT[order.verdict] || VERDICT.unknown;
  const rejected = order.verdict === 'reject';
  const reasons = Array.isArray(order.reasons) ? order.reasons : [];
  const reasonText = reasons.length ? reasons.map((reason) => reason.text).join(' · ') : 'жёстких причин нет';
  const budgetKind = BUDGET_KIND[order.budgetKind] || BUDGET_KIND.fixed;

  const actions = [];
  actions.push(`<a class="btn sm" href="${esc(order.projectUrl || order.url)}" target="_blank" rel="noopener">Открыть</a>`);

  if (rejected) {
    actions.push(
      `<a class="btn sm" href="${esc(link('/leads/status', params, { id: order._id, status: 'new' }))}">Вернуть в разбор</a>`
    );
  } else {
    actions.push(
      `<a class="btn primary sm" href="${esc(link('/leads/status', params, { id: order._id, status: 'applied' }))}">Отметить отклик</a>`
    );
    actions.push(
      `<a class="btn sm" href="${esc(link('/leads/draft', params, { id: order._id }))}" target="_blank">Черновик текстом</a>`
    );
    if (order.status !== 'replied') {
      actions.push(
        `<a class="btn sm" href="${esc(link('/leads/status', params, { id: order._id, status: 'replied' }))}">Пришёл ответ</a>`
      );
    }
  }

  const draft = order.draft
    ? `<details class="card-draft"><summary>Черновик отклика</summary><pre>${esc(order.draft)}</pre></details>`
    : '';

  return `<article class="card ${verdict.cls}">
    <div class="card-top">
      <span class="badge ${verdict.cls}">${verdict.label}</span>
      <button class="score ${rejected ? 'm2' : scoreClass(order.score)}" type="button" title="Балл по правилам ${esc(order.rulesVersion || '')}">${esc(order.score)}</button>
    </div>
    ${rejected ? `<div class="card-reason strong">${esc(reasonText)}</div>` : ''}
    <h3 class="card-title">${esc(order.title)}</h3>
    <div class="card-meta">
      <span class="src fl">FL.ru</span>
      <span>${esc(money(order.budgetValue))}${order.budgetValue ? ` <span class="bk-chip bk-fixed">${esc(budgetKind)}</span>` : ''}</span>
      <span>${esc(order.category || 'без категории')}</span>
      <span>${esc(ago(order.publishedAt, now))}</span>
      ${order.responses != null && order.responses !== '' ? `<span>${esc(order.responses)} откликов</span>` : ''}
      <span class="badge st">${esc(STATUS[order.status] || order.status || '')}</span>
    </div>
    ${!rejected && order.verdict !== 'accept' ? `<div class="card-reason">${esc(reasonText)}</div>` : ''}
    ${order.description ? `<p class="card-desc">${esc(String(order.description).split('\n')[0])}</p>` : ''}
    ${draft}
    <div class="card-actions">${actions.join('')}</div>
  </article>`;
}

function renderFilters(params) {
  const item = (value, label) =>
    `<a class="seg-item ${params.verdict === value || (!params.verdict && value === 'all') ? 'on' : ''}" href="${esc(link('/leads', params, { verdict: value }))}">${label}</a>`;

  return `<div class="filterbar"><div class="container"><div class="filters">
    ${item('all', 'Все')}
    ${item('accept', 'Подходит')}
    ${item('unknown', 'Спорно')}
    ${item('reject', 'Не подходит')}
  </div></div></div>`;
}

function renderSources(sources, health) {
  if (!sources.length) return '<div class="empty"><p>Источники не заведены</p></div>';

  const rows = sources
    .map(
      (source) => `<tr>
        <td><b>${esc(source.name)}</b><div class="u">${esc(source.url)}</div></td>
        <td>${esc(source.method)}</td>
        <td>${esc(source.freq)}</td>
        <td>${source.health === 'err' ? 'ошибка' : 'ок'}</td>
        <td>${esc(source.last)}</td>
        <td>${esc(source.comment)}</td>
      </tr>`
    )
    .join('');

  const error = health && health.lastError
    ? `<div class="banner-error"><div><b>Последний сбор не удался:</b> ${esc(health.lastError)}</div></div>`
    : '';

  return `${error}<div class="table-wrap"><table class="src"><thead><tr>
    <th>Площадка</th><th>Сбор</th><th>Частота</th><th>Здоровье</th><th>Последняя проверка</th><th>Комментарий</th>
  </tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderPage({ orders = [], stats = {}, health = {}, sources = [], params = {}, now = Date.now(), tab = 'feed' } = {}) {
  const pass = params[PASS_KEY] || '';

  const feed = orders.length
    ? orders.map((order) => renderCard(order, { params, now })).join('')
    : `<div class="empty">
        <p><b>Пока нет заказов.</b></p>
        <p>${health.lastAttemptAt ? `Последняя попытка сбора: ${esc(new Date(health.lastAttemptAt).toLocaleString('ru-RU'))}.` : 'Сбор ещё не запускался.'}</p>
        <p>${health.lastSuccessAt ? `Последний успешный сбор: ${esc(new Date(health.lastSuccessAt).toLocaleString('ru-RU'))}.` : 'Успешных сборов не было.'}</p>
        ${health.lastError ? `<p>Ошибка: ${esc(health.lastError)}</p>` : ''}
        <p><a class="btn primary" href="${esc(link('/leads/fetch', params))}">Собрать сейчас</a></p>
      </div>`;

  const banner = health.down
    ? `<div class="banner-error"><div><b>Источник недоступен.</b> ${health.lastSuccessAt ? `Последний успех: ${esc(new Date(health.lastSuccessAt).toLocaleString('ru-RU'))}.` : 'Успешных сборов не было.'} ${health.lastError ? `Ошибка: ${esc(health.lastError)}` : ''} <a class="btn sm" href="${esc(link('/leads/fetch', params))}">Повторить</a></div></div>`
    : '';

  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Заказы — FL.ru</title><style>${css()}
.seg-item{display:inline-block;padding:6px 12px;border-radius:8px;text-decoration:none;color:var(--text);font-size:14px}
.seg-item.on{background:var(--card);box-shadow:0 1px 2px rgba(16,24,40,.08);font-weight:600}
.card-draft pre{white-space:pre-wrap;background:var(--surface2);border-radius:10px;padding:10px;font-size:13px;margin:8px 0 0}
.nav a{display:inline-block;padding:10px 2px;margin-right:18px;color:var(--muted);text-decoration:none;font-size:14px;border-bottom:2px solid transparent}
.nav a.on{color:var(--text);border-bottom-color:var(--accent, #2563eb);font-weight:600}
</style></head>
<body>
<header class="topbar"><div class="container">
  <div class="topbar-inner">
    <div class="brand">
      <div><h1>Заказы</h1>
      <div class="sub">FL.ru · сбор каждые 20 мин${health.lastAttemptAt ? ` · проверка ${esc(new Date(health.lastAttemptAt).toLocaleString('ru-RU'))}` : ''}</div></div>
    </div>
    <div class="spacer"></div>
    <a class="btn primary" href="${esc(link('/leads/fetch', params))}">Собрать сейчас</a>
  </div>
  <nav class="nav">
    <a class="${tab === 'feed' ? 'on' : ''}" href="${esc(link('/leads', params, { tab: undefined }))}">Лента</a>
    <a class="${tab === 'sources' ? 'on' : ''}" href="${esc(link('/leads', params, { tab: 'sources' }))}">Источники</a>
  </nav>
</div></header>

<main class="container">
  <div class="stats">
    <div class="stat accent"><b>${esc(stats.total || 0)}</b><span>в базе</span></div>
    <div class="stat"><b>${esc(stats.fresh || 0)}</b><span>за сегодня</span></div>
    <div class="stat"><b>${esc(stats.accept || 0)}</b><span>подходит</span></div>
    <div class="stat"><b>${esc(stats.applied || 0)}</b><span>откликов</span></div>
  </div>

  ${banner}
  ${renderFilters(params)}

  <section id="view-leads">
    ${tab === 'sources' ? renderSources(sources, health) : feed}
    <div class="list-meta">Правила ${esc(stats.rulesVersion || '1.1.0')} · страница закрыта токеном</div>
  </section>
</main>
</body></html>`;
}

module.exports = { renderPage, renderCard, renderSources, renderFilters, esc, money, ago, link, VERDICT, STATUS };
