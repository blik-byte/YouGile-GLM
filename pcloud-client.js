// pcloud-client.js
// Клиент pCloud — основное облачное хранилище проекта.
//
// Почему pCloud, а не Google Drive: Service Account в Google Drive не имеет
// собственной квоты хранилища, поэтому загрузка падала. pCloud даёт квоту
// обычному аккаунту и простой HTTP JSON API.
//
// Авторизация. OAuth-приложение pCloud новым разработчикам создавать не даёт,
// поэтому используется прямой токен:
//   1. PCLOUD_AUTH_TOKEN — основной вариант (получается один раз командой
//      `npm run pcloud:token` и кладётся в переменные окружения Render).
//   2. PCLOUD_EMAIL + PCLOUD_PASSWORD — запасной: токен запрашивается методом
//      userinfo?getauth=1 и кэшируется в памяти процесса.
//
// Регион: PCLOUD_REGION=eu (eapi.pcloud.com) или us (api.pcloud.com).
// Хост зависит от региона аккаунта, при неверном регионе API отвечает ошибкой.
//
// Документация: https://docs.pcloud.com/

const fs = require('fs/promises');
const path = require('path');
const { fetchWithTimeout, sleep } = require('./lib/http');
const { config } = require('./lib/config');
const { sanitizeFilename } = require('./lib/text');

const HOSTS = {
  eu: 'https://eapi.pcloud.com',
  us: 'https://api.pcloud.com',
};

/** Коды ошибок pCloud → понятное человеку сообщение. */
const ERROR_CODES = {
  1000: 'Требуется авторизация (нет или недействителен токен)',
  1001: 'Некорректный токен авторизации',
  1004: 'Не передан обязательный параметр',
  2000: 'Ошибка входа: неверный логин или пароль',
  2001: 'Недопустимое имя файла или папки',
  2002: 'Родительская папка не существует',
  2003: 'Доступ запрещён: недостаточно прав',
  2005: 'Папка не существует',
  2008: 'Превышена квота хранилища',
  2009: 'Файл не найден',
  2010: 'Некорректный путь',
  2014: 'Подтвердите email аккаунта pCloud',
  2026: 'Можно делиться только своими файлами',
  2041: 'Соединение разорвано во время загрузки',
  4000: 'Слишком много попыток входа с этого IP — попробуйте позже',
  5000: 'Внутренняя ошибка pCloud — попробуйте позже',
  5001: 'Внутренняя ошибка загрузки',
};

class PCloudError extends Error {
  constructor(result, message, extra = {}) {
    super(`pCloud [${result}]: ${message}`);
    this.name = 'PCloudError';
    this.result = result;
    Object.assign(this, extra);
  }
}

let cachedToken = null;
let cachedTokenAt = 0;
const TOKEN_TTL_MS = 60 * 60 * 1000; // перечитываем env-токен раз в час

function host() {
  return HOSTS[config.pcloudRegion] || HOSTS.eu;
}

function isConfigured() {
  return Boolean(config.pcloudAuthToken || (config.pcloudEmail && config.pcloudPassword));
}

function describeNotConfigured() {
  return (
    'pCloud не настроен. Задайте PCLOUD_AUTH_TOKEN (получается командой `npm run pcloud:token`) ' +
    `и PCLOUD_REGION=${config.pcloudRegion}. ` +
    'Пока облако недоступно — создайте документ и передайте содержимое текстом в комментарии к задаче.'
  );
}

/**
 * Получение токена: из переменной окружения либо по логину/паролю.
 * @returns {Promise<string>}
 */
async function getToken({ force = false } = {}) {
  if (!force && cachedToken && Date.now() - cachedTokenAt < TOKEN_TTL_MS) return cachedToken;

  if (config.pcloudAuthToken) {
    cachedToken = config.pcloudAuthToken;
    cachedTokenAt = Date.now();
    return cachedToken;
  }

  if (!config.pcloudEmail || !config.pcloudPassword) {
    throw new PCloudError(1000, describeNotConfigured());
  }

  const url = new URL(`${host()}/userinfo`);
  url.searchParams.set('getauth', '1');
  url.searchParams.set('username', config.pcloudEmail);
  url.searchParams.set('password', config.pcloudPassword);

  const response = await fetchWithTimeout(url.toString(), { method: 'GET' }, { timeout: config.pcloudTimeoutMs });
  const data = await response.json().catch(() => null);

  if (!data || data.result !== 0 || !data.auth) {
    const code = data?.result ?? response.status;
    throw new PCloudError(code, ERROR_CODES[code] || data?.error || 'Не удалось получить токен');
  }

  cachedToken = data.auth;
  cachedTokenAt = Date.now();
  console.log('✅ pCloud: токен получен по логину/паролю');
  return cachedToken;
}

/**
 * Универсальный вызов метода pCloud.
 * @param {string} method - например 'listfolder'
 * @param {object} [params] - query-параметры
 * @param {object} [options]
 * @param {boolean} [options.retryOnAuth=true] - при ошибке 1000/1001 один раз перечитать токен
 * @returns {Promise<object>}
 */
