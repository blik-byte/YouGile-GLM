// lib/notify-text.js
// Короткие уведомления для Telegram владельца (пункт 10 его просьб).
//
// Раньше в Telegram уезжал весь отчёт (до 900 символов) — сообщение обрезалось
// и читалось плохо. Теперь в Telegram уходит только статус одной строкой и
// ссылка на страницу отчёта /report/<id задачи>; полный текст живёт в задаче
// YouGile (комментарий) и на странице отчёта.

const { toStr } = require('./text');

/** Короткий заголовок без переносов — для строки статуса. */
function shortTitle(title, limit = 80) {
  const value = toStr(title).replace(/\s+/g, ' ').trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1).trimEnd()}…`;
}

/** Ссылка на страницу отчёта на нашем сервере. */
function reportUrlFor(publicBaseUrl, taskId) {
  const base = toStr(publicBaseUrl).replace(/\/+$/, '');
  return `${base}/report/${encodeURIComponent(toStr(taskId))}`;
}

/**
 * Текст уведомления «задача запущена».
 * Для длинных сценариев сразу говорим, сколько ждать и что придёт в конце,
 * чтобы тишина в чате не выглядела как зависание (вопрос владельца по
 * задаче семантики: 13 минут тишины, потом два сообщения подряд).
 */
function buildStartedBody({ title, taskId, workflow }) {
  let body = `▶️ Задача запущена\n\n📝 ${toStr(title)}\n🆔 ${toStr(taskId)}`;

  if (workflow === 'semantics') {
    body +=
      '\n\n⏳ Собираю черновик: подсказки поисковиков снимаются 5–15 минут. ' +
      'В конце придут два сообщения подряд: заявка на согласование и отчёт с файлом и кнопкой.';
  } else if (workflow === 'seo_audit') {
    body += '\n\n⏳ Аудит обычно занимает 2–5 минут. Пришлю короткую строку и ссылку на отчёт.';
  }

  return body;
}

/**
 * Текст уведомления «задача выполнена»: одна строка статуса + ссылка на отчёт.
 * Никакого полного текста отчёта в Telegram.
 */
function buildDoneBody({ workflow, title, domain, draftId, reportUrl }) {
  let line;

  if (workflow === 'seo_audit' && domain) {
    line = `🔍 SEO-аудит ${toStr(domain)} выполнен.`;
  } else if (workflow === 'semantics' && draftId) {
    line = `📝 Черновик семантики ${toStr(draftId)} готов.`;
  } else if (workflow === 'page') {
    line = '📄 Черновик страницы готов.';
  } else {
    line = `✅ Задача выполнена: ${shortTitle(title)}`;
  }

  return `${line}\n📄 Отчёт: ${toStr(reportUrl)}`;
}

module.exports = { shortTitle, reportUrlFor, buildStartedBody, buildDoneBody };
