// lib/config.js
// Централизованная работа с переменными окружения.
//
// Зачем: раньше process.env читался в 10+ местах, причём для YouGile использовались
// ДВА разных имени (YOUGILE_API_KEY в index.js и YOUGILE_GLM_API_KEY везде остальном).
// Здесь — одна точка входа, проверка обязательных переменных и понятные ошибки.

/** Обязательные для запуска */
const REQUIRED = ['MONGODB_URI', 'ZAI_API_KEY', 'YOUGILE_API_KEY'];

/** Необязательные, но без них часть функций отключается */
const OPTIONAL = {
  TELEGRAM_BOT_TOKEN: 'Telegram-бот не запустится',
  TELEGRAM_CHAT_ID: 'уведомления не будут отправляться',
  MAIL_USER: 'почтовый воркер отключён',
  MAIL_PASSWORD: 'почтовый воркер отключён',
  TAVILY_API_KEY: 'веб-поиск через Tavily отключён',
  PCLOUD_AUTH_TOKEN: 'загрузка документов в облако отключена',
  ADMIN_TOKEN: 'служебные HTTP-эндпоинты будут закрыты для всех',
};

function str(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value.trim();
}

function int(name, fallback) {
  const parsed = Number.parseInt(str(name), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(name, fallback = false) {
  const raw = str(name).toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on', 'да'].includes(raw);
}

/**
 * YouGile API-ключ.
 * Исторически в проекте встречались оба имени — поддерживаем оба,
 * но приоритет у YOUGILE_API_KEY, а YOUGILE_GLM_API_KEY оставлен как алиас.
 */
function yougileKey() {
  return str('YOUGILE_API_KEY') || str('YOUGILE_GLM_API_KEY');
}

const config = {
  // HTTP-сервер
  port: int('PORT', 3000),
  adminToken: str('ADMIN_TOKEN'),
  publicBaseUrl: str('PUBLIC_BASE_URL', 'https://yougile-glm.onrender.com'),

  // AI
  zaiApiKey: str('ZAI_API_KEY'),
  glmModel: str('GLM_MODEL', 'glm-4.5-flash'),
  glmBaseUrl: str('GLM_BASE_URL', 'https://api.z.ai/api/paas/v4'),
  glmTimeoutMs: int('GLM_TIMEOUT_MS', 120000),
  glmMaxSteps: int('GLM_MAX_STEPS', 25),
  glmMaxContextChars: int('GLM_MAX_CONTEXT_CHARS', 90000),

  // YouGile
  yougileApiKey: yougileKey(),
  yougileBaseUrl: str('YOUGILE_BASE_URL', 'https://rocketup.yougile.com/api-v2'),
  yougileUserId: str('YOUGILE_GLM_USER_ID') || str('YOUGILE_USER_ID'),
  columnToExecute: str('COLUMN_TO_EXECUTE'),
  columnAwaitingConfirmation: str('COLUMN_AWAITING_CONFIRMATION'),
  columnDefault: str('COLUMN_DEFAULT'),
  columnExecuting: str('COLUMN_EXECUTING'),
  columnDone: str('COLUMN_DONE'),
  columnError: str('COLUMN_ERROR'),
  aiStickerId: str('AI_STICKER_ID', 'c553a657-fa54-4532-9d02-4750e013005f'),
  taskPollIntervalMs: int('TASK_POLL_INTERVAL_MS', 30000),

  // Почта
  mailUser: str('MAIL_USER'),
  mailPassword: str('MAIL_PASSWORD'),
  mailHost: str('MAIL_HOST', 'mail.fl.h12.ose.su'),
  mailPort: int('MAIL_PORT', 993),
  mailInbox: str('MAIL_INBOX', 'INBOX'),
  mailDoneFolder: str('MAIL_DONE_FOLDER', 'AI_DONE'),
  mailPollIntervalMs: int('MAIL_POLL_INTERVAL_MS', 120000),
  mailTaskSubjectMarkers: str('MAIL_TASK_SUBJECT_MARKERS', '[TASK]')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // Проверку сертификата отключаем только явным флагом, а не по умолчанию
  mailTlsInsecure: bool('MAIL_TLS_INSECURE', false),

  // Telegram
  telegramBotToken: str('TELEGRAM_BOT_TOKEN'),
  telegramChatId: str('TELEGRAM_CHAT_ID'),
  telegramAdminIds: str('TELEGRAM_ADMIN_IDS')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Поиск
  tavilyApiKey: str('TAVILY_API_KEY'),
  searchMaxResults: int('SEARCH_MAX_RESULTS', 8),
  searchTimeoutMs: int('SEARCH_TIMEOUT_MS', 25000),

  // pCloud
  pcloudAuthToken: str('PCLOUD_AUTH_TOKEN'),
  pcloudEmail: str('PCLOUD_EMAIL'),
  pcloudPassword: str('PCLOUD_PASSWORD'),
  pcloudRegion: str('PCLOUD_REGION', 'eu').toLowerCase(),
  pcloudFolderId: int('PCLOUD_FOLDER_ID', 0),
  pcloudFolderName: str('PCLOUD_FOLDER_NAME', 'AI-документы'),
  pcloudTimeoutMs: int('PCLOUD_TIMEOUT_MS', 60000),

  // База
  mongodbUri: str('MONGODB_URI'),
  mongoDbName: str('MONGODB_DB', 'ai_tasks'),
};

/**
 * Проверка конфигурации при старте.
 * Не бросает исключение по необязательным переменным — только предупреждает,
 * чтобы приложение не падало целиком из-за одного отключённого модуля.
 *
 * @returns {{missing: string[], warnings: string[]}}
 */
function validate({ strict = false } = {}) {
  const missing = [];
  const warnings = [];

  for (const name of REQUIRED) {
    // YOUGILE_API_KEY проверяем с учётом алиаса
    const value = name === 'YOUGILE_API_KEY' ? config.yougileApiKey : str(name);
    if (!value) missing.push(name);
  }

  for (const [name, hint] of Object.entries(OPTIONAL)) {
    if (!str(name)) warnings.push(`${name} не задан — ${hint}`);
  }

  if (!config.columnToExecute) {
    warnings.push('COLUMN_TO_EXECUTE не задан — task-executor не будет забирать задачи');
  }

  if (missing.length > 0) {
    const message = `Не заданы обязательные переменные окружения: ${missing.join(', ')}`;
    if (strict) throw new Error(message);
    console.error(`❌ ${message}`);
  }

  return { missing, warnings };
}

module.exports = { config, validate, str, int, bool };
