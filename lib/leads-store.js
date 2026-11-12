// lib/leads-store.js
// Хранилище заказов с разных площадок: FL.ru, Kwork и следующие.
//
// Одна коллекция `leads`, ключ уникальности — площадка + внешний id.
// Повторный сбор обновляет текст и бюджет, но не сбрасывает статус и черновик:
// владелец мог уже отметить «откликнулся» или поправить письмо.

'use strict';

const db = require('../db');
const filter = require('./kwork-filter');

const COLLECTION = 'leads';

/** Приоритет 0–100: тип работ, бюджет, свежесть, история покупателя. */
function scoreLead({ labels = [], budgetValue = 0, publishedAt, buyerReplyRate = 0 }) {
  let score = 0;

  const typeWeight = { 'SEO': 20, 'продвижение': 20, 'аудит': 15, 'юзабилити': 10, 'ссылочная масса': 10 };
  for (const label of labels) score += typeWeight[label] || 5;
  score = Math.min(40, score);

  if (budgetValue >= 30000) score += 30;
  else if (budgetValue >= 15000) score += 20;
  else if (budgetValue >= 5000) score += 10;

  if (publishedAt) {
    const days = (Date.now() - new Date(publishedAt).getTime()) / 86400000;
    if (days <= 1) score += 20;
    else if (days <= 3) score += 10;
  }

  if (buyerReplyRate > 30) score += 10;

  return Math.min(100, score);
}

/**
 * Сохраняет заказы. Возвращает, сколько добавлено и сколько уже было.
 * @param {Array<object>} leads
 */
async function saveLeads(leads, { rules } = {}) {
  const database = await db.getDb();
  const collection = database.collection(COLLECTION);
  const filters = rules || filter.loadFilters();

  let added = 0;
  let updated = 0;

  for (const lead of leads) {
    const verdict = filter.classifyOrder(
      { title: lead.title, category: lead.category || '', description: lead.description || '' },
      filters
    );
    const now = new Date();

    const doc = {
      source: lead.source,
      externalId: String(lead.externalId),
      title: lead.title,
      description: lead.description || '',
      category: lead.category || '',
      budget: lead.budget || '',
      budgetValue: lead.budgetValue || 0,
      url: lead.url,
      projectUrl: lead.projectUrl || lead.url,
      buyer: lead.buyer || '',
      publishedAt: lead.publishedAt || null,
      verdict: verdict.verdict,
      verdictReason: verdict.reason || (verdict.labels || []).join(', '),
      labels: verdict.labels || [],
      score: scoreLead({
        labels: verdict.labels || [],
        budgetValue: lead.budgetValue || 0,
        publishedAt: lead.publishedAt,
      }),
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

module.exports = { COLLECTION, scoreLead, saveLeads };
