#!/usr/bin/env node
// scripts/test-fixes.js
// Регрессионные тесты на исправленные баги. Запуск: npm test
// Не требуют MongoDB и внешних API — проверяют чистую логику.

require('dotenv').config({ quiet: true });

const assert = require('assert');

const results = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push({ name, ok: true });
      console.log(`  ✅ ${name}`);
    })
    .catch((error) => {
      results.push({ name, ok: false, error });
      console.log(`  ❌ ${name}`);
      console.log(`     ${error.message.split('\n')[0]}`);
    });
}

async function main() {
  console.log('\n🧪 Регрессионные тесты исправленных багов\n');

  const { escapeHtml, textToHtml, sanitizeFilename, truncate, truncateJsonSafe } = require('../lib/text');
  const { withRetry } = require('../lib/http');
  const { trimMessages } = require('../lib/glm-client');
  const { getPromptForTask } = require('../prompts');

  /* ---------------- H5: экранирование HTML ---------------- */

  await test('H5 escapeHtml: спецсимволы экранируются', () => {
    assert.strictEqual(escapeHtml('<b>&"\'</b>'), '&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;');
    assert.strictEqual(escapeHtml(null), '');
    assert.strictEqual(escapeHtml(undefined), '');
    assert.strictEqual(escapeHtml(42), '42');
  });

  await test('H5 textToHtml: переносы строк становятся <br> после экранирования', () => {
    assert.strictEqual(textToHtml('a<b\nc'), 'a&lt;b<br>c');
  });

  await test('H5 escapeHtml: текст задачи с "<" не ломает Telegram HTML', () => {
    const title = 'Сравнить цены <5000р & акции';
    const message = `✅ <b>Задача выполнена</b>\n📝 ${escapeHtml(title)}`;
    assert.ok(!message.includes('<5000'));
    assert.ok(message.includes('&lt;5000'));
    assert.ok(message.includes('&amp;'));
  });

  /* ---------------- M9: санитизация имён файлов ---------------- */

  await test('M9 sanitizeFilename: path traversal нейтрализован', () => {
    assert.strictEqual(sanitizeFilename('../../etc/passwd'), 'passwd');
    assert.strictEqual(sanitizeFilename('/etc/cron.d/x'), 'x');
    assert.strictEqual(sanitizeFilename('..\\..\\windows\\x'), 'x');
    assert.ok(!sanitizeFilename('..\\..\\x').includes('..'));
  });

  await test('M9 sanitizeFilename: недопустимые символы и пустое имя', () => {
    // '/' — разделитель пути, поэтому берётся только последняя часть
    assert.strictEqual(sanitizeFilename('отчёт: v1/финал*'), 'финал_');
    assert.strictEqual(sanitizeFilename('отчёт: v1*финал?'), 'отчёт_ v1_финал_');
    assert.strictEqual(sanitizeFilename(''), 'document');
    assert.strictEqual(sanitizeFilename('   '), 'document');
    assert.strictEqual(sanitizeFilename('...'), 'document');
    assert.ok(sanitizeFilename('a'.repeat(500)).length <= 120);
  });

  /* ---------------- M28: обрезка без разрыва JSON ---------------- */

  await test('M28 truncateJsonSafe: результат всегда валидный JSON', () => {
    const big = { items: Array.from({ length: 500 }, (_, i) => `элемент ${i} ${'x'.repeat(200)}`) };
    const out = truncateJsonSafe(big, 3000);
    assert.doesNotThrow(() => JSON.parse(out));
    assert.ok(out.length <= 3200, `длина ${out.length} больше лимита`);
  });

  await test('M28 truncateJsonSafe: короткие объекты не меняются', () => {
    const small = { success: true, id: '123' };
    assert.deepStrictEqual(JSON.parse(truncateJsonSafe(small)), small);
  });

  await test('truncate: пометка об обрезке', () => {
    const out = truncate('abcdefghij', 6, '…');
    assert.ok(out.endsWith('…'));
    assert.ok(out.length <= 6);
    assert.strictEqual(truncate('abc', 10), 'abc');
  });

  /* ---------------- C5: задержка ретрая не равна нулю ---------------- */

  await test('C5 withRetry: первая задержка больше нуля', async () => {
    const timestamps = [];
    let calls = 0;

    const started = Date.now();
    await withRetry({
      retries: 2,
      baseDelay: 300,
      fn: async () => {
        timestamps.push(Date.now() - started);
        calls++;
        if (calls < 3) {
          const error = new Error('429');
          error.status = 429;
          throw error;
        }
        return 'ok';
      },
    });

    assert.strictEqual(calls, 3);
    // Ключевая проверка: между 1-й и 2-й попыткой прошла РЕАЛЬНАЯ пауза,
    // а не 0 мс, как было при `30000 * retryCount` с retryCount === 0
    const firstGap = timestamps[1] - timestamps[0];
    const secondGap = timestamps[2] - timestamps[1];
    assert.ok(firstGap >= 290, `первая пауза ${firstGap}мс — должна быть >= 290мс`);
    assert.ok(secondGap > firstGap, `вторая пауза ${secondGap}мс должна быть больше первой ${firstGap}мс`);
  });

  await test('C5 withRetry: 4xx (кроме 429) не повторяется', async () => {
    let calls = 0;
    await withRetry({
      retries: 3,
      baseDelay: 10,
      fn: async () => {
        calls++;
        const error = new Error('400 Bad Request');
        error.status = 400;
        throw error;
      },
    }).catch(() => {});
    assert.strictEqual(calls, 1, 'при 400 повтор бессмысленен');
  });

  await test('C5 withRetry: Retry-After учитывается', async () => {
    let calls = 0;
    const started = Date.now();
    await withRetry({
      retries: 1,
      baseDelay: 10,
      fn: async () => {
        calls++;
        if (calls === 1) {
          const error = new Error('429');
          error.status = 429;
          error.retryAfterSec = 1;
          throw error;
        }
        return 'ok';
      },
    });
    assert.ok(Date.now() - started >= 950, 'должны были подождать ~1с из Retry-After');
  });

  /* ---------------- M8: обрезка контекста ---------------- */

  await test('M8 trimMessages: system и последнее сообщение сохраняются', () => {
    const messages = [
      { role: 'system', content: 'SYSTEM PROMPT' },
      ...Array.from({ length: 40 }, (_, i) => ({ role: 'user', content: `сообщение ${i} ${'x'.repeat(4000)}` })),
      { role: 'assistant', content: 'ПОСЛЕДНИЙ ОТВЕТ' },
    ];

    const { messages: trimmed, trimmed: count } = trimMessages(messages, 20000);

    assert.ok(count > 0, 'часть истории должна быть отброшена');
    assert.strictEqual(trimmed[0].role, 'system');
    assert.strictEqual(trimmed[0].content, 'SYSTEM PROMPT');
    assert.strictEqual(trimmed[trimmed.length - 1].content, 'ПОСЛЕДНИЙ ОТВЕТ');
  });

  await test('M8 trimMessages: короткая история не меняется', () => {
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'привет' },
    ];
    const { messages: trimmed, trimmed: count } = trimMessages(messages, 90000);
    assert.strictEqual(count, 0);
    assert.strictEqual(trimmed.length, 2);
  });

  /* ---------------- C1: промпты реально доступны ---------------- */

  await test('C1 getPromptForTask: SEO-задача получает SEO-промпт', () => {
    const prompt = getPromptForTask('Проведи SEO-аудит сайта example.ru', '');
    assert.ok(typeof prompt === 'string' && prompt.length > 100, 'промпт должен быть непустым');
    assert.ok(/seo|аудит|поисков/i.test(prompt), 'промпт должен быть про SEO');
  });

  await test('C1 getPromptForTask: разные типы задач получают разные промпты', () => {
    const seo = getPromptForTask('SEO-аудит сайта', '');
    const competitors = getPromptForTask('Проанализируй конкурентов и сравни цены', '');
    const news = getPromptForTask('Найди новости и тренды рынка', '');

    assert.notStrictEqual(seo, competitors, 'SEO и конкуренты должны различаться');
    assert.notStrictEqual(seo, news, 'SEO и новости должны различаться');
  });

  await test('C1 runAgent объявлена ровно один раз', () => {
    const source = require('fs').readFileSync(require.resolve('../ai-agent.js'), 'utf8');
    const declarations = source.match(/^(async\s+)?function\s+runAgent\s*\(/gm) || [];
    assert.strictEqual(declarations.length, 1, `найдено объявлений runAgent: ${declarations.length}`);
  });

  /* ---------------- C6 / H7: конфигурация ---------------- */

  await test('C6 db.js не создаёт MongoClient при require()', () => {
    const source = require('fs').readFileSync(require.resolve('../db.js'), 'utf8');
    const moduleLevel = source.split('\n').filter((line) => /^const\s+mongoClient\s*=\s*new\s+MongoClient/.test(line));
    assert.strictEqual(moduleLevel.length, 0, 'клиент не должен создаваться на уровне модуля');
  });

  await test('H7 config: YouGile-ключ подхватывается из обоих имён переменных', () => {
    delete require.cache[require.resolve('../lib/config')];
    process.env.YOUGILE_API_KEY = '';
    process.env.YOUGILE_GLM_API_KEY = 'legacy-key';
    const fresh = require('../lib/config');
    assert.strictEqual(fresh.config.yougileApiKey, 'legacy-key');

    delete require.cache[require.resolve('../lib/config')];
    process.env.YOUGILE_API_KEY = 'modern-key';
    const fresh2 = require('../lib/config');
    assert.strictEqual(fresh2.config.yougileApiKey, 'modern-key');

    delete process.env.YOUGILE_API_KEY;
    delete process.env.YOUGILE_GLM_API_KEY;
  });

  await test('H8 partsInTimezone: отчёт считается по часовому поясу, а не UTC', () => {
    const source = require('fs').readFileSync(require.resolve('../index.js'), 'utf8');
    assert.ok(/REPORT_TZ/.test(source), 'должна использоваться переменная REPORT_TZ');
    assert.ok(/Europe\/Moscow/.test(source), 'часовой пояс по умолчанию — Europe/Moscow');

    // Проверяем сам механизм: одно и то же время даёт разный час в разных зонах
    const fixed = new Date('2026-09-30T09:30:00Z');
    const hourIn = (timeZone) =>
      Number(
        new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hour12: false })
          .formatToParts(fixed)
          .find((p) => p.type === 'hour').value
      );
    assert.strictEqual(hourIn('UTC'), 9);
    assert.strictEqual(hourIn('Europe/Moscow'), 12);
  });

  /* ---------------- C4: пароль не логируется ---------------- */

  await test('C4 email-worker не выводит значение пароля в логи', () => {
    const source = require('fs').readFileSync(require.resolve('../email-worker.js'), 'utf8');
    // Опасна именно интерполяция значения (${...password...}), а не упоминание имени переменной
    const leak = /console\.(log|warn|error|info)\([^\n]*\$\{[^}]*(password|passwd|secret|private_key)/i;
    const offenders = source
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => leak.test(line))
      .map(({ n }) => `строка ${n}`);
    assert.deepStrictEqual(offenders, [], `утечка пароля в логи: ${offenders.join(', ')}`);

    // Подтверждаем, что прежний код (первые 5 символов пароля) действительно исчез
    assert.ok(!/MAIL_PASSWORD\?\.substring/.test(source), 'остался вывод первых символов пароля');
    assert.ok(!/MAIL_PASSWORD\?\.length/.test(source), 'остался вывод длины пароля');
  });

  await test('C4 нигде в проекте секреты не интерполируются в console', () => {
    const fs = require('fs');
    const path = require('path');
    const offenders = [];
    const leak = /console\.(log|warn|error|info)\([^\n]*\$\{[^}]*(password|passwd|secret|private_key|api_key|apikey|bot_token|auth_token|authtoken)/i;

    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) {
          fs.readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
            if (leak.test(line)) offenders.push(`${path.relative(process.cwd(), full)}:${i + 1}`);
          });
        }
      }
    };
    walk(process.cwd());
    assert.deepStrictEqual(offenders, [], `возможные утечки секретов в логи: ${offenders.join(', ')}`);
  });

  /* ---------------- C3: обработчик ошибок поллинга ---------------- */

  await test('C3 telegram-bot: есть обработчик polling_error', () => {
    const source = require('fs').readFileSync(require.resolve('../telegram-bot.js'), 'utf8');
    assert.ok(/on\(\s*['"]polling_error['"]/.test(source), 'нет bot.on("polling_error")');
    assert.ok(/on\(\s*['"]error['"]/.test(source), 'нет bot.on("error")');
  });

  await test('C3 index: есть обработчики unhandledRejection и uncaughtException', () => {
    const source = require('fs').readFileSync(require.resolve('../index.js'), 'utf8');
    assert.ok(/unhandledRejection/.test(source));
    assert.ok(/uncaughtException/.test(source));
  });

  /* ---------------- C2: вебхук не блокирует ответ ---------------- */

  await test('C2 index: вебхук отвечает до обработки события', () => {
    const source = require('fs').readFileSync(require.resolve('../index.js'), 'utf8');
    const handler = source.slice(source.indexOf("app.post('/webhook/yougile'"));
    const respondAt = handler.indexOf('res.json');
    const workAt = handler.indexOf('handleChatMessage');
    assert.ok(respondAt > -1 && workAt > -1, 'не найден ответ или обработка');
    assert.ok(respondAt < workAt, 'res.json должен вызываться ДО handleChatMessage');
  });

  /* ---------------- H9: graceful shutdown ---------------- */

  await test('H9 index: обрабатываются SIGTERM и SIGINT', () => {
    const source = require('fs').readFileSync(require.resolve('../index.js'), 'utf8');
    assert.ok(/SIGTERM/.test(source) && /SIGINT/.test(source));
    assert.ok(/shutdown/.test(source));
  });

  /* ---------------- H6: защита эндпоинтов ---------------- */

  await test('H6 index: служебные эндпоинты закрыты requireAdmin', () => {
    const source = require('fs').readFileSync(require.resolve('../index.js'), 'utf8');

    const protectedRoutes = [
      "/task-results/:taskId",
      '/columns',
      '/find-glm-user',
      '/assistant',
      '/process-mail',
      '/db-check',
      '/stats',
      '/runs',
    ];

    const missing = [];
    for (const route of protectedRoutes) {
      // Ищем вместе с кавычками — иначе матчится текст в комментариях
      const needle = `'${route}'`;
      const idx = source.indexOf(needle);
      if (idx === -1) {
        missing.push(`${route} (не найден)`);
        continue;
      }
      // requireAdmin должен стоять в той же строке объявления маршрута
      const line = source.slice(source.lastIndexOf('\n', idx) + 1, source.indexOf('\n', idx));
      if (!/requireAdmin/.test(line)) missing.push(`${route} (без requireAdmin)`);
    }

    assert.deepStrictEqual(missing, [], `незащищённые маршруты: ${missing.join(', ')}`);

    // /health и / должны оставаться открытыми — их пингует cron-job.org
    for (const open of ["app.get('/',", "app.get('/health',"]) {
      const idx = source.indexOf(open);
      assert.ok(idx > -1, `нет открытого маршрута ${open}`);
      const line = source.slice(source.lastIndexOf('\n', idx) + 1, source.indexOf('\n', idx));
      assert.ok(!/requireAdmin/.test(line), `${open} не должен требовать токен`);
    }
  });

  await test('H6 index: есть middleware проверки токена', () => {
    const source = require('fs').readFileSync(require.resolve('../index.js'), 'utf8');
    assert.ok(/function requireAdmin/.test(source));
    assert.ok(/timingSafeEqual/.test(source), 'сравнение токена должно быть постоянным по времени');
    assert.ok(/x-admin-token/i.test(source));
  });

  /* ---------------- M1/M2: сборка ---------------- */

  await test('M1 package-lock.json существует', () => {
    const fs = require('fs');
    assert.ok(fs.existsSync(require('path').join(__dirname, '..', 'package-lock.json')));
    const lock = JSON.parse(fs.readFileSync(require('path').join(__dirname, '..', 'package-lock.json'), 'utf8'));
    assert.ok(lock.lockfileVersion >= 2);
    assert.ok(Object.keys(lock.packages || {}).length > 100, 'lock должен содержать дерево зависимостей');
  });

  await test('M2 package.json: задано поле engines', () => {
    const pkg = require('../package.json');
    assert.ok(pkg.engines && pkg.engines.node, 'нет engines.node');
  });

  await test('M3 package.json: мёртвая зависимость openai удалена', () => {
    const pkg = require('../package.json');
    assert.strictEqual(pkg.dependencies.openai, undefined, 'openai больше нигде не импортируется');
  });

  /* ---------------- Итог ---------------- */

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Всего: ${results.length} | ✅ ${results.length - failed.length} | ❌ ${failed.length}`);
  if (failed.length > 0) {
    console.log('\nПровалены:');
    for (const f of failed) console.log(`  • ${f.name}\n    ${f.error.message.split('\n')[0]}`);
  }
  console.log('='.repeat(60));

  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('💥 Тесты упали:', error);
  process.exit(1);
});
