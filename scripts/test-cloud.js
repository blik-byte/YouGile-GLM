#!/usr/bin/env node
// scripts/test-cloud.js
// Тесты облачного хранилища: переключение провайдеров, формирование ключей,
// подписи ссылок и РЕАЛЬНАЯ загрузка файла через S3-совместимый мок-сервер.

require('dotenv').config({ quiet: true });

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
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

/** Сброс кэша модулей, зависящих от переменных окружения. */
function reloadConfig() {
  for (const key of Object.keys(require.cache)) {
    if (/lib[\\/](config|cloud)\.js$|r2-client\.js$|pcloud-client\.js$/.test(key)) delete require.cache[key];
  }
}

function setEnv(values) {
  for (const [key, value] of Object.entries(values)) {
    if (value === null) delete process.env[key];
    else process.env[key] = value;
  }
  reloadConfig();
}

/**
 * Минимальный S3-совместимый мок: принимает PUT/GET в path-style,
 * авторизацию не проверяет (SDK её формирует, а подпись мы валидируем отдельно).
 */
function startMockS3() {
  return new Promise((resolve) => {
    const store = new Map();
    const log = [];

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      // path-style: /<bucket>/<key...>
      const [, bucket, ...rest] = url.pathname.split('/');
      const key = decodeURIComponent(rest.join('/'));

      log.push({ method: req.method, bucket, key, headers: req.headers });

      if (req.method === 'PUT') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        store.set(key, {
          body: Buffer.concat(chunks),
          contentType: req.headers['content-type'],
          disposition: req.headers['content-disposition'],
          cacheControl: req.headers['cache-control'],
          metadata: req.headers['x-amz-meta-source'],
        });
        res.statusCode = 200;
        res.setHeader('ETag', '"mock-etag"');
        return res.end();
      }

      if (req.method === 'GET') {
        const object = store.get(key);
        if (!object) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/xml');
          return res.end('<?xml version="1.0"?><Error><Code>NoSuchKey</Code></Error>');
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', object.contentType || 'application/octet-stream');
        res.setHeader('Content-Length', String(object.body.length));
        if (object.disposition) res.setHeader('Content-Disposition', object.disposition);
        return res.end(object.body);
      }

      if (req.method === 'HEAD') {
        res.statusCode = store.has(key) ? 200 : 404;
        return res.end();
      }

      res.statusCode = 405;
      res.end();
    });

    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        store,
        log,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

