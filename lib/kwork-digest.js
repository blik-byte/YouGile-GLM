// lib/kwork-digest.js
// Очередь проектов Kwork и сборка дайджеста для Telegram.
//
// Проекты складываются в MongoDB: письмо приходит в любое время, а дайджест
// уходит раз в час. Перезапуск Render не должен терять уже разобранные письма,
// поэтому хранилище, а не память процесса.
//
// Дубликаты отсекаются по номеру проекта Kwork: одно письмо может прийти
// дважды (пересылка, повторная доставка), проект должен остаться один.

'use strict';

const db = require('../db');
const filter = require('./kwork-filter');
const reply = require('./kwork-reply');

const COLLECTION = 'kwork_projects';

/** «30 000 Р» → 30000. Для сортировки и пометок. */
function parsePrice(value) {
  const digits = String(value || '').replace(/[^\d]/g, '');
  return digits ? Number(digits) : 0;
}

function markOf(verdict) {
  if (verdict === 'accept') return '✅';
  if (verdict === 'reject') return '⛔';
  return '❔';
}

/**
 * Складывает проекты в очередь. Повторные не дублируются.
 * @returns {Promise<{added: number, skipped: number}>}
 */
async function saveProjects(projects, { rules } = {}) {
  const database = await db.getDb();
  const collection = database.collection(COLLECTION);
  const filters = rules || filter.loadFilters();

  let added = 0;
  let skipped = 0;

  for (const project of projects) {
    const verdict = filter.classify(`${project.title} ${project.category || ''}`, filters);
    const doc = {
      projectId: String(project.id),
      title: project.title,
      category: project.category || '',
      price: project.price || '',
      priceValue: parsePrice(project.price),
      buyer: project.buyer || '',
      url: project.url,
      projectUrl: project.projectUrl,
      verdict: verdict.verdict,
      labels: verdict.labels,
      reason: verdict.reason,
      status: 'new',
      createdAt: new Date(),
    };

    const result = await collection.updateOne(
      { projectId: doc.projectId },
      { $setOnInsert: doc },
      { upsert: true }
    );

    if (result.upsertedCount) added += 1;
    else skipped += 1;
  }

  return { added, skipped };
}

/** Забирает неотправленные проекты, свежие сверху по цене. */
async function takePending(limit = 30) {
  const database = await db.getDb();
  const items = await database
    .collection(COLLECTION)
    .find({ status: 'new' })
    .sort({ priceValue: -1, createdAt: 1 })
    .limit(limit)
    .toArray();
  return items;
}

async function markSent(projectIds) {
  if (!projectIds.length) return 0;
  const database = await db.getDb();
  const result = await database
    .collection(COLLECTION)
    .updateMany({ projectId: { $in: projectIds.map(String) } }, { $set: { status: 'sent', sentAt: new Date() } });
  return result.modifiedCount;
}

function formatProject(item) {
  const parts = [`${markOf(item.verdict)} <b>${escape(item.title)}</b>`, `💰 ${escape(item.price || 'цена не указана')}`];
  if (item.category) parts.push(`🗂 ${escape(item.category)}`);
  if (item.verdict === 'reject' && item.reason) parts.push(`⛔ ${escape(item.reason)}`);
  if (item.projectUrl) parts.push(`🔗 ${escape(item.projectUrl)}`);
  return parts.join('\n');
}

function escape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Собирает сообщения дайджеста: один список + отдельные сообщения с черновиками.
 * @returns {Array<string>}
 */
function buildDigest(items, { replies } = {}) {
  if (!items || items.length === 0) return [];

  const templates = replies || reply.loadReplies();
  const accepted = items.filter((item) => item.verdict === 'accept');
  const messages = [];

  const header = `🧾 <b>Kwork: ${items.length} ${projectWord(items.length)}</b>`;
  const list = items.map(formatProject).join('\n\n');
  messages.push(`${header}\n\n${list}`);

  for (const item of accepted) {
    const draft = reply.buildReply(item.title, { replies: templates });
    messages.push(
      `✍️ <b>Черновик отклика</b>\n${escape(item.title)}\n${escape(item.projectUrl || '')}\n\n<pre>${escape(draft.text)}</pre>`
    );
  }

  return messages;
}

function projectWord(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'новый проект';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'новых проекта';
  return 'новых проектов';
}

/**
 * Отправка дайджеста по таймеру.
 * Интервал настраивается: KWORK_DIGEST_INTERVAL_MS (по умолчанию 3600000 — раз в час).
 */
function startDigest({ notify, intervalMs, logger = console } = {}) {
  const period = Number(intervalMs || process.env.KWORK_DIGEST_INTERVAL_MS || 3600000);
  if (!period || period < 60000) {
    logger.log('ℹ️ Kwork-дайджест: отправка отключена (KWORK_DIGEST_INTERVAL_MS)');
    return null;
  }

  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const items = await takePending();
      if (items.length === 0) return;

      for (const message of buildDigest(items)) {
        await notify(message);
      }
      await markSent(items.map((item) => item.projectId));
      logger.log(`🧾 Kwork-дайджест: отправлено проектов ${items.length}`);
    } catch (error) {
      logger.warn(`⚠️ Kwork-дайджест: ${error.message}`);
    } finally {
      busy = false;
    }
  }, period);

  if (timer.unref) timer.unref();
  logger.log(`🧾 Kwork-дайджест: каждые ${Math.round(period / 60000)} мин`);
  return timer;
}

module.exports = {
  COLLECTION,
  parsePrice,
  saveProjects,
  takePending,
  markSent,
  buildDigest,
  formatProject,
  startDigest,
};
