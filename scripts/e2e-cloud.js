// scripts/e2e-cloud.js
// Сквозная проверка облачного хранилища: мок-S3 → создание документа →
// загрузка → скачивание через прокси-маршрут /files/<подпись> → дашборд.
// Запуск: node scripts/e2e-cloud.js   (не входит в npm test — поднимает серверы)

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MOCK_PORT = 4321;
const APP_PORT = 4123;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const ADMIN_TOKEN = 'e2e-admin-secret';

const store = new Map();
const results = [];

function check(name, condition, extra = '') {
  results.push({ name, ok: Boolean(condition), extra });
  console.log(`  ${condition ? '✅' : '❌'} ${name}${extra && !condition ? ` — ${extra}` : ''}`);
}

async function main() {
  console.log('\n🔗 Сквозная проверка облачного хранилища\n');

  /* ---------- мок S3-совместимого хранилища ---------- */
  const mock = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const [, , ...rest] = url.pathname.split('/');
    const key = decodeURIComponent(rest.join('/'));

    if (req.method === 'PUT') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      store.set(key, {
        body: Buffer.concat(chunks),
        contentType: req.headers['content-type'],
        disposition: req.headers['content-disposition'],
        auth: req.headers.authorization,
      });
      res.setHeader('ETag', '"mock"');
      return res.end();
    }

    if (url.searchParams.get('list-type') === '2') {
      res.setHeader('Content-Type', 'application/xml');
      return res.end('<?xml version="1.0"?><ListBucketResult><KeyCount>0</KeyCount></ListBucketResult>');
    }

    if (req.method === 'GET') {
      const object = store.get(key);
      if (!object) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/xml');
        return res.end('<?xml version="1.0"?><Error><Code>NoSuchKey</Code></Error>');
      }
      res.setHeader('Content-Type', object.contentType);
      res.setHeader('Content-Length', String(object.body.length));
      if (object.disposition) res.setHeader('Content-Disposition', object.disposition);
      return res.end(object.body);
    }

    if (req.method === 'HEAD') {
      res.statusCode = 200;
      return res.end();
    }

    res.statusCode = 405;
    res.end();
  });

  await new Promise((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve));
  console.log(`  мок-S3 запущен на :${MOCK_PORT}`);

  /* ---------- окружение приложения ---------- */
  Object.assign(process.env, {
    R2_ENDPOINT: `http://127.0.0.1:${MOCK_PORT}`,
    R2_ACCOUNT_ID: 'acc',
    R2_ACCESS_KEY_ID: 'keyid',
    R2_SECRET_ACCESS_KEY: 'secretkey',
    R2_BUCKET: 'yougile-docs',
    CLOUD_PROVIDER: 'r2',
    ADMIN_TOKEN,
    PUBLIC_BASE_URL: BASE,
    PORT: String(APP_PORT),
    ZAI_API_KEY: 'fake',
    YOUGILE_API_KEY: 'fake',
    REPORT_TZ: 'Europe/Moscow',
    COLUMN_TO_EXECUTE: 'col-1',
    TELEGRAM_ADMIN_IDS: '123',
  });

  console.log('  поднимаю приложение...');
  const originalExit = process.exit;
  process.exit = () => {}; // не даём graceful shutdown убить тест
  require('../index.js');
  process.exit = originalExit;

  await new Promise((resolve) => setTimeout(resolve, 3500));

  /* ---------- 1. создание документа ---------- */
  console.log('\n— Создание документа —');
  const executors = require('../tool-executors');
  const doc = await executors.createDocument(
    'txt',
    'Отчёт сквозной проверки',
    'Заголовок',
    'Содержимое документа для проверки',
    []
  );

  check('create_document вернул success', doc.success === true, doc.error);
  check('провайдер — r2', doc.provider === 'r2', doc.provider);
  check('есть ссылка', Boolean(doc.link), JSON.stringify(doc));
  check('ссылка ведёт через наш сервер (бакет приватный)', doc.link && doc.link.startsWith(`${BASE}/files/`), doc.link);
  check('файл реально лёг в хранилище', store.has(doc.fileId));

  const stored = store.get(doc.fileId);
  if (stored) {
    check('содержимое не искажено', stored.body.toString() === 'Содержимое документа для проверки');
    check('запрос подписан по SigV4', /AWS4-HMAC-SHA256/.test(stored.auth || ''), stored.auth);
    check('Content-Type по расширению', /text\/plain/.test(stored.contentType || ''), stored.contentType);
    check(
      'кириллическое имя сохранено в Content-Disposition',
      (stored.disposition || '').includes(encodeURIComponent('Отчёт сквозной проверки.txt')),
      stored.disposition
    );
    check('ключ транслитерирован', /otchyot-skvoznoproverki|otchyot-skvoznoy/.test(doc.fileId), doc.fileId);
  }

  /* ---------- 2. скачивание через прокси ---------- */
  console.log('\n— Скачивание по ссылке —');
  const fetched = await fetch(doc.link);
  const body = await fetched.text();

  check('HTTP 200', fetched.status === 200, String(fetched.status));
  check('содержимое совпадает', body === 'Содержимое документа для проверки', body);
  check('Content-Type проброшен', /text\/plain/.test(fetched.headers.get('content-type') || ''));
  check('Content-Disposition проброшен', Boolean(fetched.headers.get('content-disposition')));

  /* ---------- 3. защита подписи ---------- */
  console.log('\n— Защита ссылок —');
  const signature = doc.link.split('/files/')[1].split('/')[0];

  const forged = await fetch(`${BASE}/files/ПОДДЕЛКА/x.txt?k=${encodeURIComponent(doc.fileId)}`);
  check('подделанная подпись → 403', forged.status === 403, String(forged.status));

  const stolen = await fetch(`${BASE}/files/${signature}/y.txt?k=${encodeURIComponent('ai-documents/secret.txt')}`);
  check('подпись не подходит к чужому ключу → 403', stolen.status === 403, String(stolen.status));

  const validKey = 'ai-documents/2099/01/none.txt';
  const validSig = crypto.createHmac('sha256', ADMIN_TOKEN).update(validKey).digest('base64url');
  const missing = await fetch(`${BASE}/files/${validSig}/none.txt?k=${encodeURIComponent(validKey)}`);
  check('валидная подпись, файла нет → 404', missing.status === 404, String(missing.status));

  const noKey = await fetch(`${BASE}/files/${signature}/x.txt`);
  check('нет ключа объекта → 400', noKey.status === 400, String(noKey.status));

  /* ---------- 4. дашборд ---------- */
  console.log('\n— Дашборд —');
  const dashResponse = await fetch(`${BASE}/api/dashboard`, { headers: { 'X-Admin-Token': ADMIN_TOKEN } });
  const raw = await dashResponse.text();
  let dash = {};
  try { dash = JSON.parse(raw); } catch { /* не JSON */ }

  check('дашборд доступен с токеном', dashResponse.status === 200,
    `HTTP ${dashResponse.status}: ${raw.slice(0, 300)}`);
  const cloudState = dash.services?.cloud?.data || {};
  check('R2 показан как подключённый', cloudState.configured === true, JSON.stringify(cloudState));
  check('провайдер — r2', cloudState.provider === 'r2', cloudState.provider);
  check('бакет отображается', cloudState.bucket === 'yougile-docs', cloudState.bucket);
  check('режим отдачи — через сервер', /через сервер/.test(cloudState.delivery || ''), cloudState.delivery);

  const cloudWarning = (dash.warnings || []).find((w) => /облачн|pCloud|R2/i.test(w.text));
  check('нет предупреждения о ненастроенном облаке', !cloudWarning, cloudWarning && cloudWarning.text);

  const denied = await fetch(`${BASE}/api/dashboard`);
  check('дашборд без токена → 401', denied.status === 401, String(denied.status));

  /* ---------- 5. открытые маршруты ---------- */
  console.log('\n— Публичные маршруты —');
  const health = await fetch(`${BASE}/health`);
  check('/health открыт', health.status === 200);
  const root = await fetch(`${BASE}/`);
  check('/ отдаёт дашборд', root.status === 200 && /text\/html/.test(root.headers.get('content-type') || ''));

  /* ---------- итог ---------- */
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Всего: ${results.length} | ✅ ${results.length - failed.length} | ❌ ${failed.length}`);
  if (failed.length > 0) {
    console.log('\nПровалены:');
    for (const f of failed) console.log(`  • ${f.name}${f.extra ? ` — ${f.extra}` : ''}`);
  }
  console.log('='.repeat(60));

  mock.close();
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('💥', error);
  process.exit(1);
});
