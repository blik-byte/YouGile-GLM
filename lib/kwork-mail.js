// lib/kwork-mail.js
// Разбор письма Kwork «Новые проекты на бирже».
//
// Формат письма (проверено на реальном .eml от 2026-06-17):
//   From: news@kwork.ru
//   Subject: Новые проекты на бирже Kwork
//   Только HTML, внутри — таблица «Название | Покупатель | Цена».
//   В строке: ссылка https://kwork.ru/new_offer?project=<id>, под ней категория
//   вида «SEO и трафик > Семантическое ядро > > С нуля», справа цена «30 000 Р».
//
// Категория важнее заголовка: по ней видно рубрику, выбранную владельцем,
// и она отсекает чужие темы надёжнее, чем догадки по названию.

'use strict';

const PROJECT_LINK = /https?:\/\/kwork\.(?:ru|com)\/new_offer\?project=(\d+)/i;

function stripTags(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&gt;/gi, '>')
    .replace(/&lt;/gi, '<')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Похоже ли письмо на дайджест новых проектов Kwork. */
function isKworkProjectsMail({ from = '', subject = '', html = '' } = {}) {
  const fromKwork = /kwork\.(ru|com)/i.test(String(from));
  const looksLikeDigest = /новые проект/i.test(String(subject)) || PROJECT_LINK.test(String(html));
  return fromKwork && looksLikeDigest;
}

/**
 * Разбирает HTML письма в список проектов.
 * @returns {Array<{id, title, url, category, buyer, price, raw}>}
 */
function parseProjects(html) {
  const rows = String(html || '').split(/<tr[^>]*>/i).slice(1);
  const projects = [];

  for (const row of rows) {
    const link = row.match(/<a[^>]+href="([^"]*new_offer\?project=\d+[^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;

    const idMatch = link[1].match(PROJECT_LINK);
    if (!idMatch) continue;

    const cells = row.split(/<td[^>]*>/i).slice(1);
    const titleCell = cells[0] || '';
    const buyerCell = cells[1] || '';
    const priceCell = cells[2] || '';

    const title = stripTags(link[2]);
    const category = stripTags(titleCell.replace(link[0], ' '));
    // Имя покупателя лежит в <span>; в тексте ячейки ещё статистика
    // вида «2 проекта на бирже» и «23% нанято» — её не берём.
    const buyerSpan = buyerCell.match(/<span[^>]*>([\s\S]*?)<\/span>/i);
    const buyer = buyerSpan ? stripTags(buyerSpan[1]) : stripTags(buyerCell).split(/\d+\s+проект/i)[0].trim();
    const priceText = stripTags(priceCell);
    // В последней строке в ячейку цены попадает хвост подвала
    // («5 000 Р Ваши настройки на бирже») — берём только сумму.
    const priceMatch = priceText.match(/^[\s\d.,]+(?:Р|₽)/);
    const price = priceMatch ? priceMatch[0].trim() : priceText.split(/[А-Яа-я]{4,}/)[0].trim();

    projects.push({
      id: idMatch[1],
      title,
      url: link[1],
      projectUrl: `https://kwork.ru/projects/${idMatch[1]}`,
      category,
      buyer,
      price,
      raw: { category, price },
    });
  }

  return projects;
}

/** Письмо целиком: метаданные + проекты. */
function parseKworkEmail({ from = '', subject = '', html = '' } = {}) {
  if (!isKworkProjectsMail({ from, subject, html })) {
    return { isKwork: false, projects: [] };
  }
  return { isKwork: true, projects: parseProjects(html) };
}

module.exports = { isKworkProjectsMail, parseProjects, parseKworkEmail, stripTags };
