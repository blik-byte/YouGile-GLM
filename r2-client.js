// r2-client.js
// Клиент Cloudflare R2 (S3-совместимое объектное хранилище).
//
// Почему R2:
//   • 10 ГБ бесплатно, без оплаты исходящего трафика (egress) — у S3 он платный;
//   • API-токен создаётся в дашборде мгновенно, без писем в поддержку
//     (в отличие от pCloud, который с апреля 2026 отключил парольную
//     авторизацию и выдаёт OAuth-приложения только по запросу);
//   • публичные ссылки раздаёт CDN Cloudflare, а не наш спящий dyno Render —
//     документ открывается мгновенно, без холодного старта в 30-60 секунд.
//
// Два способа отдачи файлов:
//   1. R2_PUBLIC_BASE_URL задан → прямая ссылка на CDN (бакет публичный).
//   2. Не задан → ссылка через наш сервер (/files/<token>), бакет остаётся
//      приватным. Для бизнес-документов это предпочтительнее: файл доступен
//      только обладателю подписанной ссылки.
//
// Документация: https://developers.cloudflare.com/r2/

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { S3Client, PutObjectCommand, GetObjectCommand, HeadBucketCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');

const { config } = require('./lib/config');
const { sanitizeFilename, transliterate } = require('./lib/text');

const MIME_TYPES = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.doc': 'application/msword',
  '.xls': 'application/vnd.ms-excel',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

function contentTypeFor(filename) {
  return MIME_TYPES[path.extname(String(filename || '')).toLowerCase()] || 'application/octet-stream';
}

/**
 * Хост S3-API. Зависит от юрисдикции бакета:
 *   default → https://<acc>.r2.cloudflarestorage.com
 *   eu      → https://<acc>.eu.r2.cloudflarestorage.com
 */
/**
 * Хост S3 API.
 * По умолчанию выводится из R2_ACCOUNT_ID и юрисдикции бакета:
 *   default → https://<acc>.r2.cloudflarestorage.com
 *   eu      → https://<acc>.eu.r2.cloudflarestorage.com
 * Переменная R2_ENDPOINT переопределяет его целиком — используется в тестах
 * и позволяет работать с любым другим S3-совместимым хранилищем.
 */
function endpoint() {
  if (config.r2Endpoint) return config.r2Endpoint;
  const jurisdiction = config.r2Jurisdiction ? `${config.r2Jurisdiction}.` : '';
  return `https://${config.r2AccountId}.${jurisdiction}r2.cloudflarestorage.com`;
}

function isConfigured() {
  return Boolean(
    config.r2AccountId && config.r2AccessKeyId && config.r2SecretAccessKey && config.r2Bucket
  );
}

function describeNotConfigured() {
  const missing = [
    !config.r2AccountId && 'R2_ACCOUNT_ID',
    !config.r2AccessKeyId && 'R2_ACCESS_KEY_ID',
    !config.r2SecretAccessKey && 'R2_SECRET_ACCESS_KEY',
    !config.r2Bucket && 'R2_BUCKET',
  ].filter(Boolean);

  return `Cloudflare R2 не настроен: не заданы ${missing.join(', ')}.`;
}

let clientRef = null;

function getClient() {
  if (clientRef) return clientRef;

  if (!isConfigured()) throw new Error(describeNotConfigured());

  clientRef = new S3Client({
    region: config.r2Region || 'auto',
    endpoint: endpoint(),
    credentials: {
      accessKeyId: config.r2AccessKeyId,
      secretAccessKey: config.r2SecretAccessKey,
    },
    requestHandler: {
      requestTimeout: config.r2TimeoutMs,
      connectionTimeout: 15000,
    },
    // R2 не поддерживает все проверки S3 — отключаем лишние обращения
    forcePathStyle: true,
  });

  return clientRef;
}

/**
 * Ключ объекта в бакете.
 * Структура: <prefix>/<год>/<месяц>/<метка времени>-<случайный суффикс>-<латинское имя>.<ext>
 *
 * Имя транслитерируется, чтобы URL оставался чистым и не требовал сложного
 * экранирования, а исходное кириллическое имя сохраняется в Content-Disposition —
 * при скачивании файл получит правильное имя.
 */
function buildObjectKey(filename) {
  const safe = sanitizeFilename(filename, 'document');
  const extension = path.extname(safe).toLowerCase();
  const base = path.basename(safe, extension);

  const now = new Date();
  const stamp = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const unique = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const latin = transliterate(base).slice(0, 80) || 'document';

  const prefix = config.r2Prefix ? config.r2Prefix.replace(/^\/+|\/+$/g, '') : '';
  const parts = [prefix, stamp, `${unique}-${latin}${extension}`].filter(Boolean);

  return parts.join('/');
}

/** Публичная ссылка на объект (если задан R2_PUBLIC_BASE_URL). */
function publicUrl(key) {
  if (!config.r2PublicBaseUrl) return null;
  return `${config.r2PublicBaseUrl}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * Подпись для прокси-ссылки /files/<token>.
 * HMAC от ключа объекта: зная подпись, нельзя подделать её для другого файла,
 * а перебрать ключи без секрета невозможно.
 */
function signKey(key) {
  if (!config.filesSecret) return null;
  return crypto.createHmac('sha256', config.filesSecret).update(key).digest('base64url');
}

function verifySignature(key, signature) {
  const expected = signKey(key);
  if (!expected || typeof signature !== 'string') return false;

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Ссылка через наш сервер — работает даже когда бакет приватный. */
function proxyUrl(key, filename) {
  if (!config.publicBaseUrl || !config.filesSecret) return null;
  const name = encodeURIComponent(sanitizeFilename(filename || path.basename(key), 'document'));
  return `${config.publicBaseUrl.replace(/\/+$/, '')}/files/${signKey(key)}/${name}?k=${encodeURIComponent(key)}`;
}

/**
 * Загрузка файла в бакет.
 * @param {string} filePath - локальный путь
 * @param {object} [options]
 * @param {string} [options.filename] - имя для ссылки и Content-Disposition
 * @param {string} [options.key] - задать ключ явно (иначе генерируется)
 * @returns {Promise<object>}
 */
async function uploadFile(filePath, options = {}) {
  if (!isConfigured()) return { success: false, provider: 'r2', error: describeNotConfigured() };

  const filename = options.filename || path.basename(filePath);
  const key = options.key || buildObjectKey(filename);

  let body;
  try {
    body = await fs.readFile(filePath);
  } catch (error) {
    return { success: false, provider: 'r2', error: `Не удалось прочитать файл: ${error.message}` };
  }

  console.log(`📤 R2: загружаю ${filename} (${(body.length / 1024).toFixed(1)} КБ) → ${key}`);

  try {
    // Имя файла для скачивания, включая кириллицу (RFC 5987)
    const asciiName = transliterate(path.basename(filename)).slice(0, 100) || 'document';
    const disposition = `inline; filename="${asciiName.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(
      path.basename(filename)
    )}`;

    await getClient().send(
      new PutObjectCommand({
        Bucket: config.r2Bucket,
        Key: key,
        Body: body,
        ContentType: contentTypeFor(filename),
        ContentDisposition: disposition,
        CacheControl: 'public, max-age=31536000, immutable',
        Metadata: {
          source: 'yougile-ai-agent',
          uploaded: new Date().toISOString(),
        },
      })
    );

    const link = publicUrl(key) || proxyUrl(key, filename);

    if (!link) {
      return {
        success: false,
        provider: 'r2',
        key,
        size: body.length,
        error:
          'Файл загружен в R2, но ссылку отдать нечем: задайте R2_PUBLIC_BASE_URL ' +
          '(публичный домен бакета) либо ADMIN_TOKEN/FILES_SECRET и PUBLIC_BASE_URL (раздача через сервер).',
      };
    }

    console.log(`✅ R2: файл доступен → ${link.slice(0, 120)}`);

    return {
      success: true,
      provider: 'r2',
      key,
      fileId: key,
      filename: path.basename(filename),
      size: body.length,
      contentType: contentTypeFor(filename),
      link,
      downloadLink: link,
      viaProxy: !publicUrl(key),
    };
  } catch (error) {
    console.error(`❌ R2 upload: ${error.message}`);
    return {
      success: false,
      provider: 'r2',
      key,
      error: error.message,
      hint: diagnose(error),
    };
  }
}

/** Расшифровка типичных ошибок S3/R2 в понятные сообщения. */
function diagnose(error) {
  const name = error?.name || '';
  const message = String(error?.message || '');

  if (name === 'NoSuchBucket' || /NoSuchBucket/.test(message)) {
    return `Бакет "${config.r2Bucket}" не найден. Проверьте R2_BUCKET и R2_JURISDICTION.`;
  }
  if (name === 'AccessDenied' || /AccessDenied|403/.test(message)) {
    return 'Токен R2 не имеет прав на запись в этот бакет. Пересоздайте токен с разрешением "Object Read & Write" и областью действия на нужный бакет.';
  }
  if (name === 'InvalidAccessKeyId' || /InvalidAccessKeyId/.test(message)) {
    return 'Неверный R2_ACCESS_KEY_ID.';
  }
  if (/SignatureDoesNotMatch/.test(message)) {
    return 'Неверный R2_SECRET_ACCESS_KEY.';
  }
  if (/getaddrinfo|ENOTFOUND|fetch failed/i.test(message)) {
    return `Не удалось достучаться до ${endpoint()}. Проверьте R2_ACCOUNT_ID и R2_JURISDICTION.`;
  }
  if (/timeout|Timeout/.test(message)) {
    return 'Превышено время загрузки. Увеличьте R2_TIMEOUT_MS.';
  }
  return null;
}

/**
 * Чтение объекта — используется прокси-маршрутом /files/<token>.
 * @returns {Promise<{body: import('stream').Readable, contentType: string, size: number}|null>}
 */
async function getObject(key) {
  if (!isConfigured()) return null;

  try {
    const response = await getClient().send(
      new GetObjectCommand({ Bucket: config.r2Bucket, Key: key })
    );

    if (!response.Body) return null;

    return {
      body: response.Body,
      contentType: response.ContentType || contentTypeFor(key),
      size: Number(response.ContentLength || 0),
      disposition: response.ContentDisposition || null,
    };
  } catch (error) {
    if (error.name === 'NoSuchKey' || /NoSuchKey/.test(error.message)) return null;
    throw error;
  }
}

/** Проверка конфигурации при старте. */
async function selfTest() {
  if (!isConfigured()) {
    console.warn(`⚠️ ${describeNotConfigured()}`);
    return { configured: false };
  }

  try {
    await getClient().send(new HeadBucketCommand({ Bucket: config.r2Bucket }));

    const mode = config.r2PublicBaseUrl ? `публичный домен ${config.r2PublicBaseUrl}` : 'раздача через сервер';
    console.log(`✅ Cloudflare R2 подключен: бакет "${config.r2Bucket}" (${mode})`);

    // Подсчёт объектов — отдельно и необязательно: токен с правом
    // «Object Read & Write» на конкретный бакет может не иметь доступа к листингу
    let objects = null;
    try {
      const listing = await getClient().send(
        new ListObjectsV2Command({ Bucket: config.r2Bucket, MaxKeys: 1 })
      );
      objects = listing.KeyCount ?? null;
    } catch {
      /* не критично */
    }

    return { configured: true, bucket: config.r2Bucket, objects, mode };
  } catch (error) {
    console.error(`❌ R2 self-test: ${error.message}`);
    const hint = diagnose(error);
    if (hint) console.error(`   ${hint}`);
    return { configured: false, error: error.message, hint };
  }
}

module.exports = {
  uploadFile,
  getObject,
  selfTest,
  isConfigured,
  buildObjectKey,
  publicUrl,
  proxyUrl,
  signKey,
  verifySignature,
  contentTypeFor,
  endpoint,
  diagnose,
};
