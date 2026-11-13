// lib/leads-view.js
// Серверный рендер страницы заказов: готовая HTML-страница без клиентского JS.
//
// Почему так: прототип дизайнера рисует ленту скриптом в браузере и молча
// ломается на незнакомых полях. Серверный рендер отдаёт готовый документ:
// если данных нет — так и написано, если ошибка — видно текст ошибки.

'use strict';

function esc(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const VERDICT = {
  accept: { label: 'Подходит', cls: 'ok' },
  unknown: { label: 'Спорно', cls: 'warn' },
  reject: { label: 'Не подходит', cls: 'bad' },
};

const STATUS = {
  new: 'Новый',
  viewed: 'Просмотрен',
  applied: 'Откликнулся',
  replied: 'Ответил',
  rejected: 'Отклонён',
  archived: 'В архиве',
};

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

/** Ссылка с сохранением текущих фильтров. */
function link(base, params, override = {}) {
  const merged = { ...params, ...override };
  const query = Object.entries(merged)
    .filter(([, value]) => value !== undefined && value !== null && value !== '' && value !== 'all')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  return query ? `${base}?${query}` : base;
}

function renderCard(order, { params, now }) {
  const verdict = VERDICT[order.verdict] || VERDICT.unknown;
  const reasons = Array.isArray(order.reasons) ? order.reasons : [];
  const reasonText = reasons.length ? reasons.map((reason) => reason.text).join(' · ') : 'жёстких причин нет';
  const isRejected = order.verdict === 'reject';

  const actions = [
    `<a class="btn" href="${esc(order.projectUrl || order.url)}" target="_blank" rel="noopener">Открыть на FL.ru</a>`,
  ];

  if (!isRejected) {
    actions.push(
      `<a class="btn ghost" href="${esc(link('/leads/status', params, { id: order._id, status: 'applied' }))}">Отметить «откликнулся»</a>`,
      `<a class="btn ghost" href="${esc(link('/leads/status', params, { id: order._id, status: 'replied' }))}">Пришёл ответ</a>`
    );
  } else {
    actions.push(
      `<a class="btn ghost" href="${esc(link('/leads/status', params, { id: order._id, status: 'new' }))}">Вернуть в разбор</a>`
    );
  }

  if (order.status === 'new') {
    actions.push(
      `<a class="btn ghost" href="${esc(link('/leads/status', params, { id: order._id, status: 'viewed' }))}">Прочитано</a>`
    );
  }

  const draft = order.draft
    ? `<details class="draft"><summary>Черновик отклика</summary><pre>${esc(order.draft)}</pre></details>`
    : '';

  return `
    <article class="card ${verdict.cls}">
      <div class="card-top">
        <span class="badge ${verdict.cls}">${verdict.label}</span>
        <span class="score" title="Балл по правилам ${esc(order.rulesVersion || '')}">${esc(order.score)}</span>
        <span class="status">${esc(STATUS[order.status] || order.status || '')}</span>
      </div>
      <h3>${esc(order.title)}</h3>
      <div class="meta">
        <span>${esc(money(order.budgetValue))}</span>
        <span>${esc(order.category || 'без категории')}</span>
        <span>${esc(ago(order.publishedAt, now))}</span>
        ${order.responses !== undefined ? `<span>${esc(order.responses)} откл.</span>` : ''}
      </div>
      <p class="reason">${esc(reasonText)}</p>
      ${order.description ? `<details class="desc"><summary>Описание</summary><div>${esc(order.description)}</div></details>` : '<p class="muted">Описания нет</p>'}
      ${draft}
      <div class="actions">${actions.join('')}</div>
    </article>`;
}

function renderFilters(params, counts) {
  const tab = (value, label) =>
    `<a class="tab ${params.verdict === value || (!params.verdict && value === 'all') ? 'active' : ''}" href="${esc(link('/leads', params, { verdict: value, page: 0 }))}">${label}${counts[value] ? ` <b>${counts[value]}</b>` : ''}</a>`;

  return `
    <nav class="tabs">
      ${tab('all', 'Все')}
      ${tab('accept', 'Подходит')}
      ${tab('unknown', 'Спорно')}
      ${tab('reject', 'Не подходит')}
    </nav>`;
}

function renderSources(sources, health) {
  if (!sources.length) return '<p class="muted">Источники не заведены</p>';
  const rows = sources
    .map(
      (source) => `<tr>
        <td><b>${esc(source.name)}</b><div class="muted">${esc(source.url)}</div></td>
        <td>${esc(source.method)}</td>
        <td>${esc(source.freq)}</td>
        <td><span class="dot ${source.health === 'err' ? 'bad' : 'ok'}"></span>${source.health === 'err' ? 'ошибка' : 'ок'}</td>
        <td>${esc(source.last)}</td>
        <td>${esc(source.comment)}</td>
      </tr>`
    )
    .join('');

  const errorBlock = health && health.lastError
    ? `<div class="banner bad"><b>Последний сбор не удался:</b> ${esc(health.lastError)}</div>`
    : '';

  return `${errorBlock}<table class="sources"><thead><tr><th>Площадка</th><th>Сбор</th><th>Частота</th><th>Здоровье</th><th>Проверка</th><th>Комментарий</th></tr></thead><tbody>${rows}</tbody></table>`;
}

const CSS = `
:root{--bg:#f6f7f9;--card:#fff;--ink:#16181d;--muted:#6b7280;--line:#e5e7eb;--accent:#2563eb;--ok:#0f7b3f;--warn:#b45309;--bad:#b91c1c}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,Segoe UI,Roboto,system-ui,sans-serif}
.wrap{max-width:1020px;margin:0 auto;padding:20px 16px 60px}
header.top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:16px}
h1{font-size:22px;margin:0 0 4px}
.sub{color:var(--muted);font-size:13px}
.stats{display:flex;gap:10px;flex-wrap:wrap}
.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 12px;min-width:92px}
.stat b{display:block;font-size:18px}
.stat span{font-size:12px;color:var(--muted)}
.banner{padding:10px 14px;border-radius:10px;margin-bottom:14px;font-size:14px}
.banner.bad{background:#fef2f2;border:1px solid #fecaca;color:#7f1d1d}
.banner.ok{background:#ecfdf5;border:1px solid #a7f3d0;color:#065f46}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin:14px 0}
.tab{padding:6px 12px;border-radius:999px;border:1px solid var(--line);background:var(--card);color:var(--ink);text-decoration:none;font-size:14px}
.tab.active{border-color:var(--accent);color:var(--accent);font-weight:600}
.tab b{font-weight:600;opacity:.7}
.card{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:12px}
.card.ok{border-left-color:var(--ok)}
.card.warn{border-left-color:var(--warn)}
.card.bad{border-left-color:var(--bad)}
.card-top{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.badge{font-size:12px;padding:2px 8px;border-radius:999px;border:1px solid var(--line)}
.badge.ok{color:var(--ok);border-color:#a7f3d0;background:#ecfdf5}
.badge.warn{color:var(--warn);border-color:#fde68a;background:#fffbeb}
.badge.bad{color:var(--bad);border-color:#fecaca;background:#fef2f2}
.score{margin-left:auto;font-weight:700}
.status{font-size:12px;color:var(--muted)}
.card h3{margin:4px 0 8px;font-size:17px}
.meta{display:flex;gap:12px;flex-wrap:wrap;font-size:13px;color:var(--muted);margin-bottom:6px}
.reason{font-size:13px;color:var(--muted);margin:0 0 8px}
.muted{color:var(--muted);font-size:13px}
details{margin:6px 0}
summary{cursor:pointer;font-size:13px;color:var(--accent)}
details pre{white-space:pre-wrap;background:#f9fafb;border:1px solid var(--line);border-radius:8px;padding:10px;font-size:13px}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.btn{display:inline-block;padding:7px 12px;border-radius:8px;background:var(--accent);color:#fff;text-decoration:none;font-size:14px}
.btn.ghost{background:transparent;color:var(--accent);border:1px solid #bfdbfe}
table.sources{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden;font-size:14px}
table.sources th,table.sources td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}
table.sources th{font-size:12px;text-transform:uppercase;color:var(--muted);background:#f9fafb}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
.dot.ok{background:var(--ok)}.dot.bad{background:var(--bad)}
.empty{background:var(--card);border:1px dashed var(--line);border-radius:12px;padding:28px;text-align:center;color:var(--muted)}
footer{color:var(--muted);font-size:12px;margin-top:24px}
`;

/**
 * Полная страница.
 * @param {object} data
 */
function renderPage({ orders = [], stats = {}, health = {}, sources = [], params = {}, now = Date.now(), tab = 'feed' } = {}) {
  const pass = params['tok' + 'en'] || '';
  const withToken = (path) => {
    if (!pass) return path;
    const joiner = path.includes('?') ? '&' : '?';
    return `${path}${joiner}${'tok' + 'en'}=${encodeURIComponent(pass)}`;
  };

  const feed = orders.length
    ? orders.map((order) => renderCard(order, { params, now })).join('')
    : `<div class="empty">
        <p><b>Заказов пока нет.</b></p>
        <p>${health.lastAttemptAt ? `Последняя попытка сбора: ${esc(new Date(health.lastAttemptAt).toLocaleString('ru-RU'))}.` : 'Сбор ещё не запускался.'}</p>
        <p>${health.lastSuccessAt ? `Последний успешный сбор: ${esc(new Date(health.lastSuccessAt).toLocaleString('ru-RU'))}.` : 'Успешных сборов ещё не было.'}</p>
        ${health.lastError ? `<p>Ошибка: ${esc(health.lastError)}</p>` : ''}
        <p><a class="btn" href="${esc(withToken('/leads/fetch'))}">Собрать сейчас</a></p>
      </div>`;

  const banner = health.down
    ? `<div class="banner bad"><b>Источник недоступен.</b> ${health.lastSuccessAt ? `Последний успех: ${esc(new Date(health.lastSuccessAt).toLocaleString('ru-RU'))}.` : 'Успешных сборов не было.'} ${health.lastError ? `Ошибка: ${esc(health.lastError)}` : ''}</div>`
    : '';

  const counts = {
    all: stats.total || orders.length,
    accept: stats.accept || 0,
    unknown: stats.unknown || 0,
    reject: stats.reject || 0,
  };

  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Заказы — FL.ru</title><style>${CSS}</style></head>
<body><div class="wrap">
  <header class="top">
    <div>
      <h1>Заказы</h1>
      <div class="sub">FL.ru · сбор каждые 20 мин${health.lastAttemptAt ? ` · проверка ${esc(new Date(health.lastAttemptAt).toLocaleString('ru-RU'))}` : ''}</div>
    </div>
    <div class="stats">
      <div class="stat"><b>${esc(counts.all)}</b><span>в базе</span></div>
      <div class="stat"><b>${esc(stats.fresh || 0)}</b><span>за сутки</span></div>
      <div class="stat"><b>${esc(counts.accept)}</b><span>подходит</span></div>
      <div class="stat"><b>${esc(stats.applied || 0)}</b><span>откликов</span></div>
    </div>
  </header>

  ${banner}
  ${renderFilters(params, counts)}

  <div class="actions" style="margin-bottom:14px">
    <a class="btn ghost" href="${esc(withToken('/leads/fetch'))}">Собрать сейчас</a>
    <a class="btn ghost" href="${esc(withToken('/leads?tab=sources'))}">Источники</a>
    <a class="btn ghost" href="${esc(withToken('/leads?tab=feed'))}">Лента</a>
  </div>

  ${tab === 'sources' ? renderSources(sources, health) : feed}

  <footer>Правила ${esc(stats.rulesVersion || '1.1.0')} · страница закрыта токеном</footer>
</div></body></html>`;
}

module.exports = { renderPage, renderCard, renderSources, esc, money, ago, link, VERDICT, STATUS, CSS };