async function main() {
  console.log('\n🧪 Тесты облачного хранилища\n');

  const { transliterate, sanitizeFilename } = require('../lib/text');

  /* ================================================================== */
  console.log('— Транслитерация и ключи объектов —');
  /* ================================================================== */

  await test('transliterate: кириллица переходит в латиницу', () => {
    assert.strictEqual(transliterate('отчёт'), 'otchyot');
    assert.strictEqual(transliterate('SEO аудит сайта'), 'seo-audit-sayta');
    assert.strictEqual(transliterate('ЖУРНАЛ'), 'zhurnal');
    assert.strictEqual(transliterate('щучка'), 'schuchka');
    assert.strictEqual(transliterate('Ёлка'), 'yolka');
  });

  await test('transliterate: смешанный текст и спецсимволы', () => {
    assert.strictEqual(transliterate('отчёт 2026 (финал)'), 'otchyot-2026-final');
    assert.strictEqual(transliterate('a_b-c.d'), 'a_b-c.d');
    assert.strictEqual(transliterate(''), '');
    assert.strictEqual(transliterate('!!!'), '');
    assert.ok(!/[^a-z0-9._-]/.test(transliterate('Любой Текст №1 — 2026!')), 'в ключе остались недопустимые символы');
  });

  await test('ключи объектов уникальны и безопасны', () => {
    process.env.R2_ACCOUNT_ID = 'acc';
    process.env.R2_ACCESS_KEY_ID = 'id';
    process.env.R2_SECRET_ACCESS_KEY = 'secret';
    process.env.R2_BUCKET = 'bucket';
    setEnv({});
    const r2 = require('../r2-client');

    try {
      const first = r2.buildObjectKey('../../etc/passwd.txt');
      const second = r2.buildObjectKey('../../etc/passwd.txt');

      assert.notStrictEqual(first, second, 'два файла с одним именем должны получать разные ключи');
      assert.ok(!first.includes('..'), `path traversal в ключе: ${first}`);
      assert.ok(first.startsWith('ai-documents/'), `нет префикса: ${first}`);
      assert.ok(/^\d{4}\/\d{2}\//.test(first.split('/').slice(1).join('/')), `нет структуры год/месяц: ${first}`);
      assert.ok(first.endsWith('.txt'), `потеряно расширение: ${first}`);

      const cyrillic = r2.buildObjectKey('Отчёт по конкурентам.xlsx');
      assert.ok(/otchyot-po-konkurentam/.test(cyrillic), `кириллица не транслитерирована: ${cyrillic}`);
      assert.ok(cyrillic.endsWith('.xlsx'));
      assert.ok(!/[^\x20-\x7e]/.test(cyrillic), 'в ключе остались не-ASCII символы');
    } finally {
      for (const k of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']) delete process.env[k];
      setEnv({});
    }
  });

  /* ================================================================== */
  console.log('\n— Выбор провайдера —');
  /* ================================================================== */

  await test('cloud: CLOUD_PROVIDER=none отключает хранилище даже при настроенном R2', () => {
    setEnv({
      R2_ACCOUNT_ID: 'acc',
      R2_ACCESS_KEY_ID: 'id',
      R2_SECRET_ACCESS_KEY: 'secret',
      R2_BUCKET: 'bucket',
      CLOUD_PROVIDER: 'none',
    });
    const cloud = require('../lib/cloud');
    assert.strictEqual(cloud.resolveProvider(), 'none');
    assert.strictEqual(cloud.isConfigured(), false);
  });

  await test('cloud: auto выбирает R2, когда он настроен', () => {
    setEnv({ CLOUD_PROVIDER: 'auto' });
    const cloud = require('../lib/cloud');
    assert.strictEqual(cloud.resolveProvider(), 'r2');
    assert.strictEqual(cloud.isConfigured(), true);
  });

  await test('cloud: auto выбирает pCloud, если R2 не настроен', () => {
    setEnv({
      R2_ACCOUNT_ID: null,
      R2_ACCESS_KEY_ID: null,
      R2_SECRET_ACCESS_KEY: null,
      R2_BUCKET: null,
      PCLOUD_AUTH_TOKEN: 'pcloud-token',
      CLOUD_PROVIDER: 'auto',
    });
    const cloud = require('../lib/cloud');
    assert.strictEqual(cloud.resolveProvider(), 'pcloud');
  });

  await test('cloud: без настроек обоих провайдеров возвращает понятную ошибку', async () => {
    setEnv({ PCLOUD_AUTH_TOKEN: null, CLOUD_PROVIDER: 'auto' });
    const cloud = require('../lib/cloud');
    assert.strictEqual(cloud.resolveProvider(), 'none');

    const result = await cloud.upload('/nonexistent/file.txt', 'file.txt');
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.provider, 'none');
    assert.ok(/R2_ACCOUNT_ID/.test(result.error), `нет списка нужных переменных: ${result.error}`);
  });

  await test('cloud: явный CLOUD_PROVIDER=r2 при ненастроенном R2 не падает молча', async () => {
    setEnv({ CLOUD_PROVIDER: 'r2', PCLOUD_AUTH_TOKEN: 'pcloud-token' });
    const cloud = require('../lib/cloud');
    assert.strictEqual(cloud.resolveProvider(), 'r2');

    const tmp = path.join(os.tmpdir(), `cloud-test-${Date.now()}.txt`);
    fs.writeFileSync(tmp, 'данные');
    try {
      const result = await cloud.upload(tmp, 'test.txt');
      assert.strictEqual(result.success, false);
      assert.ok(/R2_ACCOUNT_ID/.test(result.error), `ошибка должна перечислять недостающее: ${result.error}`);
    } finally {
      fs.rmSync(tmp, { force: true });
      setEnv({ CLOUD_PROVIDER: null });
    }
  });

  /* ================================================================== */
  console.log('\n— Ссылки и подписи —');
  /* ================================================================== */

  await test('r2: публичная ссылка формируется из R2_PUBLIC_BASE_URL', () => {
    setEnv({
      R2_ACCOUNT_ID: 'acc',
      R2_ACCESS_KEY_ID: 'id',
      R2_SECRET_ACCESS_KEY: 'secret',
      R2_BUCKET: 'bucket',
      R2_PUBLIC_BASE_URL: 'https://files.example.com/',
      CLOUD_PROVIDER: 'r2',
    });
    const r2 = require('../r2-client');
    const url = r2.publicUrl('ai-documents/2026/10/123-otchyot.xlsx');
    assert.strictEqual(url, 'https://files.example.com/ai-documents/2026/10/123-otchyot.xlsx');
    assert.ok(!url.includes('//ai-documents'), 'двойной слэш на стыке');
  });

  await test('r2: endpoint учитывает юрисдикцию бакета', () => {
    setEnv({ R2_ACCOUNT_ID: 'abc123', R2_ACCESS_KEY_ID: 'i', R2_SECRET_ACCESS_KEY: 's', R2_BUCKET: 'b', R2_JURISDICTION: null });
    assert.strictEqual(require('../r2-client').endpoint(), 'https://abc123.r2.cloudflarestorage.com');

    setEnv({ R2_JURISDICTION: 'eu' });
    assert.strictEqual(require('../r2-client').endpoint(), 'https://abc123.eu.r2.cloudflarestorage.com');
  });

  await test('r2: подпись ссылки проверяется и не подделывается', () => {
    setEnv({ R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'i', R2_SECRET_ACCESS_KEY: 's', R2_BUCKET: 'b', ADMIN_TOKEN: 'super-secret' });
    const r2 = require('../r2-client');

    const signature = r2.signKey('ai-documents/secret.xlsx');
    assert.ok(signature && signature.length > 20, 'подпись не сформирована');
    assert.strictEqual(r2.verifySignature('ai-documents/secret.xlsx', signature), true);
    assert.strictEqual(r2.verifySignature('ai-documents/OTHER.xlsx', signature), false, 'подпись подходит к чужому файлу!');
    assert.strictEqual(r2.verifySignature('ai-documents/secret.xlsx', signature.slice(0, -2) + 'xx'), false);
    assert.strictEqual(r2.verifySignature('ai-documents/secret.xlsx', ''), false);
    assert.strictEqual(r2.verifySignature('ai-documents/secret.xlsx', null), false);
    assert.strictEqual(r2.verifySignature('ai-documents/secret.xlsx', 12345), false);

    // Подпись детерминирована: одна и та же ссылка не должна «протухать»
    assert.strictEqual(r2.signKey('ai-documents/secret.xlsx'), signature);
  });

  await test('r2: без секрета подпись не создаётся (fail-closed)', () => {
    setEnv({ R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'i', R2_SECRET_ACCESS_KEY: 's', R2_BUCKET: 'b', ADMIN_TOKEN: null, FILES_SECRET: null });
    const r2 = require('../r2-client');
    assert.strictEqual(r2.signKey('key'), null);
    assert.strictEqual(r2.proxyUrl('key', 'file.txt'), null);
    assert.strictEqual(r2.verifySignature('key', 'anything'), false);
  });

  await test('r2: прокси-ссылка содержит ключ и валидную подпись', () => {
    setEnv({
      R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'i', R2_SECRET_ACCESS_KEY: 's', R2_BUCKET: 'b',
      ADMIN_TOKEN: 'secret-key', PUBLIC_BASE_URL: 'https://app.onrender.com',
    });
    const r2 = require('../r2-client');
    const url = r2.proxyUrl('ai-documents/2026/10/x-otchyot.xlsx', 'Отчёт.xlsx');

    assert.ok(url.startsWith('https://app.onrender.com/files/'), url);
    assert.ok(url.includes('k=ai-documents'), 'в ссылке нет ключа объекта');

    const parsed = new URL(url);
    const signature = parsed.pathname.split('/')[2];
    assert.strictEqual(r2.verifySignature(parsed.searchParams.get('k'), signature), true, 'подпись в ссылке неверна');
    assert.ok(url.includes(encodeURIComponent('Отчёт.xlsx')), 'кириллическое имя не закодировано');
  });

  /* ================================================================== */
  console.log('\n— Реальная загрузка через S3 API —');
  /* ================================================================== */

  await test('r2.uploadFile: файл уходит в бакет с правильными заголовками', async () => {
    const mock = await startMockS3();
    setEnv({
      R2_ACCOUNT_ID: 'acc',
      R2_ACCESS_KEY_ID: 'test-key-id',
      R2_SECRET_ACCESS_KEY: 'test-secret-key',
      R2_BUCKET: 'yougile-docs',
      R2_ENDPOINT: mock.url,
      R2_PUBLIC_BASE_URL: mock.url,
      CLOUD_PROVIDER: 'r2',
    });
    const r2 = require('../r2-client');

    const tmp = path.join(os.tmpdir(), `r2-upload-${Date.now()}.xlsx`);
    const payload = 'содержимое таблицы';
    fs.writeFileSync(tmp, payload);

    try {
      const result = await r2.uploadFile(tmp, { filename: 'Отчёт по продажам.xlsx' });

      assert.strictEqual(result.success, true, `загрузка не удалась: ${result.error}`);
      assert.strictEqual(result.provider, 'r2');
      assert.strictEqual(result.size, Buffer.byteLength(payload));
      assert.ok(result.key.startsWith('ai-documents/'), `ключ: ${result.key}`);
      assert.ok(result.key.endsWith('.xlsx'));
      assert.ok(/otchyot-po-prodazham/.test(result.key), `имя не транслитерировано: ${result.key}`);

      // Файл действительно лёг в бакет
      const stored = mock.store.get(result.key);
      assert.ok(stored, 'объект не найден в хранилище');
      assert.strictEqual(stored.body.toString(), payload, 'содержимое искажено');

      // MIME-тип определён по расширению
      assert.ok(
        stored.contentType.includes('spreadsheetml'),
        `неверный Content-Type для xlsx: ${stored.contentType}`
      );

      // Кириллическое имя сохранено для скачивания (RFC 5987)
      assert.ok(stored.disposition.includes("filename*=UTF-8''"), `нет filename*: ${stored.disposition}`);
      assert.ok(
        stored.disposition.includes(encodeURIComponent('Отчёт по продажам.xlsx')),
        'кириллическое имя не закодировано в Content-Disposition'
      );

      // Кэш и метаданные
      assert.ok(/immutable/.test(stored.cacheControl || ''), 'не задан Cache-Control');
      assert.strictEqual(stored.metadata, 'yougile-ai-agent');

      // Запрос подписан по SigV4
      const putRequest = mock.log.find((entry) => entry.method === 'PUT');
      assert.ok(putRequest, 'PUT-запрос не дошёл до сервера');
      const auth = putRequest.headers.authorization || '';
      assert.ok(/AWS4-HMAC-SHA256/.test(auth), `нет SigV4-подписи: ${auth.slice(0, 60)}`);
      assert.ok(/Credential=test-key-id\//.test(auth), 'в подписи не тот Access Key ID');
      assert.ok(putRequest.headers['x-amz-date'], 'нет заголовка даты');

      // Ссылка ведёт на публичный домен
      assert.ok(result.link.startsWith(mock.url + '/'), `link: ${result.link}`);
      assert.strictEqual(result.viaProxy, false);
    } finally {
      fs.rmSync(tmp, { force: true });
      await mock.close();
    }
  });

  await test('r2.uploadFile: без публичного домена ссылка идёт через наш сервер', async () => {
    const mock = await startMockS3();
    setEnv({
      R2_ACCOUNT_ID: 'acc',
      R2_ACCESS_KEY_ID: 'test-key-id',
      R2_SECRET_ACCESS_KEY: 'test-secret-key',
      R2_BUCKET: 'yougile-docs',
      R2_ENDPOINT: mock.url,
      R2_PUBLIC_BASE_URL: null,
      PUBLIC_BASE_URL: 'https://app.onrender.com',
      ADMIN_TOKEN: 'files-secret',
      CLOUD_PROVIDER: 'r2',
    });
    const r2 = require('../r2-client');

    const tmp = path.join(os.tmpdir(), `r2-proxy-${Date.now()}.txt`);
    fs.writeFileSync(tmp, 'текст');

    try {
      const result = await r2.uploadFile(tmp, { filename: 'заметка.txt' });
      assert.strictEqual(result.success, true, result.error);
      assert.strictEqual(result.viaProxy, true, 'должна использоваться прокси-ссылка');
      assert.ok(result.link.startsWith('https://app.onrender.com/files/'), `link: ${result.link}`);

      const parsed = new URL(result.link);
      assert.strictEqual(r2.verifySignature(parsed.searchParams.get('k'), parsed.pathname.split('/')[2]), true);
    } finally {
      fs.rmSync(tmp, { force: true });
      await mock.close();
    }
  });

  await test('r2.getObject: чтение обратно из бакета', async () => {
    const mock = await startMockS3();
    setEnv({
      R2_ACCOUNT_ID: 'acc', R2_ACCESS_KEY_ID: 'id', R2_SECRET_ACCESS_KEY: 'secret',
      R2_BUCKET: 'yougile-docs', R2_ENDPOINT: mock.url, R2_PUBLIC_BASE_URL: null,
      ADMIN_TOKEN: 'sec', CLOUD_PROVIDER: 'r2',
    });
    const r2 = require('../r2-client');

    const tmp = path.join(os.tmpdir(), `r2-read-${Date.now()}.md`);
    fs.writeFileSync(tmp, '# Заголовок\n\nсодержимое');

    try {
      const uploaded = await r2.uploadFile(tmp, { filename: 'документ.md' });
      assert.strictEqual(uploaded.success, true, uploaded.error);

      const object = await r2.getObject(uploaded.key);
      assert.ok(object, 'объект не прочитался');

      const chunks = [];
      for await (const chunk of object.body) chunks.push(chunk);
      assert.strictEqual(Buffer.concat(chunks).toString(), '# Заголовок\n\nсодержимое');
      assert.ok(object.contentType.includes('markdown'), `Content-Type: ${object.contentType}`);

      const missing = await r2.getObject('ai-documents/нет-такого-файла.txt');
      assert.strictEqual(missing, null, 'несуществующий ключ должен возвращать null, а не бросать');
    } finally {
      fs.rmSync(tmp, { force: true });
      await mock.close();
    }
  });

  await test('r2: ошибки диагностики переведены в понятные сообщения', () => {
    setEnv({ R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'i', R2_SECRET_ACCESS_KEY: 's', R2_BUCKET: 'my-bucket' });
    const r2 = require('../r2-client');

    const cases = [
      [{ name: 'NoSuchBucket', message: 'NoSuchBucket' }, /my-bucket/],
      [{ name: 'AccessDenied', message: 'Access Denied' }, /Object Read & Write/],
      [{ name: 'InvalidAccessKeyId', message: 'x' }, /R2_ACCESS_KEY_ID/],
      [{ name: 'SignatureDoesNotMatch', message: 'SignatureDoesNotMatch' }, /R2_SECRET_ACCESS_KEY/],
      [{ name: 'Error', message: 'getaddrinfo ENOTFOUND' }, /R2_ACCOUNT_ID/],
    ];

    for (const [error, pattern] of cases) {
      const hint = r2.diagnose(error);
      assert.ok(hint, `нет подсказки для ${error.name}`);
      assert.ok(pattern.test(hint), `подсказка для ${error.name} не содержит ${pattern}: ${hint}`);
    }
  });

  await test('content-type определяется по расширению', () => {
    setEnv({ R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'i', R2_SECRET_ACCESS_KEY: 's', R2_BUCKET: 'b' });
    const r2 = require('../r2-client');
    assert.ok(r2.contentTypeFor('a.xlsx').includes('spreadsheetml'));
    assert.ok(r2.contentTypeFor('a.docx').includes('wordprocessingml'));
    assert.ok(r2.contentTypeFor('a.pdf') === 'application/pdf');
    assert.ok(r2.contentTypeFor('a.csv').includes('text/csv'));
    assert.ok(r2.contentTypeFor('a.json').includes('application/json'));
    assert.strictEqual(r2.contentTypeFor('a.unknownext'), 'application/octet-stream');
    assert.strictEqual(r2.contentTypeFor(''), 'application/octet-stream');
  });

  /* ================================================================== */
  console.log('\n— Интеграция с create_document —');
  /* ================================================================== */

  await test('create_document использует активный провайдер и возвращает ссылку', async () => {
    const mock = await startMockS3();
    setEnv({
      R2_ACCOUNT_ID: 'acc', R2_ACCESS_KEY_ID: 'id', R2_SECRET_ACCESS_KEY: 'secret',
      R2_BUCKET: 'yougile-docs', R2_ENDPOINT: mock.url, R2_PUBLIC_BASE_URL: mock.url,
      CLOUD_PROVIDER: 'r2',
    });
    for (const key of Object.keys(require.cache)) {
      if (/tool-executors|document-generator/.test(key)) delete require.cache[key];
    }
    const executors = require('../tool-executors');

    try {
      const result = await executors.createDocument(
        'txt',
        'Отчёт интеграционный',
        'Заголовок',
        'Содержимое отчёта',
        []
      );

      assert.strictEqual(result.success, true, `ошибка: ${result.error}`);
      assert.strictEqual(result.provider, 'r2');
      assert.ok(result.link.startsWith(mock.url), `link: ${result.link}`);
      assert.ok(/otchyot-integratsionnyy/.test(result.link), `имя не транслитерировано: ${result.link}`);
      assert.ok(result.size > 0);

      // Файл реально в бакете и временный файл удалён
      const key = result.fileId;
      assert.ok(mock.store.has(key), 'документ не попал в хранилище');
      assert.strictEqual(mock.store.get(key).body.toString(), 'Содержимое отчёта');

      const leaked = fs.readdirSync(os.tmpdir()).filter((f) => /otchyot|Отчёт/i.test(decodeURIComponent(f)));
      assert.deepStrictEqual(leaked, [], `временные файлы не удалены: ${leaked.join(', ')}`);
    } finally {
      await mock.close();
      for (const key of Object.keys(require.cache)) {
        if (/tool-executors|document-generator|lib[\\/](config|cloud)|r2-client/.test(key)) delete require.cache[key];
      }
      for (const k of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_ENDPOINT', 'R2_PUBLIC_BASE_URL', 'CLOUD_PROVIDER']) {
        delete process.env[k];
      }
      reloadConfig();
    }
  });

  await test('xlsx с несколькими листами загружается целиком', async () => {
    const mock = await startMockS3();
    setEnv({
      R2_ACCOUNT_ID: 'acc', R2_ACCESS_KEY_ID: 'id', R2_SECRET_ACCESS_KEY: 'secret',
      R2_BUCKET: 'b', R2_ENDPOINT: mock.url, R2_PUBLIC_BASE_URL: mock.url, CLOUD_PROVIDER: 'r2',
    });
    for (const key of Object.keys(require.cache)) {
      if (/tool-executors|document-generator/.test(key)) delete require.cache[key];
    }
    const executors = require('../tool-executors');

    try {
      const result = await executors.createDocument('xlsx', 'сравнение-конкурентов', '', '', [
        { name: 'Цены', headers: ['Товар', 'Цена'], rows: [['Ноутбук', '50000'], ['Мышь', '1500']] },
        { name: 'УТП', headers: ['Конкурент', 'УТП'], rows: [['A', 'доставка'], ['B', 'гарантия']] },
      ]);

      assert.strictEqual(result.success, true, result.error);
      const stored = mock.store.get(result.fileId);
      assert.ok(stored, 'файл не в хранилище');
      // xlsx — это zip, начинается с PK
      assert.strictEqual(stored.body.slice(0, 2).toString(), 'PK', 'не похоже на валидный xlsx');
      assert.ok(stored.body.length > 3000, `xlsx подозрительно маленький: ${stored.body.length} байт`);
    } finally {
      await mock.close();
      for (const k of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_ENDPOINT', 'R2_PUBLIC_BASE_URL', 'CLOUD_PROVIDER']) {
        delete process.env[k];
      }
      reloadConfig();
    }
  });

  /* ================================================================== */
  console.log('\n— Провайдер mongo: хранение без внешних сервисов и карт —');
  /* ================================================================== */

  /** Подмена модуля db заглушкой, чтобы не требовать реальную MongoDB. */
  function withFakeDb(run) {
    const dbPath = require.resolve('../db');
    const original = require.cache[dbPath];
    const stored = new Map();

    require.cache[dbPath] = {
      id: dbPath,
      filename: dbPath,
      loaded: true,
      exports: {
        COLLECTIONS: { files: 'stored_files' },
        storeFile: async ({ key, filename, contentType, data }) => {
          stored.set(key, {
            buffer: Buffer.isBuffer(data) ? data : Buffer.from(data),
            filename,
            contentType,
            size: (Buffer.isBuffer(data) ? data : Buffer.from(data)).length,
          });
          return key;
        },
        getFile: async (key) => stored.get(key) || null,
        countFiles: async () => stored.size,
        filesTotalBytes: async () => [...stored.values()].reduce((a, f) => a + f.size, 0),
      },
    };

    for (const key of Object.keys(require.cache)) {
      if (/lib[\\/]cloud\.js$/.test(key)) delete require.cache[key];
    }

    try {
      return run(require('../lib/cloud'), stored);
    } finally {
      if (original) require.cache[dbPath] = original;
      else delete require.cache[dbPath];
      for (const key of Object.keys(require.cache)) {
        if (/lib[\\/]cloud\.js$/.test(key)) delete require.cache[key];
      }
    }
  }

  await test('cloud: auto выбирает mongo, когда нет ни R2, ни pCloud, но есть база', () => {
    setEnv({
      R2_ACCOUNT_ID: null, R2_ACCESS_KEY_ID: null, R2_SECRET_ACCESS_KEY: null,
      R2_BUCKET: null, PCLOUD_AUTH_TOKEN: null,
      MONGODB_URI: 'mongodb://localhost:27017',
      CLOUD_PROVIDER: 'auto',
    });
    const cloud = require('../lib/cloud');
    assert.strictEqual(cloud.resolveProvider(), 'mongo');
    assert.strictEqual(cloud.isConfigured(), true);
  });

  await test('cloud mongo: документ сохраняется и получает постоянную подписанную ссылку', async () => {
    setEnv({
      R2_ACCOUNT_ID: null, R2_ACCESS_KEY_ID: null, R2_SECRET_ACCESS_KEY: null, R2_BUCKET: null,
      PCLOUD_AUTH_TOKEN: null, MONGODB_URI: 'mongodb://localhost:27017',
      CLOUD_PROVIDER: 'mongo',
      PUBLIC_BASE_URL: 'https://yougile-glm.onrender.com',
      ADMIN_TOKEN: 'mongo-files-secret',
    });

    const tmp = path.join(os.tmpdir(), `mongo-doc-${Date.now()}.xlsx`);
    fs.writeFileSync(tmp, 'байты таблицы');

    await withFakeDb(async (cloud, stored) => {
      try {
        const result = await cloud.upload(tmp, 'Отчёт.xlsx');

        assert.strictEqual(result.success, true, `ошибка: ${result.error}`);
        assert.strictEqual(result.provider, 'mongo');
        assert.ok(result.key.startsWith('mongo:'), `ключ: ${result.key}`);
        assert.strictEqual(result.viaProxy, true);
        assert.ok(result.link.startsWith('https://yougile-glm.onrender.com/files/'), result.link);
        assert.strictEqual(stored.size, 1, 'файл не сохранился');

        const file = [...stored.values()][0];
        assert.strictEqual(file.buffer.toString(), 'байты таблицы');
        assert.strictEqual(file.filename, 'Отчёт.xlsx');
        assert.ok(file.contentType.includes('spreadsheetml'), file.contentType);

        // Ссылка читается обратно через единый readFile
        const key = result.key;
        const parsed = new URL(result.link);
        const signature = parsed.pathname.split('/')[2];
        assert.strictEqual(parsed.searchParams.get('k'), key);

        const r2 = require('../r2-client');
        assert.strictEqual(r2.verifySignature(key, signature), true, 'подпись в ссылке невалидна');

        const read = await cloud.readFile(key);
        assert.ok(read, 'readFile не вернул файл');
        assert.strictEqual(read.buffer.toString(), 'байты таблицы');
        assert.strictEqual(read.filename, 'Отчёт.xlsx');
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    });
  });

  await test('cloud mongo: без ADMIN_TOKEN и PUBLIC_BASE_URL ссылка не создаётся, но ошибка понятна', async () => {
    setEnv({
      MONGODB_URI: 'mongodb://localhost:27017', CLOUD_PROVIDER: 'mongo',
      PUBLIC_BASE_URL: null, ADMIN_TOKEN: null, FILES_SECRET: null,
    });

    const tmp = path.join(os.tmpdir(), `mongo-nolink-${Date.now()}.txt`);
    fs.writeFileSync(tmp, 'текст');

    await withFakeDb(async (cloud) => {
      try {
        const result = await cloud.upload(tmp, 'заметка.txt');
        assert.strictEqual(result.success, false);
        assert.ok(/PUBLIC_BASE_URL/.test(result.error), result.error);
        assert.ok(/ADMIN_TOKEN|FILES_SECRET/.test(result.error), result.error);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    });
  });

  await test('cloud readFile: чужой и неизвестный префиксы не проходят', async () => {
    setEnv({ MONGODB_URI: 'mongodb://localhost:27017', CLOUD_PROVIDER: 'mongo' });

    await withFakeDb(async (cloud) => {
      assert.strictEqual(await cloud.readFile(''), null);
      assert.strictEqual(await cloud.readFile(null), null);
      assert.strictEqual(await cloud.readFile('mongo:несуществующий-id'), null);
      // Ключ без префикса mongo трактуется как R2; R2 не настроен — отдаём null,
      // а не бросаем: маршрут должен ответить 404, а не 500
      assert.strictEqual(await cloud.readFile('ai-documents/whatever.txt'), null);
    });
  });

  await test('cloud status: для mongo показывает объём занятого места', async () => {
    setEnv({
      MONGODB_URI: 'mongodb://localhost:27017', CLOUD_PROVIDER: 'mongo',
      PUBLIC_BASE_URL: 'https://x.onrender.com', ADMIN_TOKEN: 's',
    });

    await withFakeDb(async (cloud) => {
      const state = await cloud.status();
      assert.strictEqual(state.configured, true);
      assert.strictEqual(state.provider, 'mongo');
      assert.ok(/через сервер/.test(state.delivery), state.delivery);
      assert.strictEqual(typeof state.files, 'number');
    });
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
