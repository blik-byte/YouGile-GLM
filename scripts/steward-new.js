#!/usr/bin/env node
/**
 * scripts/steward-new.js
 * Быстрое создание структуры в YouGile из короткого описания.
 *
 * Зачем: диспетчеру в чате не нужно собирать полный план с досками и колонками.
 * Достаточно файла вида:
 *
 * {
 *   "project": { "title": "Редизайн цветочного магазина" },
 *   "board": { "title": "Задачи", "columns": ["Входящие", "В работе", "На проверку", "Готово"] },
 *   "tasks": [
 *     { "title": "Собрать семантику", "column": "Входящие", "checklist": ["Ядро", "Кластеры"] }
 *   ]
 * }
 *
 * Всё, что не указано, подставляется само: доска «Задачи», четыре колонки,
 * задача попадает в первую колонку. Дальше вызывается тот же механизм, что
 * и у плана, — повторный запуск не создаёт дублей.
 *
 * Использование:
 *   node scripts/steward-new.js --plan plans/new-project.json
 *   node scripts/steward-new.js --plan task.json --dry-run
 */

'use strict';

try {
  require('dotenv').config();
} catch (error) {
  /* dotenv необязателен */
}

const fs = require('fs');
const path = require('path');
const admin = require('../lib/yougile-admin');

const DEFAULT_COLUMNS = ['Входящие', 'В работе', 'На проверку', 'Готово'];

function parseArgs(argv) {
  const args = { plan: null, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run' || arg === '-n') args.dryRun = true;
    else if (arg === '--plan' || arg === '-p') {
      args.plan = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--plan=')) args.plan = arg.slice('--plan='.length);
  }
  return args;
}

/** Превращает короткое описание в полный план, который понимает applyPlan. */
function expandCompact(input) {
  if (!input || !input.project || !input.project.title) {
    throw new Error('Нужен объект project с полем title');
  }

  const boardTitle = (input.board && input.board.title) || 'Задачи';
  const columns = (input.board && input.board.columns) || DEFAULT_COLUMNS;
  const tasks = Array.isArray(input.tasks) ? input.tasks : [];

  const prepared = tasks.map((task, index) => {
    if (!task || !task.title) throw new Error(`Задача #${index + 1}: нужно поле title`);
    return {
      code: task.code || `T-${index + 1}`,
      column: task.column || columns[0],
      title: task.title,
      description: task.description || '',
      checklist: task.checklist || [],
      assignees: task.assignees || [],
    };
  });

  const usedColumns = [...columns];
  for (const task of prepared) {
    if (!usedColumns.includes(task.column)) usedColumns.push(task.column);
  }

  return {
    project: { title: input.project.title, description: input.project.description || '' },
    boards: [
      {
        title: boardTitle,
        columns: usedColumns.map((title) => ({ title })),
        tasks: prepared,
      },
    ],
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.plan) {
    console.error('Использование: node scripts/steward-new.js --plan <файл.json> [--dry-run]');
    process.exit(1);
  }

  const file = path.resolve(args.plan);
  if (!fs.existsSync(file)) {
    console.error(`❌ Файл не найден: ${file}`);
    process.exit(1);
  }

  const input = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const plan = expandCompact(input);

  console.log(`📦 Проект: ${plan.project.title}`);
  console.log(`📋 Доска: ${plan.boards[0].title}, колонок ${plan.boards[0].columns.length}, задач ${plan.boards[0].tasks.length}`);
  if (args.dryRun) console.log('🔍 Режим проверки: в YouGile ничего не пишется\n');

  const stats = await admin.applyPlan(plan, { dryRun: args.dryRun });

  console.log('\nИтог:');
  console.log(`  проект ${stats.project.created ? 'создан' : 'уже был'} — ${stats.project.id || '(будет создан)'}`);
  console.log(`  досок: создано ${stats.boards.created}, было ${stats.boards.existing}`);
  console.log(`  колонок: создано ${stats.columns.created}, было ${stats.columns.existing}`);
  console.log(`  задач: создано ${stats.tasks.created}, обновлено ${stats.tasks.updated}, без изменений ${stats.tasks.skipped}`);

  if (stats.errors.length) {
    console.log(`\n⚠️ Ошибки (${stats.errors.length}):`);
    for (const message of stats.errors.slice(0, 10)) console.log(`  - ${message}`);
    process.exitCode = 1;
  } else {
    console.log('\n✅ Готово');
  }

  if (stats.project.id) {
    console.log(`\nСсылка: https://ru.yougile.com/team/${process.env.YOUGILE_TEAM_ID || ''}#!/projects/${stats.project.id}`);
  }
}

main().catch((error) => {
  console.error(`\n💥 ${error.message}`);
  if (process.env.DEBUG) console.error(error.stack);
  process.exit(1);
});
