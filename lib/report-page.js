// lib/report-page.js
// HTML-страница отчёта по задаче: GET /report/<id задачи>.
//
// Зачем: в Telegram уходит только короткая строка со ссылкой (просьба
// владельца), а полный текст отчёта должен открываться одним кликом с телефона.
// Страница самодостаточна: стили inline, без внешних ресурсов.

const { toStr } = require('./text');

function escapeHtml(value) {
  return toStr(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Ссылки в уже экранированном тексте превращаем в кликабельные <a>. */
function linkify(escaped) {
  return toStr(escaped).replace(
    /https?:\/\/(?:&amp;|&lt;|&gt;|&quot;|&#39;|[^\s<>&])+/g,
    (match) => {
      // Хвостовую пунктуацию («ссылка.» в конце предложения) не клеим к URL
      let url = match;
      let tail = '';
      const punct = url.match(/[.,;:!?)]+$/);
      if (punct) {
        tail = punct[0];
        url = url.slice(0, -tail.length);
      }
      return `<a href="${url}" style="color:#4da3ff;word-break:break-all;">${url}</a>${tail}`;
    }
  );
}

const STATUS_LABEL = {
  done: '✅ выполнена',
  error: '❌ ошибка',
  partial: '⚠️ частично',
};

function renderReportPage(report, options = {}) {
  const title = escapeHtml(report && report.title ? report.title : '(без названия)');
  const status = toStr(report && report.status) || 'done';
  const statusLabel = STATUS_LABEL[status] || escapeHtml(status);
  const text = linkify(escapeHtml(report && report.text ? report.text : '(пустой отчёт)'));
  const updated =
    report && report.updatedAt ? new Date(report.updatedAt).toLocaleString('ru-RU') : '—';
  const dashboardUrl = escapeHtml(toStr(options.publicBaseUrl).replace(/\/+$/, ''));

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Отчёт: ${title}</title>
</head>
<body style="margin:0;background:#0f1420;color:#e8ecf4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
<div style="max-width:760px;margin:0 auto;padding:20px 16px 48px;">
  <div style="font-size:13px;color:#8b94a7;">${statusLabel} · обновлено ${escapeHtml(updated)}</div>
  <h1 style="font-size:20px;line-height:1.35;margin:8px 0 16px;">📝 ${title}</h1>
  <div style="background:#161d2e;border:1px solid #263149;border-radius:12px;padding:16px;white-space:pre-wrap;word-wrap:break-word;font-size:14px;line-height:1.55;">${text}</div>
  <p style="font-size:13px;color:#8b94a7;margin-top:16px;">Полный текст отчёта также лежит комментарием в задаче YouGile. <a href="${dashboardUrl}/" style="color:#4da3ff;">Дашборд</a></p>
</div>
</body>
</html>`;
}

function renderNotFoundPage() {
  return `<!doctype html>
<html lang="ru">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Отчёт не найден</title></head>
<body style="margin:0;background:#0f1420;color:#e8ecf4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
<div style="max-width:760px;margin:0 auto;padding:40px 16px;">
  <h1 style="font-size:20px;">Отчёт не найден</h1>
  <p style="font-size:14px;color:#8b94a7;">По этому id задачи отчёта пока нет. Возможно, задача ещё выполняется или ссылка устарела.</p>
</div>
</body>
</html>`;
}

module.exports = { renderReportPage, renderNotFoundPage, escapeHtml };
