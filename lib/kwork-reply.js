// lib/kwork-reply.js
// Черновик отклика на заказ Kwork.
//
// Задача: не писать «уникальный текст» каждый раз, а собрать предсказуемое
// письмо из проверенных владельцем блоков под тип заказа. Владелец копирует
// его, дописывает пару личных деталей и отправляет сам — автопостинга нет.
//
// Ничего не выдумываем: в шаблонах нет ни цифр, ни кейсов, которых владелец
// не подтвердил. Всё, что можно сказать о заказе, — берётся из заголовка.

'use strict';

const fs = require('fs');
const path = require('path');

const { normalize } = require('./kwork-filter');

const DEFAULT_REPLIES = path.join(__dirname, '..', 'config', 'kwork-replies.json');

function loadReplies(file = DEFAULT_REPLIES) {
  const replies = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!replies.templates || !replies.templates.generic) {
    throw new Error('Неверный формат шаблонов: нужен объект templates с ключом generic');
  }
  return replies;
}

/** Тип заказа по заголовку: audit / links / consult / seo / generic. */
function detectType(title, replies) {
  const rules = replies || loadReplies();
  const text = normalize(title);

  for (const [key, template] of Object.entries(rules.templates)) {
    if (key === 'generic') continue;
    if ((template.triggers || []).some((trigger) => text.includes(normalize(trigger)))) {
      return key;
    }
  }
  return 'generic';
}

/**
 * Собирает текст отклика.
 * @returns {{type: string, text: string}}
 */
function buildReply(title, options = {}) {
  const replies = options.replies || loadReplies();
  const type = options.type || detectType(title, replies);
  const template = replies.templates[type] || replies.templates.generic;

  const body = String(template.body || '')
    .replace(/\{\{pricing\}\}/g, String(replies.pricing || '').trim())
    .trim();

  const signature = String(replies.signature || '').trim();
  const text = signature ? `${body}\n\n_____________________________\n${signature}` : body;

  return { type, text };
}

module.exports = { loadReplies, detectType, buildReply, DEFAULT_REPLIES };