async function call(method, params = {}, options = {}) {
  const { retryOnAuth = true } = options;

  if (!isConfigured()) throw new PCloudError(1000, describeNotConfigured());

  const token = await getToken();
  const url = new URL(`${host()}/${method}`);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetchWithTimeout(
    url.toString(),
    { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
    { timeout: config.pcloudTimeoutMs }
  );

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new PCloudError(response.status, `pCloud вернул не-JSON: ${text.slice(0, 200)}`);
  }

  // Токен протух или отозван — пробуем один раз получить новый
  if ((data.result === 1000 || data.result === 1001) && retryOnAuth && config.pcloudEmail) {
    console.warn('⚠️ pCloud: токен не принят, запрашиваю новый по логину/паролю');
    cachedToken = null;
    await getToken({ force: true });
    return call(method, params, { ...options, retryOnAuth: false });
  }

  if (data.result !== 0) {
    throw new PCloudError(data.result, ERROR_CODES[data.result] || data.error || 'Неизвестная ошибка', { data });
  }

  return data;
}

/**
 * Загрузка файла методом uploadfile (multipart/form-data).
 * Документы агента весят единицы мегабайт, поэтому простой путь без
 * getuploadlink здесь уместен.
 *
 * @param {string} filePath - локальный путь
 * @param {object} [options]
 * @param {string} [options.filename]
 * @param {number} [options.folderId=0] - 0 = корень диска
 * @param {boolean} [options.renameIfExists=true]
 * @returns {Promise<{success:true, provider:'pcloud', fileId:number, name:string, size:number, metadata:object}>}
 */
async function uploadFile(filePath, options = {}) {
  if (!isConfigured()) return { success: false, provider: 'pcloud', error: describeNotConfigured() };

  const originalName = options.filename || path.basename(filePath);
  const filename = sanitizeFilename(originalName, 'document');
  const folderId = options.folderId ?? config.pcloudFolderId ?? 0;

  let buffer;
  try {
    buffer = await fs.readFile(filePath);
  } catch (error) {
    return { success: false, provider: 'pcloud', error: `Не удалось прочитать файл: ${error.message}` };
  }

  console.log(`📤 pCloud: загружаю ${filename} (${(buffer.length / 1024).toFixed(1)} КБ) в папку ${folderId}`);

  try {
    const token = await getToken();

    // Параметры обязаны идти ДО файлов — это требование pCloud
    const form = new FormData();
    form.append('folderid', String(folderId));
    form.append('filename', filename);
    form.append('nopartial', '1');
    form.append('renameifexists', options.renameIfExists === false ? '0' : '1');
    form.append('file', new Blob([buffer]), filename);

    const url = new URL(`${host()}/uploadfile`);

    let response;
    let lastError;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await fetchWithTimeout(
          url.toString(),
          { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form },
          { timeout: Math.max(config.pcloudTimeoutMs, 120000) }
        );
        break;
      } catch (error) {
        lastError = error;
        if (attempt === 2) throw error;
        const delay = 2000 * 2 ** attempt;
        console.warn(`⏳ pCloud: загрузка не удалась (${error.message}), повтор через ${delay / 1000}с`);
        await sleep(delay);
      }
    }

    const data = await response.json().catch(() => null);

    if (!data || data.result !== 0) {
      const code = data?.result ?? response.status;
      throw new PCloudError(code, ERROR_CODES[code] || data?.error || 'Загрузка не удалась', { data });
    }

    const metadata = Array.isArray(data.metadata) ? data.metadata[0] : null;
    const fileId = Array.isArray(data.fileids) ? data.fileids[0] : metadata?.fileid;

    if (!fileId) {
      throw new PCloudError(5001, 'pCloud не вернул fileid', { data });
    }

    console.log(`✅ pCloud: файл загружен, fileid=${fileId}`);

    return {
      success: true,
      provider: 'pcloud',
      fileId,
      name: metadata?.name || filename,
      size: metadata?.size ?? buffer.length,
      path: metadata?.path || null,
      metadata,
    };
  } catch (error) {
    console.error(`❌ pCloud upload: ${error.message}`);
    return { success: false, provider: 'pcloud', error: error.message, code: error.result };
  }
}

/**
 * Публичная ссылка на файл — то, что агент кладёт в комментарий задачи.
 * @param {number|string} fileId
 * @param {object} [options]
 * @param {boolean} [options.shortlink=true] - дополнительно короткая ссылка pc.cd
 * @returns {Promise<{success:boolean, link?:string, shortlink?:string, code?:string, linkId?:number, downloadLink?:string, error?:string}>}
 */
