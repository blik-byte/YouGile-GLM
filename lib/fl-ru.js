// lib/fl-ru.js
// Сбор заказов FL.ru через открытый RSS.
//
// Проверено на https://www.fl.ru/rss/all.xml: отдаёт заголовок, ссылку, полный
// текст заказа, категорию и дату. Бюджет часто в заголовке строкой
// «(Бюджет: 1 000 ₽)» — вытаскиваем отдельно, если он там есть.
//
// XML разбираем регулярками: структура плоская (<item> … </item>), а тянуть
// полноценный парсер ради пяти полей — лишняя зависимость на 512 МБ.

'use strict';

const RSS_URL = process.env.FL_RSS_URL || 'https://www.fl.ru/rss/all.xml';

function decodeEntities(value) {
  return String(value || '')
    .replace(/&#8381;|&rub;/gi, '₽')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function field(item, tag) {
  const cdata = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, 'i');
  const plain = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const match = item.match(cdata) || item.match(plain);
  return match ? decodeEntities(match[1]) : '';
}

/** Вытаскивает сумму из строки «(Бюджет: 1 000 ₽)» или «Бюджет 15000 руб». */
function parseBudget(...texts) {
  const haystack = texts.filter(Boolean).join(' ');
  const match = haystack.match(/бюджет[^\d]{0,10}([\d\s.,]{2,15})\s*(?:₽|руб|р\.?)/i);
  if (!match) return { budget: '', budgetValue: 0 };

  const value = Number(match[1].replace(/[^\d]/g, ''));
  if (!value) return { budget: '', budgetValue: 0 };
  return { budget: `${value.toLocaleString('ru-RU')} ₽`, budgetValue: value };
}

/** Разбирает XML в массив заказов. */
function parseRss(xml) {
  const items = String(xml || '').split(/<item[\s>]/i).slice(1);
  const orders = [];

  for (const chunk of items) {
    const item = chunk.split(/<\/item>/i)[0];
    const title = field(item, 'title');
    const link = field(item, 'link');
    const description = field(item, 'description');
    const category = field(item, 'category');
    const pubDate = field(item, 'pubDate');

    const idMatch = link.match(/\/projects\/(\d+)/);
    if (!title || !idMatch) continue;

    const { budget, budgetValue } = parseBudget(title, description);

    orders.push({
      source: 'fl',
      externalId: idMatch[1],
      title,
      description,
      category,
      budget,
      budgetValue,
      url: link,
      projectUrl: link,
      publishedAt: pubDate ? new Date(pubDate) : null,
      buyer: '',
      price: budget,
    });
  }

  return orders;
}

/** Забирает ленту. Ошибки сети пробрасывает наверх — решает вызывающий. */
async function fetchOrders({ url = RSS_URL, timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'yougile-glm/1.1 (+project automation)',
        Accept: 'application/rss+xml, application/xml, text/xml',
      },
    });
    if (!response.ok) throw new Error(`FL.ru RSS: HTTP ${response.status}`);
    const xml = await response.text();
    return parseRss(xml);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { RSS_URL, parseRss, parseBudget, fetchOrders, decodeEntities };
