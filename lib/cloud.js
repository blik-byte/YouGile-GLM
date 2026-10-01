// lib/cloud.js
// Единая точка загрузки документов в облако.
//
// Провайдер выбирается переменной CLOUD_PROVIDER:
//   r2     — Cloudflare R2 (рекомендуется: 10 ГБ бесплатно, токен создаётся
//            в дашборде мгновенно, ссылки раздаёт CDN, а не спящий dyno Render)
//   pcloud — pCloud. Работает только с OAuth2-токеном: в апреле 2026 pCloud
//            отключил парольную авторизацию и отозвал все выданные ею токены,
//            а OAuth-приложение выдаёт только поддержка по запросу.
//   none   — облако отключено
//   auto   — R2, если настроен; иначе pCloud, если настроен; иначе none (по умолчанию)
//
// Остальной код работает только с этим модулем, поэтому смена хранилища —
// вопрос одной переменной окружения, а не правки исходников.

const fs = require('fs/promises');
const path = require('path');

const crypto = require('crypto');

const { config } = require('./config');
const r2 = require('../r2-client');
const pcloud = require('../pcloud-client');
const db = require('../db');

/**
 * Активный провайдер. Определяется на каждый вызов, чтобы смена переменных
 * окружения в тестах подхватывалась без перезапуска.
 * @returns {'r2'|'pcloud'|'none'}
 */
function resolveProvider() {
  const requested = config.cloudProvider;

  if (['r2', 'pcloud', 'mongo', 'none'].includes(requested)) return requested;

  // auto
  if (r2.isConfigured()) return 'r2';
  if (pcloud.isConfigured()) return 'pcloud';
  if (config.mongodbUri) return 'mongo';
  return 'none';
}

function isConfigured() {
  return resolveProvider() !== 'none';
}

const NOT_CONFIGURED_HINT =
  'Два варианта настройки. (1) Без внешних сервисов и платёжных карт: ' +
  'CLOUD_PROVIDER=mongo — документы лежат в вашей MongoDB и раздаются через ' +
  'подписанные ссылки /files/...; нужны MONGODB_URI, PUBLIC_BASE_URL и ADMIN_TOKEN. ' +
  '(2) Cloudflare R2: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET. ' +
  'Подробности в README, раздел «Облачное хранилище».';

/**
 * Загрузка файла в облако и получение публичной ссылки.
 * Единая форма результата для всех провайдеров.
 *
 * @param {string} filePath
 * @param {string} filename
 * @returns {Promise<{success:boolean, provider:string, link?:string, downloadLink?:string,
 *                    filename?:string, size?:number, error?:string, hint?:string}>}
 */
async function upload(filePath, filename) {
  const provider = resolveProvider();
  const name = filename || path.basename(filePath);

  if (provider === 'none') {
    return {
      success: false,
      provider: 'none',
      error: `Облачное хранилище не настроено (CLOUD_PROVIDER=auto, ни R2, ни pCloud не заполнены). ${NOT_CONFIGURED_HINT}`,
    };
  }

  try {
    await fs.access(filePath);
  } catch {
    return { success: false, provider, error: `Файл не найден: ${filePath}` };
  }

  if (provider === 'mongo') {
    try {
      const buffer = await fs.readFile(filePath);
      const key = `mongo:${crypto.randomUUID()}`;

      await db.storeFile({
        key,
        filename: name,
        contentType: r2.contentTypeFor(name),
        data: buffer,
        metadata: { source: 'yougile-ai-agent', uploaded: new Date().toISOString() },
      });

      const link = r2.proxyUrl(key, name);
      if (!link) {
        return {
          success: false,
          provider: 'mongo',
          key,
          size: buffer.length,
          error:
            'Файл сохранён в MongoDB, но ссылку отдать нечем: задайте PUBLIC_BASE_URL ' +
            'и ADMIN_TOKEN (или FILES_SECRET) — они подписывают ссылки /files/...',
        };
      }

      return {
        success: true,
        provider: 'mongo',
        key,
        fileId: key,
        filename: name,
        size: buffer.length,
        contentType: r2.contentTypeFor(name),
        link,
        downloadLink: link,
        viaProxy: true,
      };
    } catch (error) {
      console.error(`❌ Сохранение в MongoDB: ${error.message}`);
      return { success: false, provider: 'mongo', error: error.message };
    }
  }

  if (provider === 'r2') {
    const result = await r2.uploadFile(filePath, { filename: name });
    return { ...result, provider: 'r2' };
  }

  const result = await pcloud.upload(filePath, name);
  return { ...result, provider: 'pcloud' };
}

