// lib/approvals.js
// Заявки на согласование действий, которые агент не вправе выполнять сам.
//
// Политика владельца: агенты не редактируют, не публикуют и не удаляют
// существующий контент. Если такое действие действительно нужно и на него есть
// веская причина, агент НЕ выполняет его, а создаёт заявку: владелец получает
// сообщение в Telegram с причиной и целевым объектом и отвечает /approve или
// /deny. Только одобренная заявка даёт агенту право на действие.
//
// Заявки хранятся в MongoDB, поэтому переживают рестарты Render.

const crypto = require('crypto');

const db = require('../db');

const COLLECTION = 'approval_requests';

/** Действия, требующие согласования. */
const KINDS = {
  modx_update: 'изменение существующей страницы сайта',
  modx_publish_existing: 'публикация существующей (не созданной агентом) страницы',
  modx_unpublish: 'снятие с публикации существующей страницы',
  modx_delete: 'удаление ресурса (коннектор не поддерживает вовсе)',
};

function shortId() {
  return crypto.randomBytes(4).toString('hex');
}

/**
 * Создание заявки и уведомление администраторов.
 * @returns {Promise<object>} заявка с id
 */
async function createRequest({ kind, target, reason, taskId = null }) {
  const id = shortId();
  const request = {
    id,
    kind,
    kindLabel: KINDS[kind] || kind,
    target: String(target || ''),
    reason: String(reason || 'причина не указана'),
    taskId: taskId ? String(taskId) : null,
    status: 'pending',
    createdAt: new Date(),
    decidedAt: null,
    decidedBy: null,
  };

  const connection = await db.getDb();
  await connection.collection(COLLECTION).insertOne(request);

  // Уведомляем администраторов: они принимают решение прямо из Telegram
  try {
    const { notifyAdmins } = require('../telegram-bot');
    await notifyAdmins(
      `🔐 <b>Запрос на согласование</b> <code>${id}</code>\n\n` +
        `Действие: ${request.kindLabel}\n` +
        `Объект: ${request.target}\n` +
        (request.taskId ? `Задача: <code>${request.taskId}</code>\n` : '') +
        `Причина агента: ${request.reason}\n\n` +
        `Разрешить: <code>/approve ${id}</code>\nЗапретить: <code>/deny ${id}</code>`
    );
  } catch (error) {
    console.warn(`⚠️ Не удалось уведомить админов о заявке ${id}: ${error.message}`);
  }

  console.log(`🔐 Заявка ${id}: ${request.kindLabel} → ${request.target}`);
  return request;
}

async function get(id) {
  const connection = await db.getDb();
  return connection.collection(COLLECTION).findOne({ id: String(id) });
}

async function listPending(limit = 20) {
  const connection = await db.getDb();
  return connection
    .collection(COLLECTION)
    .find({ status: 'pending' })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
}

async function listRecent(limit = 20) {
  const connection = await db.getDb();
  return connection.collection(COLLECTION).find({}).sort({ createdAt: -1 }).limit(limit).toArray();
}

/**
 * Решение по заявке.
 * @param {string} id
 * @param {'approved'|'denied'} decision
 * @param {string} decidedBy - chat ID администратора
 * @returns {Promise<{ok:boolean, request?:object, error?:string}>}
 */
async function decide(id, decision, decidedBy) {
  const connection = await db.getDb();
  const result = await connection.collection(COLLECTION).findOneAndUpdate(
    { id: String(id), status: 'pending' },
    {
      $set: {
        status: decision,
        decidedAt: new Date(),
        decidedBy: String(decidedBy),
      },
    },
    { returnDocument: 'after' }
  );

  const request = result && (result.value ?? result);
  if (!request || !request.id) {
    return { ok: false, error: `Заявка ${id} не найдена или уже обработана` };
  }

  console.log(`🔐 Заявка ${id}: ${decision} (решил ${decidedBy})`);
  return { ok: true, request };
}

/**
 * Есть ли одобренная заявка на действие с объектом.
 * Используется клиентом MODX перед выполнением защищённого действия.
 */
async function findApproved(kind, target) {
  const connection = await db.getDb();
  return connection.collection(COLLECTION).findOne({
    kind,
    target: String(target),
    status: 'approved',
  });
}

/** Одобренная заявка «сгорает» после использования — повторного права не даёт. */
async function consume(id) {
  const connection = await db.getDb();
  await connection
    .collection(COLLECTION)
    .updateOne({ id: String(id), status: 'approved' }, { $set: { status: 'consumed', consumedAt: new Date() } });
}

module.exports = { createRequest, get, listPending, listRecent, decide, findApproved, consume, KINDS, COLLECTION };
