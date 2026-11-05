#!/usr/bin/env node
/**
 * scripts/seed-board.js
 * Создаёт в YouGile проект "AI агенты и YG" по плану из plans/ai-agents-yg.json.
 *
 * Использование:
 *   YOUGILE_API_KEY=... node scripts/seed-board.js
 *   или переменные из .env (если dotenv подключен)
 *
 * Идемпотентно: повторный запуск пропустит уже существующие сущности
 * (поиск по полю code в description задачи и по title проекта/доски/колонки).
 *
 * Учитывает rate-limit YouGile API (50 req/min) - паузы между запросами.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Загрузка .env если есть
try { require('dotenv').config(); } catch (e) { /* ok */ }

const API_KEY = process.env.YOUGILE_API_KEY || process.env.YOUGILE_GLM_API_KEY;
const API_BASE = process.env.YOUGILE_API_BASE || 'https://yougile.com/api-v2';
const PLAN_FILE = process.env.PLAN_FILE || path.join(__dirname, '..', 'plans', 'ai-agents-yg.json');

if (!API_KEY) {
  console.error('❌ YOUGILE_API_KEY не задан. Укажи через переменные окружения или .env');
  process.exit(1);
}

// --- HTTP клиент с таймаутами и ретраями ---
const HTTP_TIMEOUT = 30000;
const RATE_LIMIT_PAUSE = 1300; // ~50 req/min, берём с запасом
const MAX_RETRIES = 3;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function yougileRequest(method, endpoint, body = null, attempt = 1) {
  const url = `${API_BASE}${endpoint}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT);

  try {
    const opts = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      signal: controller.signal
    };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(url, opts);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }

    if (res.status === 429 && attempt <= MAX_RETRIES) {
      const wait = Math.min(60000, 5000 * attempt);
      console.log(`   ⏳ Rate limit, жду ${wait}мс (попытка ${attempt})`);
      await sleep(wait);
      return yougileRequest(method, endpoint, body, attempt + 1);
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${method} ${endpoint}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError' && attempt <= MAX_RETRIES) {
      console.log(`   ⏳ Timeout, повторяю (попытка ${attempt})`);
      await sleep(2000 * attempt);
      return yougileRequest(method, endpoint, body, attempt + 1);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// --- Загрузка и валидация плана ---
function loadPlan() {
  if (!fs.existsSync(PLAN_FILE)) {
    throw new Error(`План не найден: ${PLAN_FILE}`);
  }
  const raw = fs.readFileSync(PLAN_FILE, 'utf8');
  const plan = JSON.parse(raw);
  if (!plan.project || !plan.boards || !Array.isArray(plan.boards)) {
    throw new Error('Неверная структура плана: нужны project и boards[]');
  }
  return plan;
}

// --- Поиск существующих сущностей ---
async function findProject(title) {
  const list = await yougileRequest('GET', '/projects');
  const items = Array.isArray(list) ? list : (list.items || []);
  return items.find(p => p.title === title) || null;
}

async function findBoard(projectId, title) {
  const list = await yougileRequest('GET', `/boards?projectId=${projectId}`);
  const items = Array.isArray(list) ? list : (list.items || []);
  return items.find(b => b.title === title) || null;
}

async function findColumn(boardId, title) {
  const list = await yougileRequest('GET', `/columns?boardId=${boardId}`);
  const items = Array.isArray(list) ? list : (list.items || []);
  return items.find(c => c.title === title) || null;
}

async function findTaskByCode(columnId, code) {
  // Пагинация: берём до 100 задач
  const list = await yougileRequest('GET', `/tasks?columnId=${columnId}&limit=100`);
  const items = Array.isArray(list) ? list : (list.items || []);
  const marker = `[plan:${code}]`;
  return items.find(t => t.description && t.description.startsWith(marker)) || null;
}

// --- Основные операции ---
async function createProject(title, description) {
  console.log(`📦 Создаю проект: ${title}`);
  const data = await yougileRequest('POST', '/projects', { title, description: description || '' });
  const id = data.id || data;
  console.log(`   ✅ Проект создан, id=${id}`);
  await sleep(RATE_LIMIT_PAUSE);
  return id;
}

async function createBoard(projectId, title) {
  console.log(`📋 Создаю доску: ${title}`);
  const data = await yougileRequest('POST', '/boards', { projectId, title });
  const id = data.id || data;
  console.log(`   ✅ Доска создана, id=${id}`);
  await sleep(RATE_LIMIT_PAUSE);
  return id;
}

async function createColumn(boardId, title, color) {
  console.log(`  📊 Создаю колонку: ${title} (${color || 'default'})`);
  const body = { boardId, title };
  if (color) body.color = color;
  const data = await yougileRequest('POST', '/columns', body);
  const id = data.id || data;
  console.log(`   ✅ Колонка создана, id=${id}`);
  await sleep(RATE_LIMIT_PAUSE);
  return id;
}

async function createTask(columnId, task) {
  const marker = `[plan:${task.code}]`;
  const description = `${marker}\n\n${task.description || ''}`;

  const body = { columnId, title: task.title, description };
  // Чек-листы, если поддерживаются в create: добавим через update ниже

  console.log(`    ✏️  Создаю задачу: ${task.code} — ${task.title}`);
  const data = await yougileRequest('POST', '/tasks', body);
  const id = data.id || data;

  // Добавляем чек-лист через update (если элементы переданы)
  if (Array.isArray(task.checklist) && task.checklist.length > 0) {
    try {
      // Пробуем разные варианты API - YouGile имеет разные версии
      const checkListItems = task.checklist.map(item => ({ title: String(item), isChecked: false }));
      // Вариант 1: PUT /tasks/{id} с checkListItems
      await yougileRequest('PUT', `/tasks/${id}`, { checkListItems });
    } catch (e) {
      console.log(`   ⚠️  Не удалось добавить чек-лист к ${task.code}: ${e.message}`);
    }
  }

  console.log(`   ✅ Задача создана, id=${id}`);
  await sleep(RATE_LIMIT_PAUSE);
  return id;
}

// --- Главный сценарий ---
async function main() {
  const plan = loadPlan();
  console.log(`\n📜 Загружен план: версия ${plan.meta?.version || '?'}, ${plan.project.title}\n`);

  const stats = { projects: 0, boards: 0, columns: 0, tasks: 0, skipped: 0, errors: 0 };

  // 1. Проект
  let project = await findProject(plan.project.title);
  if (!project) {
    try {
      const projectId = await createProject(plan.project.title, plan.project.description);
      project = { id: projectId, title: plan.project.title };
      stats.projects++;
    } catch (e) {
      console.error(`❌ Ошибка создания проекта: ${e.message}`);
      process.exit(1);
    }
  } else {
    console.log(`📦 Проект уже есть: ${project.title} (id=${project.id})`);
    stats.skipped++;
  }

  // 2. Для каждой доски
  for (const boardSpec of plan.boards) {
    let board = await findBoard(project.id, boardSpec.title);
    if (!board) {
      try {
        const boardId = await createBoard(project.id, boardSpec.title);
        board = { id: boardId, title: boardSpec.title };
        stats.boards++;
      } catch (e) {
        console.error(`❌ Ошибка создания доски: ${e.message}`);
        continue;
      }
    } else {
      console.log(`📋 Доска уже есть: ${board.title} (id=${board.id})`);
      stats.skipped++;
    }

    // 3. Колонки
    const columnMap = {};
    for (const colSpec of boardSpec.columns) {
      let col = await findColumn(board.id, colSpec.title);
      if (!col) {
        try {
          const colId = await createColumn(board.id, colSpec.title, colSpec.color);
          col = { id: colId, title: colSpec.title };
          stats.columns++;
        } catch (e) {
          console.error(`  ❌ Ошибка создания колонки ${colSpec.title}: ${e.message}`);
          stats.errors++;
          continue;
        }
      } else {
        console.log(`  📊 Колонка уже есть: ${col.title} (id=${col.id})`);
        stats.skipped++;
      }
      columnMap[colSpec.title] = col.id;
    }

    // 4. Задачи
    for (const taskSpec of boardSpec.tasks) {
      const colId = columnMap[taskSpec.column];
      if (!colId) {
        console.log(`    ⚠️  Пропуск ${taskSpec.code}: нет колонки "${taskSpec.column}"`);
        stats.errors++;
        continue;
      }

      try {
        const existing = await findTaskByCode(colId, taskSpec.code);
        if (existing) {
          console.log(`    ✏️  Задача уже есть: ${taskSpec.code} (id=${existing.id})`);
          stats.skipped++;
          await sleep(RATE_LIMIT_PAUSE);
          continue;
        }
        await createTask(colId, taskSpec);
        stats.tasks++;
      } catch (e) {
        console.log(`    ❌ Ошибка создания ${taskSpec.code}: ${e.message}`);
        stats.errors++;
      }
    }
  }

  console.log('\n📊 Итого:');
  console.log(`   Проектов создано: ${stats.projects}`);
  console.log(`   Досок создано:    ${stats.boards}`);
  console.log(`   Колонок создано:  ${stats.columns}`);
  console.log(`   Задач создано:    ${stats.tasks}`);
  console.log(`   Пропущено:        ${stats.skipped}`);
  console.log(`   Ошибок:           ${stats.errors}`);
  console.log('\n🎉 Готово! Открывай YouGile и проверяй проект "AI агенты и YG".');
}

main().catch(err => {
  console.error('\n💥 Фатальная ошибка:', err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