async function getPublicLink(fileId, options = {}) {
  try {
    const data = await call('getfilepublink', {
      fileid: fileId,
      shortlink: options.shortlink === false ? undefined : 1,
    });

    const result = {
      success: true,
      provider: 'pcloud',
      code: data.code,
      linkId: data.linkid,
      link: data.link || null,
      shortlink: data.shortlink || null,
    };

    // Прямая ссылка на скачивание — удобнее для документов
    if (data.code) {
      try {
        const download = await call('getpublinkdownload', { code: data.code });
        if (Array.isArray(download.hosts) && download.hosts.length > 0 && download.path) {
          result.downloadLink = `https://${download.hosts[0]}${download.path}`;
        }
      } catch (error) {
        console.warn(`⚠️ pCloud: не удалось получить прямую ссылку: ${error.message}`);
      }
    }

    // Если API не вернул ссылку — собираем её сами из кода
    if (!result.link && result.code) {
      result.link =
        config.pcloudRegion === 'eu'
          ? `https://e.pcloud.link/publink/show?code=${result.code}`
          : `https://my.pcloud.com/publink/show?code=${result.code}`;
    }

    return result;
  } catch (error) {
    return { success: false, provider: 'pcloud', error: error.message, code: error.result };
  }
}

/**
 * Папка для документов агента. Создаётся один раз, ID кэшируется.
 * Используется, если PCLOUD_FOLDER_ID не задан, но задано имя папки.
 */
let resolvedFolderId = null;

async function resolveFolderId() {
  if (resolvedFolderId !== null) return resolvedFolderId;
  if (config.pcloudFolderId && config.pcloudFolderId !== 0) {
    resolvedFolderId = config.pcloudFolderId;
    return resolvedFolderId;
  }
  if (!config.pcloudFolderName) {
    resolvedFolderId = 0;
    return resolvedFolderId;
  }

  try {
    const data = await call('createfolderifnotexists', {
      folderid: 0,
      name: config.pcloudFolderName,
    });
    resolvedFolderId = data.metadata?.folderid ?? 0;
    console.log(`📁 pCloud: папка «${config.pcloudFolderName}» → id ${resolvedFolderId}`);
  } catch (error) {
    console.warn(`⚠️ pCloud: не удалось подготовить папку (${error.message}), использую корень диска`);
    resolvedFolderId = 0;
  }

  return resolvedFolderId;
}

/**
 * Загрузка файла и получение публичной ссылки одним вызовом.
 * Совместима по форме возврата со старым drive-client.uploadFile,
 * поэтому вызывающий код менять не пришлось.
 */
async function upload(filePath, filename) {
  const folderId = await resolveFolderId().catch(() => 0);
  const uploaded = await uploadFile(filePath, { filename, folderId });

  if (!uploaded.success) return uploaded;

  const pub = await getPublicLink(uploaded.fileId);

  return {
    success: true,
    provider: 'pcloud',
    fileId: uploaded.fileId,
    filename: uploaded.name,
    size: uploaded.size,
    link: pub.link || pub.shortlink || null,
    shortlink: pub.shortlink || null,
    downloadLink: pub.downloadLink || null,
    publicLinkError: pub.success ? null : pub.error,
  };
}

/* ------------------------------------------------------------------ */
/* Диагностика и служебные методы                                      */
/* ------------------------------------------------------------------ */

async function getUserInfo() {
  return call('userinfo', {});
}

async function listFolder(folderId = 0) {
  const data = await call('listfolder', { folderid: folderId, nofiles: 0 });
  const contents = data.metadata?.contents || [];
  return contents.map((item) => ({
    id: item.isfolder ? item.folderid : item.fileid,
    name: item.name,
    isFolder: Boolean(item.isfolder),
    size: item.size || 0,
    modified: item.modified,
  }));
}

async function stat(fileId) {
  return call('stat', { fileid: fileId });
}

async function deleteFile(fileId) {
  return call('deletefile', { fileid: fileId });
}

/**
 * Проверка конфигурации при старте — пишет в лог понятный диагноз,
 * но не роняет приложение.
 */
async function selfTest() {
  if (!isConfigured()) {
    console.warn('⚠️ pCloud не настроен: документы не будут загружаться в облако');
    return { configured: false };
  }

  try {
    const info = await getUserInfo();
    const usedGb = ((info.quota || 0) / 1024 ** 3).toFixed(2);
    const totalGb = ((info.usedquota || 0) / 1024 ** 3).toFixed(2);
    console.log(
      `✅ pCloud подключен: ${info.email || '?'} | регион ${config.pcloudRegion} | занято ${totalGb} ГБ из ${usedGb} ГБ`
    );
    return { configured: true, email: info.email, quota: info.quota, used: info.usedquota };
  } catch (error) {
    console.error(`❌ pCloud self-test: ${error.message}`);
    return { configured: false, error: error.message };
  }
}

module.exports = {
  upload,
  uploadFile,
  getPublicLink,
  resolveFolderId,
  getUserInfo,
  listFolder,
  stat,
  deleteFile,
  selfTest,
  getToken,
  isConfigured,
  call,
  host,
  ERROR_CODES,
  PCloudError,
};
