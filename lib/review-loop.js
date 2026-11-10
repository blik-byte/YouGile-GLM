// lib/review-loop.js
// Петля приёмки: решение владельца прямо в чате задачи YouGile.
//
// Как работает: агент кладёт в чат отчёт и оставляет задачу незавершённой.
// Владелец отвечает «ок» или «не ок». Модуль распознаёт решение, закрывает
// задачу или отправляет её на доработку и отвечает в том же чате.
//
// Почему отдельный модуль: index.js проверяется целиком (загрузка всех
// модулей), а логику решения нужно покрывать тестами без сети.

'use strict';

// Только целое сообщение считается решением: «ок, но переделай шапку» — это
// обычный текст, а не согласие. Поэтому короткий список точных формулировок.
const ACCEPT_WORDS = new Set([
  'ок', 'окей', 'окэй', 'ok', 'okay', 'okey', 'принято', 'принял', 'приняла',
  'согласен', 'согласна', 'плюс', '+', '✅', '👍', 'да',
]);

const REJECT_WORDS = new Set([
  'не ок', 'неок', 'не окей', 'не принято', 'нет', 'мимо', 'переделай',
  'переделать', 'не то', '❌', '👎',
]);

const MAX_DECISION_LENGTH = 40;

/** Убирает пунктуацию, упоминание бота и лишние пробелы. */
function normalize(text) {
  return String(text || '')
    .replace(/@[\w_]+/g, ' ')
    .toLowerCase()
    .replace(/[«»"'`.,!?;:()\[\]\u00a0]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Решение владельца по сообщению.
 * @returns {'accept'|'reject'|null}
 */
function classify(text) {
  const raw = String(text || '').trim();
  if (!raw || raw.length > MAX_DECISION_LENGTH) return null;

  const value = normalize(raw);
  if (!value) return null;
  if (ACCEPT_WORDS.has(value)) return 'accept';
  if (REJECT_WORDS.has(value)) return 'reject';
  return null;
}

/** Сообщение написано агентом, а не человеком. */
function isAiMessage(message) {
  if (!message) return false;
  const text = String(message.text || '');
  return (
    message.label === 'AI' ||
    text.includes('🤖 AI-агент') ||
    text.includes('💡 Ответ:') ||
    /ai\.assistant|ai@/i.test(String(message.author?.email || ''))
  );
}

/** В чате есть отчёт агента — значит решение имеет смысл принимать. */
function hasAgentReport(messages = []) {
  return (messages || []).some((message) => isAiMessage(message) && String(message.text || '').trim());
}

/**
 * Обрабатывает сообщение как решение по итерации.
 * @returns {Promise<{handled: boolean, action?: string, reason?: string}>}
 */
async function handleReviewMessage({ taskId, taskTitle = '', completed = false, text, messages = [], deps = {} }) {
  const action = classify(text);
  if (!action) return { handled: false, reason: 'not-a-decision' };
  if (completed) return { handled: false, reason: 'already-completed' };
  if (!hasAgentReport(messages)) return { handled: false, reason: 'no-report' };
  if (!deps.completeTask || !deps.addComment) return { handled: false, reason: 'no-deps' };

  if (action === 'accept') {
    await deps.completeTask(taskId);
    await deps.addComment(taskId, '✅ Принято. Задача закрыта.');
    if (deps.notify) {
      await deps.notify(`✅ Принято: ${taskTitle}`).catch(() => {});
    }
    return { handled: true, action };
  }

  await deps.addComment(
    taskId,
    '↩️ Принято к доработке. Напишите, что именно исправить — вернусь с правкой.'
  );
  if (deps.notify) {
    await deps.notify(`↩️ На доработке: ${taskTitle}`).catch(() => {});
  }
  return { handled: true, action };
}

module.exports = {
  classify,
  normalize,
  isAiMessage,
  hasAgentReport,
  handleReviewMessage,
  ACCEPT_WORDS,
  REJECT_WORDS,
};
