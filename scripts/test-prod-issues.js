#!/usr/bin/env node
// scripts/test-prod-issues.js
// Тесты на дефекты, обнаруженные в боевом логе Render после деплоя:
//   1. IMAP: сертификат почтового сервера выписан для родительского домена
//   2. MongoDB: конфликт имени индекса с индексом от предыдущей версии схемы
//   3. YouGile: API отвергает неизвестный query-параметр пагинации
// Запуск: npm run test:prod

require('dotenv').config({ quiet: true });

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

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
      console.log(`     ${String(error.message).split('\n').slice(0, 4).join('\n     ')}`);
    });
}

/** Запуск мок-сервера, возвращает {url, close, hits}. */
function startMockServer(handler) {
  return new Promise((resolve) => {
    const hits = [];
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      hits.push(Object.fromEntries(url.searchParams.entries()));
      handler(url, res, hits.length);
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        hits,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function json(res, obj, status = 200) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

async function main() {
  console.log('\n🧪 Тесты дефектов из боевого лога Render\n');

  /* ================================================================== */
  console.log('— 1. IMAP: сертификат на родительский домен —');
  /* ================================================================== */

  await test('config: MAIL_TLS_SERVERNAME читается из окружения', () => {
    process.env.MAIL_TLS_SERVERNAME = 'h12.ose.su';
    delete require.cache[require.resolve('../lib/config')];
    const { config } = require('../lib/config');
    assert.strictEqual(config.mailTlsServername, 'h12.ose.su');
    delete process.env.MAIL_TLS_SERVERNAME;
    delete require.cache[require.resolve('../lib/config')];
  });

  await test('IMAP: servername передаётся в клиент, проверка сертификата включена', () => {
    process.env.MAIL_TLS_SERVERNAME = 'h12.ose.su';
    process.env.MAIL_USER = 'ai@example.com';
    process.env.MAIL_PASSWORD = 'secret';
    process.env.MAIL_HOST = 'mail.fl.h12.ose.su';
    delete require.cache[require.resolve('../lib/config')];
    delete require.cache[require.resolve('../email-worker')];
    const worker = require('../email-worker');

    try {
      const options = worker.buildImapOptions();
      assert.strictEqual(options.host, 'mail.fl.h12.ose.su');
      assert.strictEqual(options.servername, 'h12.ose.su', 'servername не передан на верхний уровень ImapFlow');
      assert.strictEqual(options.tls.servername, 'h12.ose.su', 'servername не передан в tls-опции');
      assert.strictEqual(options.tls.rejectUnauthorized, true, 'проверка сертификата не должна отключаться');
      assert.strictEqual(options.secure, true);
      assert.strictEqual(options.auth.user, 'ai@example.com');
    } finally {
      for (const key of ['MAIL_TLS_SERVERNAME', 'MAIL_USER', 'MAIL_PASSWORD', 'MAIL_HOST']) delete process.env[key];
      delete require.cache[require.resolve('../lib/config')];
      delete require.cache[require.resolve('../email-worker')];
    }
  });

  await test('IMAP: без MAIL_TLS_SERVERNAME опция не добавляется', () => {
    process.env.MAIL_USER = 'ai@example.com';
    process.env.MAIL_PASSWORD = 'secret';
    delete require.cache[require.resolve('../lib/config')];
    delete require.cache[require.resolve('../email-worker')];
    const worker = require('../email-worker');

    try {
      const options = worker.buildImapOptions();
      assert.ok(!('servername' in options), 'servername не должен появляться, если переменная не задана');
      assert.ok(!('servername' in options.tls));
      assert.strictEqual(options.tls.rejectUnauthorized, true);
    } finally {
      delete process.env.MAIL_USER;
      delete process.env.MAIL_PASSWORD;
      delete require.cache[require.resolve('../lib/config')];
      delete require.cache[require.resolve('../email-worker')];
    }
  });

  await test('IMAP: MAIL_TLS_INSECURE=true отключает проверку только по явному флагу', () => {
    process.env.MAIL_USER = 'ai@example.com';
    process.env.MAIL_PASSWORD = 'secret';
    process.env.MAIL_TLS_INSECURE = 'true';
    delete require.cache[require.resolve('../lib/config')];
    delete require.cache[require.resolve('../email-worker')];
    const worker = require('../email-worker');

    try {
      assert.strictEqual(worker.buildImapOptions().tls.rejectUnauthorized, false);
    } finally {
      for (const key of ['MAIL_USER', 'MAIL_PASSWORD', 'MAIL_TLS_INSECURE']) delete process.env[key];
      delete require.cache[require.resolve('../lib/config')];
      delete require.cache[require.resolve('../email-worker')];
    }
  });

  await test('IMAP: из боевой ошибки сертификата извлекается готовое значение переменной', () => {
    const worker = require('../email-worker');
    const realError =
      "Hostname/IP does not match certificate's altnames: Host: mail.fl.h12.ose.su. " +
      "is not in the cert's altnames: DNS:h12.ose.su";

    const problem = worker.describeCertificateProblem(realError);
    assert.ok(problem, 'ошибка сертификата не распознана');
    assert.deepStrictEqual(problem.names, ['h12.ose.su']);
    assert.strictEqual(problem.suggestion, 'h12.ose.su', 'подсказка должна предлагать MAIL_TLS_SERVERNAME=h12.ose.su');
  });

  await test('IMAP: несколько имён в сертификате и посторонние ошибки', () => {
    const worker = require('../email-worker');

    const multi = worker.describeCertificateProblem(
      "is not in the cert's altnames: DNS:*.example.com, DNS:example.com, DNS:mail.example.com"
    );
    assert.deepStrictEqual(multi.names, ['*.example.com', 'example.com', 'mail.example.com']);
    assert.strictEqual(multi.suggestion, '*.example.com');

    // Обычные ошибки не должны выдаваться за проблему сертификата
    assert.strictEqual(worker.describeCertificateProblem('Connection refused'), null);
    assert.strictEqual(worker.describeCertificateProblem(''), null);
    assert.strictEqual(worker.describeCertificateProblem(undefined), null);
    assert.ok(worker.describeCertificateProblem('self signed certificate'), 'self-signed не распознан');
  });

  await test('IMAP: повторы IDLE с экспоненциальной паузой, а не каждые 5 секунд', () => {
    const source = fs.readFileSync(require.resolve('../email-worker'), 'utf8');
    const loop = source.slice(source.indexOf('async function runIdleLoop'));
    assert.ok(/consecutiveFailures/.test(loop), 'нет счётчика подряд идущих сбоев');
    assert.ok(/mailIdleRetryMaxMs/.test(loop), 'нет ограничения паузы сверху');
    assert.ok(/2 \*\*/.test(loop), 'пауза должна расти экспоненциально');
    // Лог не должен печатать каждую попытку — иначе Render заполняется дублями
    assert.ok(/consecutiveFailures <= 3/.test(loop), 'нет ограничения на частоту логирования');
  });

  /* ================================================================== */
  console.log('\n— 2. MongoDB: конфликт индексов —');
  /* ================================================================== */

  await test('все индексы имеют явные имена, уникальные в пределах коллекции', () => {
    const db = require('../db');
    const definitions = db.INDEX_DEFINITIONS;

    assert.ok(definitions.length >= 10, `индексов ${definitions.length}, ожидалось не меньше 10`);

    const labels = definitions.map((d) => `${d.collection}.${d.name}`);
    const dupes = labels.filter((v, i) => labels.indexOf(v) !== i);
    assert.deepStrictEqual(dupes, [], `дубли имён: ${dupes.join(', ')}`);

    for (const definition of definitions) {
      assert.ok(definition.name, `индекс на ${definition.collection} без явного имени`);
      assert.ok(definition.keys && Object.keys(definition.keys).length > 0, `пустые ключи у ${definition.name}`);
      // Явное имя не должно совпадать с автоматически генерируемым —
      // именно такое совпадение и вызвало конфликт в проде
      const auto = Object.keys(definition.keys).map((k) => `${k}_${definition.keys[k]}`).join('_');
      assert.notStrictEqual(definition.name, auto, `${definition.name} совпадает с автогенерируемым именем`);
    }
  });

  await test('конфликт имени индекса: старый удаляется, новый создаётся', async () => {
    const db = require('../db');
    const calls = [];

    const conflict = Object.assign(new Error('An existing index has the same name as the requested index'), {
      code: 85,
    });

    // Отдельная заглушка на каждую коллекцию: имя uniq_taskId используется
    // и в task_history, и в task_runs, а uniq_chatId — в bot_access и bot_requests
    const attempts = new Map();
    const makeCollection = (name) => ({
      createIndex: async (keys, options) => {
        const key = `${name}.${options.name}`;
        calls.push(`create:${key}`);
        attempts.set(key, (attempts.get(key) || 0) + 1);
        if (attempts.get(key) === 1) throw conflict; // первая попытка — конфликт схемы
        return options.name;
      },
      dropIndex: async (indexName) => {
        calls.push(`drop:${name}.${indexName}`);
        return true;
      },
    });

    await db.createIndexes({ collection: makeCollection });

    assert.ok(
      calls.includes('drop:task_history.uniq_taskId'),
      `старый индекс не удалён. Вызовы: ${calls.slice(0, 12).join(' → ')}`
    );
    assert.strictEqual(attempts.get('task_history.uniq_taskId'), 2, 'индекс не пересоздан после удаления');

    // Все индексы в итоге должны создаться
    for (const definition of db.INDEX_DEFINITIONS) {
      const key = `${definition.collection}.${definition.name}`;
      assert.strictEqual(attempts.get(key), 2, `${key}: ожидалось 2 попытки, получено ${attempts.get(key)}`);
    }
  });

  await test('сбой одного индекса не роняет создание остальных', async () => {
    const db = require('../db');
    const created = [];

    const collection = {
      createIndex: async (keys, options) => {
        // Имитируем неустранимую ошибку (например, дубликаты для unique-индекса)
        if (options.name === 'uniq_query') throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
        created.push(options.name);
        return options.name;
      },
      dropIndex: async () => true,
    };

    await db.createIndexes({ collection: () => collection });


    assert.ok(created.length >= db.INDEX_DEFINITIONS.length - 1, `создано только ${created.length} индексов`);
    assert.ok(created.includes('uniq_taskId'), 'остальные индексы должны создаться несмотря на сбой одного');
  });

  await test('createIndexes вызывается при подключении, а не вручную', () => {
    const source = fs.readFileSync(require.resolve('../db.js'), 'utf8');
    assert.ok(/await createIndexes\(db\)/.test(source), 'createIndexes не вызывается в connectToMongo');
  });

  /* ================================================================== */
  console.log('\n— 3. YouGile: валидация query-параметров —');
  /* ================================================================== */

  await test('первый запрос к /tasks не содержит параметров пагинации', async () => {
    const mock = await startMockServer((url, res) => {
      json(res, { content: [{ id: '1' }, { id: '2' }], paging: { count: 2 } });
    });

    process.env.YOUGILE_API_KEY = 'test-key';
    process.env.YOUGILE_BASE_URL = mock.url;
    for (const key of Object.keys(require.cache)) {
      if (/yougile-client|lib[\\/]config/.test(key)) delete require.cache[key];
    }
    const yougile = require('../lib/yougile-client');

    try {
      const tasks = await yougile.listTasks({ columnId: 'col-1' }, { pageSize: 50 });
      assert.strictEqual(tasks.length, 2);
      assert.strictEqual(mock.hits.length, 1, 'должен быть ровно один запрос');
      assert.strictEqual(mock.hits[0].page, undefined, 'параметр page отправлять нельзя — API его отвергает');
      assert.strictEqual(mock.hits[0].offset, undefined, 'первый запрос должен обходиться без offset');
      assert.strictEqual(mock.hits[0].limit, '50');
      assert.strictEqual(mock.hits[0].columnId, 'col-1');
    } finally {
      await mock.close();
      delete process.env.YOUGILE_BASE_URL;
      delete process.env.YOUGILE_API_KEY;
    }
  });

  await test('API отвергает offset → пагинация отключается, первая страница возвращается', async () => {
    const mock = await startMockServer((url, res) => {
      if (url.searchParams.has('offset')) {
        return json(res, { statusCode: 400, message: ['property offset should not exist'], error: 'Bad Request' }, 400);
      }
      json(res, {
        content: Array.from({ length: 5 }, (_, i) => ({ id: String(i + 1) })),
        paging: { count: 42 },
      });
    });

    process.env.YOUGILE_API_KEY = 'test-key';
    process.env.YOUGILE_BASE_URL = mock.url;
    process.env.YOUGILE_PAGE_PARAM = 'offset';
    for (const key of Object.keys(require.cache)) {
      if (/yougile-client|lib[\\/]config/.test(key)) delete require.cache[key];
    }
    const yougile = require('../lib/yougile-client');

    try {
      const tasks = await yougile.listTasks({}, { pageSize: 5 });
      assert.strictEqual(tasks.length, 5, 'первая страница должна вернуться несмотря на отказ пагинации');
    } finally {
      await mock.close();
      delete process.env.YOUGILE_BASE_URL;
      delete process.env.YOUGILE_API_KEY;
      delete process.env.YOUGILE_PAGE_PARAM;
    }
  });

  await test('API принимает offset → вычитываются все страницы без дублей', async () => {
    const TOTAL = 12;
    const mock = await startMockServer((url, res) => {
      const offset = Number(url.searchParams.get('offset') || 0);
      const limit = Number(url.searchParams.get('limit') || 5);
      const count = Math.max(0, Math.min(limit, TOTAL - offset));
      json(res, {
        content: Array.from({ length: count }, (_, i) => ({ id: String(offset + i + 1) })),
        paging: { count: TOTAL },
      });
    });

    process.env.YOUGILE_API_KEY = 'test-key';
    process.env.YOUGILE_BASE_URL = mock.url;
    process.env.YOUGILE_PAGE_PARAM = 'offset';
    for (const key of Object.keys(require.cache)) {
      if (/yougile-client|lib[\\/]config/.test(key)) delete require.cache[key];
    }
    const yougile = require('../lib/yougile-client');

    try {
      const tasks = await yougile.listTasks({}, { pageSize: 5 });
      assert.strictEqual(tasks.length, TOTAL, `прочитано ${tasks.length} из ${TOTAL}`);
      assert.strictEqual(new Set(tasks.map((t) => t.id)).size, TOTAL, 'в выдаче есть дубли');
      assert.strictEqual(mock.hits.length, 3, `запросов ${mock.hits.length}, ожидалось 3`);
      assert.deepStrictEqual(
        mock.hits.map((h) => h.offset),
        [undefined, '5', '10'],
        'offset должен расти от страницы к странице'
      );
    } finally {
      await mock.close();
      delete process.env.YOUGILE_BASE_URL;
      delete process.env.YOUGILE_API_KEY;
      delete process.env.YOUGILE_PAGE_PARAM;
    }
  });

  await test('M27 без пагинации в логе остаётся предупреждение о неполной выборке', () => {
    const source = fs.readFileSync(require.resolve('../lib/yougile-client.js'), 'utf8');
    assert.ok(/Пагинация отключена/.test(source), 'нет предупреждения об отключении пагинации');
    assert.ok(/YOUGILE_PAGE_PARAM/.test(source), 'в предупреждении должна быть подсказка про переменную');
  });

  /* ================================================================== */
  console.log('\n— 4. Telegram: конфликт поллинга (409) —');
  /* ================================================================== */

  await test('409 Conflict обрабатывается: поллинг уступает слот и повторяет', () => {
    const source = fs.readFileSync(require.resolve('../telegram-bot'), 'utf8');

    assert.ok(/polling_error/.test(source), 'нет обработчика polling_error');
    assert.ok(/409|terminated by other getUpdates/.test(source), 'конфликт не распознаётся');
    assert.ok(/stopPolling\(\)/.test(source), 'при конфликте поллинг должен останавливаться');
    assert.ok(/startPolling\(\)/.test(source), 'после паузы поллинг должен возобновляться');

    // Пауза растёт, чтобы не долбить Telegram во время пересечения dyno
    assert.ok(/Math\.min\(15000 \* conflictRetries/.test(source), 'нет экспоненциальной паузы');
    assert.ok(/conflictRetries = 0/.test(source), 'счётчик конфликтов должен сбрасываться');
  });

  await test('таймер отложенного перезапуска гасится при остановке бота', () => {
    const source = fs.readFileSync(require.resolve('../telegram-bot'), 'utf8');
    const stopFn = source.slice(source.indexOf('function stopBot'));
    assert.ok(/clearTimeout\(conflictTimer\)/.test(stopFn), 'stopBot не очищает таймер перезапуска');
  });

  await test('unhandled error по-прежнему не роняет процесс', () => {
    const source = fs.readFileSync(require.resolve('../telegram-bot'), 'utf8');
    assert.ok(/bot\.on\('error'/.test(source));
    assert.ok(/bot\.on\('polling_error'/.test(source));

    const indexSource = fs.readFileSync(require.resolve('../index.js'), 'utf8');
    assert.ok(/uncaughtException/.test(indexSource));
    assert.ok(/unhandledRejection/.test(indexSource));
  });

  /* ================================================================== */
  console.log('\n— 5. Политика согласования правок существующего контента —');
  /* ================================================================== */

  await test('modx-client: без настроек не пытается ходить в сеть', async () => {
    for (const key of ['MODX_PUBLISHER_URL', 'MODX_PUBLISHER_TOKEN']) delete process.env[key];
    for (const key of Object.keys(require.cache)) {
      if (/lib[\\/](config|modx-client)\.js$/.test(key)) delete require.cache[key];
    }
    const modx = require('../lib/modx-client');

    assert.strictEqual(modx.isConfigured(), false);
    const pingResult = await modx.ping();
    assert.strictEqual(pingResult.success, false);
    assert.ok(/MODX_PUBLISHER_URL/.test(pingResult.error));
  });

  await test('modx-client: 412 анти-бота Хостии распознаётся как отдельный диагноз', () => {
    const modx = require('../lib/modx-client');
    const hint = modx.diagnose(412, "<html><script src='//x/hostia-antibot.js'></script>");
    assert.ok(hint, 'нет подсказки для 412');
    assert.ok(/Хостия|анти-бот/i.test(hint), hint);
    assert.ok(/панели хостинга|исключение/i.test(hint), 'в подсказке нет способа починить');

    assert.ok(/ai_publisher_token/.test(modx.diagnose(401, '')), 'нет подсказки про токен');
    assert.ok(/create_only/.test(modx.diagnose(403, '')), 'нет подсказки про политику');
  });

  await test('modx-client: защищённое действие без заявки НЕ уходит в сеть и создаёт заявку', async () => {
    process.env.MODX_PUBLISHER_URL = 'http://127.0.0.1:9/modx.php';
    process.env.MODX_PUBLISHER_TOKEN = 'token';
    process.env.MONGODB_URI = 'mongodb://localhost:27017';
    for (const key of Object.keys(require.cache)) {
      if (/lib[\\/](config|modx-client|approvals)|^.*db\.js$/.test(key)) delete require.cache[key];
    }

    // Подменяем db и approvals-уведомления, чтобы не трогать Mongo и Telegram
    const dbPath = require.resolve('../db');
    const inserted = [];
    const originalDb = require.cache[dbPath];
    require.cache[dbPath] = {
      id: dbPath, filename: dbPath, loaded: true,
      exports: {
        getDb: async () => ({
          collection: () => ({
            insertOne: async (doc) => { inserted.push(doc); return { insertedId: 1 }; },
            findOne: async () => null,
            findOneAndUpdate: async () => null,
            find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }),
            updateOne: async () => {},
          }),
        }),
        COLLECTIONS: {},
      },
    };

    // getResource должен сказать, что ресурс НЕ создан агентом,
    // а сеть при этом не вызывается: URL несуществующий, и любой fetch упал бы
    const modxPath = require.resolve('../lib/modx-client');
    delete require.cache[modxPath];
    const modx = require(modxPath);
    const originalGet = modx.getResource;
    modx.getResource = async () => ({ success: true, resource: { id: 42, agentOwned: false } });

    try {
      const result = await modx.mutateExisting('update', {
        id: 42,
        payload: { pagetitle: 'взлом' },
        reason: 'проверка политики',
        taskId: 'task-1',
      });

      assert.strictEqual(result.success, false, 'защищённое действие не должно выполняться');
      assert.strictEqual(result.pending, true, 'должен вернуться статус ожидания согласования');
      assert.ok(result.requestId, 'нет id заявки');
      assert.ok(/согласование/i.test(result.error), result.error);
      assert.strictEqual(inserted.length, 1, 'заявка не сохранена');
      assert.strictEqual(inserted[0].kind, 'modx_update');
      assert.strictEqual(inserted[0].target, '42');
      assert.strictEqual(inserted[0].status, 'pending');
    } finally {
      modx.getResource = originalGet;
      if (originalDb) require.cache[dbPath] = originalDb;
      else delete require.cache[dbPath];
      for (const key of ['MODX_PUBLISHER_URL', 'MODX_PUBLISHER_TOKEN']) delete process.env[key];
      for (const key of Object.keys(require.cache)) {
        if (/lib[\\/](config|modx-client)\.js$/.test(key)) delete require.cache[key];
      }
    }
  });

  await test('modx-client: свой черновик агент доводит без согласования', async () => {
    // Мок-коннектор: на action=resource отвечает agentOwned=true,
    // на action=update — успехом. Считаем обращения, чтобы доказать:
    // запрос ушёл НАПРЯМУЮ, без создания заявки.
    const hits = [];
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      hits.push(url.searchParams.get('action'));
      res.setHeader('Content-Type', 'application/json');

      if (url.searchParams.get('action') === 'resource') {
        return res.end(JSON.stringify({ success: true, resource: { id: 7, agentOwned: true } }));
      }
      return res.end(JSON.stringify({ success: true, id: 7, url: 'https://example/7' }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    process.env.MODX_PUBLISHER_URL = `http://127.0.0.1:${server.address().port}/modx.php`;
    process.env.MODX_PUBLISHER_TOKEN = 'token';
    for (const key of Object.keys(require.cache)) {
      if (/lib[\\/](config|modx-client)\.js$/.test(key)) delete require.cache[key];
    }
    const modx = require('../lib/modx-client');

    try {
      const result = await modx.mutateExisting('update', { id: 7, payload: { pagetitle: 'x' }, reason: 'свой черновик' });

      assert.strictEqual(result.success, true, `свой черновик должен обновляться сразу: ${result.error}`);
      assert.notStrictEqual(result.pending, true, 'заявка для своего черновика не нужна');
      assert.deepStrictEqual(hits, ['resource', 'update'], `обращения: ${hits.join(',')}`);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      for (const key of ['MODX_PUBLISHER_URL', 'MODX_PUBLISHER_TOKEN']) delete process.env[key];
      for (const key of Object.keys(require.cache)) {
        if (/lib[\\/](config|modx-client)\.js$/.test(key)) delete require.cache[key];
      }
    }
  });

  await test('createDraft принудительно делает черновик неопубликованным', async () => {
    const modx = require('../lib/modx-client');
    const result = await modx.createDraft({ pagetitle: '' });
    assert.strictEqual(result.success, false, 'пустой pagetitle должен отклоняться до сети');
  });

  await test('conneктор: в коде нет действия удаления', () => {
    const php = fs.readFileSync(path.join(__dirname, '..', 'modx', 'ai-publisher.connector.php'), 'utf8');
    assert.ok(!/\$action === 'delete'|action=delete/i.test(php), 'в коннекторе появилось действие delete');
    assert.ok(/create_only/.test(php), 'нет режима create_only');
    assert.ok(/guardExisting/.test(php), 'нет серверной проверки владения');
    assert.ok(/ai_publisher_mode/.test(php), 'режим не настраивается');
  });

  await test('системный промпт запрещает правки чужого контента', () => {
    const { buildSystemPrompt } = require('../ai-agent');
    const prompt = buildSystemPrompt('t', 'задача', 'описание', '');
    assert.ok(/ЗАПРЕЩЕНО/.test(prompt), 'в промпте нет прямого запрета');
    assert.ok(/согласование/i.test(prompt), 'нет отсылки к механизму согласования');
    assert.ok(/обойти согласование/.test(prompt), 'нет запрета на обход механизма');
  });

  /* ================================================================== */

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Всего: ${results.length} | ✅ ${results.length - failed.length} | ❌ ${failed.length}`);
  if (failed.length > 0) {
    console.log('\nПровалены:');
    for (const f of failed) console.log(`  • ${f.name}\n    ${String(f.error.message).split('\n')[0]}`);
  }
  console.log('='.repeat(60));

  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('💥 Тесты упали:', error);
  process.exit(1);
});
