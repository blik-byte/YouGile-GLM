// lib/leads-store.js
// Хранилище заказов с площадок и выборки для API.
//
// Оценка считается движком правил (lib/rules.js) и пишется в документ вместе
// с версией правил: так пересчёт истории остаётся проверяемым, а интерфейс
// показывает те же цифры, что и сервер.

'use strict';

const db = require('../db');
const rules = require('./rules');

const COLLECTION = 'leads';

/**
 * Сохраняет заказы: обновляет текст и оценку, но не трогает статус,
 * заметку и черновик — их мог уже изменить владелец.
 * @returns {Promise<{added:number, updated:number}>}
 */
async function saveLeads(leads, { rulesConfig } = {}) {
  const database = await db.getDb();
  const collection = database.collection(COLLECTION);
  const config = rulesConfig || rules.loadRules();

  let added = 0;
  let updated = 0;

  for (const lead of leads) {
    const scored = rules.scoreOrder(lead, config);
    const now = new Date();

    const doc = {
      source: lead.source,
      externalId: String(lead.externalId),
      title: lead.title,
      description: lead.description || '',
      category: lead.category || '',
      budget: lead.budget || '',
      budgetValue: lead.budgetValue || 0,
      budgetKind: lead.budgetKind || 'fixed',
      url: lead.url,
      projectUrl: lead.projectUrl || lead.url,
      buyer: lead.buyer || '',
      responses: lead.responses,
      employment: lead.employment || 'one_time',
      publishedAt: lead.publishedAt || null,
      verdict: scored.verdict,
      score: scored.score,
      priority: scored.priority,
      reasons: scored.reasons,
      components: scored.components,
      rulesVersion: scored.rulesVersion,
      serviceType: scored.serviceType,
      fetchedAt: now,
    };

    const result = await collection.updateOne(
      { source: doc.source, externalId: doc.externalId },
      {
        $set: { ...doc, updatedAt: now },
        $setOnInsert: { status: 'new', draft: '', notes: '', firstSeenAt: now },
      },
      { upsert: true }
    );

    if (result.upsertedCount) added += 1;
    else updated += 1;
  }

  return { added, updated };
}

/** Список для API: фильтры, сортировка, пагинация. */
async function listLeads({ verdict, status, source, q, sort = 'priority', limit = 20, offset = 0 } = {}) {
  const database = await db.getDb();
  const filterDoc = {};

  if (verdict && verdict !== 'all') filterDoc.verdict = verdict;
  if (status && status !== 'all') filterDoc.status = status;
  if (source && source !== 'all') filterDoc.source = source;
  if (q) filterDoc.title = { $regex: String(q).slice(0, 80), $options: 'i' };

  const sortDoc =
    sort === 'fresh' ? { publishedAt: -1 } : sort === 'budget' ? { budgetValue: -1 } : { priority: -1 };

  const items = await database
    .collection(COLLECTION)
    .find(filterDoc)
    .sort(sortDoc)
    .skip(Number(offset) || 0)
    .limit(Math.min(Number(limit) || 20, 100))
    .toArray();

  const total = await database.collection(COLLECTION).countDocuments(filterDoc);
  return { items, total };
}

/** Смена статуса, заметка, черновик. */
async function updateLead(id, patch = {}) {
  const database = await db.getDb();
  const allowed = {};

  const statuses = ['new', 'viewed', 'applied', 'replied', 'rejected', 'archived'];
  if (statuses.includes(patch.status)) allowed.status = patch.status;
  if (patch.notes !== undefined) allowed.notes = String(patch.notes).slice(0, 2000);
  if (patch.draft !== undefined) allowed.draft = String(patch.draft).slice(0, 4000);

  if (Object.keys(allowed).length === 0) throw new Error('Нечего менять');
  allowed.updatedAt = new Date();

  const { ObjectId } = require('mongodb');
  const result = await database
    .collection(COLLECTION)
    .updateOne({ _id: new ObjectId(id) }, { $set: allowed });

  if (!result.matchedCount) throw new Error('Заказ не найден');
  return { matched: result.matchedCount, updated: result.modifiedCount };
}

/** Счётчики для шапки и вкладок. */
async function leadsStats({ now = new Date() } = {}) {
  const database = await db.getDb();
  const collection = database.collection(COLLECTION);
  const dayAgo = new Date(now.getTime() - 86400000);

  const [total, fresh, accept, unknown, reject, applied] = await Promise.all([
    collection.countDocuments({}),
    collection.countDocuments({ publishedAt: { $gte: dayAgo } }),
    collection.countDocuments({ verdict: 'accept' }),
    collection.countDocuments({ verdict: 'unknown' }),
    collection.countDocuments({ verdict: 'reject' }),
    collection.countDocuments({ status: { $in: ['applied', 'replied'] } }),
  ]);

  return { total, fresh, accept, unknown, reject, applied };
}

module.exports = { COLLECTION, saveLeads, listLeads, updateLead, leadsStats };
