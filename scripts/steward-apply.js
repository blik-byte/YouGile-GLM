#!/usr/bin/env node
/**
 * scripts/steward-apply.js
 * Применяет план из plans/*.json к живой доске YouGile.
 *
 * Использование:
 *   node scripts/steward-apply.js                      # план по умолчанию, запись
 *   node scripts/steward-apply.js --dry-run            # только показать, что изменится
 *   node scripts/steward-apply.js --plan other.json    # другой файл из plans/
 *
 * Отличия от scripts/seed-board.js: обновляет существующие задачи (описание,
 * чек-лист, исполнитель), а не только создаёт отсутствующие; маркер плана
 * хранится HTML-комментарием и не виден в карточке.
 */

'use strict';

try {
  require('dotenv').config();
} catch (error) {
  /* dotenv необязателен */
}

const path = require('path');
const admin = require('../lib/yougile-admin');

function parseArgs(argv) {
  const args = { plan: 'ai-agents-yg.json', dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run' || arg === '-n') args.dryRun = true;
    else if (arg === '--plan' || arg === '-p') {
      args.plan = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--plan=')) args.plan = arg.slice('--plan='.length);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const plan = admin.loadPlan(args.plan);

  console.log(`📜 План: ${path.basename(args.plan)} — версия ${plan.meta?.version || '?'}, проект «${plan.project.title}»`);
  if (args.dryRun) console.log('🔍 Режим проверки: в YouGile ничего не пишется\n');

  const stats = await admin.applyPlan(plan, { dryRun: args.dryRun });

  console.log(`\n📦 Проект: ${stats.project.title}`);
  console.log(`   досок создано:    ${stats.boards.created}, уже было: ${stats.boards.existing}`);
  console.log(`   колонок создано:  ${stats.columns.created}, уже было: ${stats.columns.existing}`);
  console.log(`   задач создано:    ${stats.tasks.created}`);
  console.log(`   задач обновлено:  ${stats.tasks.updated}`);
  console.log(`   задач без изменений: ${stats.tasks.skipped}`);

  if (stats.errors.length) {
    console.log(`\n⚠️ Ошибок: ${stats.errors.length}`);
    for (const message of stats.errors.slice(0, 20)) console.log(`   - ${message}`);
    process.exitCode = 1;
  } else {
    console.log('\n✅ Готово без ошибок');
  }
}

main().catch((error) => {
  console.error(`\n💥 ${error.message}`);
  if (process.env.DEBUG) console.error(error.stack);
  process.exit(1);
});
