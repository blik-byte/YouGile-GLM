#!/usr/bin/env node
// scripts/check.js
// Быстрая самопроверка проекта: синтаксис всех файлов + загрузка безопасных модулей.
// Запуск: npm run check

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP_REQUIRE = new Set(['index.js']); // запускает сервер — не грузим

function listJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = listJsFiles(ROOT);
let failed = 0;

console.log(`🔍 Проверяю синтаксис ${files.length} файлов...\n`);

for (const file of files) {
  const rel = path.relative(ROOT, file);
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    console.log(`  ✅ ${rel}`);
  } catch (error) {
    failed++;
    console.log(`  ❌ ${rel}`);
    console.log(String(error.stderr || error.message).split('\n').slice(0, 6).map((l) => `     ${l}`).join('\n'));
  }
}

console.log('\n🔍 Проверяю загрузку модулей...\n');

// Минимальное окружение, чтобы модули не падали на отсутствии переменных
process.env.MONGODB_URI ||= 'mongodb://localhost:27017';
process.env.ZAI_API_KEY ||= 'test';
process.env.YOUGILE_API_KEY ||= 'test';

for (const file of files) {
  const rel = path.relative(ROOT, file);
  if (SKIP_REQUIRE.has(rel) || rel.startsWith('scripts')) continue;

  try {
    require(file);
    console.log(`  ✅ ${rel}`);
  } catch (error) {
    failed++;
    console.log(`  ❌ ${rel}: ${error.message.split('\n')[0]}`);
  }
}

console.log(failed === 0 ? '\n✅ Все проверки пройдены' : `\n❌ Проблем: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