/**
 * Чтение файла по ключу из подписанной ссылки.
 * Ключ несёт префикс провайдера: "mongo:<uuid>" или ключ объекта R2.
 * Используется маршрутом GET /files/<подпись>/<имя>.
 *
 * @returns {Promise<{buffer?: Buffer, body?: any, contentType: string, filename?: string, size?: number}|null>}
 */
async function readFile(key) {
  if (!key) return null;

  if (key.startsWith('mongo:')) {
    const file = await db.getFile(key);
    if (!file) return null;
    return { buffer: file.buffer, contentType: file.contentType, filename: file.filename, size: file.size };
  }

  if (!r2.isConfigured()) return null;
  const object = await r2.getObject(key);
  if (!object) return null;
  return object;
}

/**
 * Состояние хранилища для дашборда и /stats.
 * @returns {Promise<object>}
 */
async function status() {
  const provider = resolveProvider();

  if (provider === 'none') {
    return {
      configured: false,
      provider: 'none',
      requested: config.cloudProvider,
      r2Configured: r2.isConfigured(),
      pcloudConfigured: pcloud.isConfigured(),
      hint: NOT_CONFIGURED_HINT,
    };
  }

  if (provider === 'r2') {
    const details = await r2.selfTest().catch((error) => ({ configured: false, error: error.message }));
    return {
      configured: Boolean(details.configured),
      provider: 'r2',
      bucket: config.r2Bucket,
      endpoint: r2.endpoint(),
      delivery: config.r2PublicBaseUrl ? 'публичный домен' : 'через сервер (бакет приватный)',
      publicBaseUrl: config.r2PublicBaseUrl || null,
      objects: details.objects ?? null,
      error: details.error || null,
      hint: details.hint || null,
    };
  }

  if (provider === 'mongo') {
    const [count, bytes] = await Promise.all([db.countFiles(), db.filesTotalBytes()]);
    return {
      configured: true,
      provider: 'mongo',
      database: config.mongoDbName,
      delivery: 'через сервер (подписанные ссылки)',
      files: count,
      totalMb: bytes !== null && bytes !== undefined ? Number((bytes / 1024 ** 2).toFixed(2)) : null,
    };
  }

  // pCloud
  const details = await pcloud.selfTest().catch((error) => ({ configured: false, error: error.message }));
  return {
    configured: Boolean(details.configured),
    provider: 'pcloud',
    region: config.pcloudRegion,
    email: details.email || null,
    quotaGb: details.quota ? Number((details.quota / 1024 ** 3).toFixed(2)) : null,
    usedGb: details.used ? Number((details.used / 1024 ** 3).toFixed(2)) : null,
    error: details.error || null,
    hint:
      'pCloud отключил парольную авторизацию в апреле 2026 — нужен OAuth2-токен, ' +
      'который выдаёт только поддержка pCloud по запросу.',
  };
}

/** Проверка конфигурации при старте приложения. */
async function selfTest() {
  const state = await status();

  if (!state.configured) {
    console.warn(`⚠️ Облачное хранилище недоступно (${state.provider}). ${state.hint || ''}`.trim());
    return state;
  }

  return state;
}

module.exports = {
  upload,
  readFile,
  status,
  selfTest,
  resolveProvider,
  isConfigured,
  NOT_CONFIGURED_HINT,
};
