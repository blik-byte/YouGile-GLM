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
  R2_ACCOUNT_ID: 'Cloudflare R2 не настроен — документы не будут попадать в облако',
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
  // Роли моделей. Все три Flash-модели Z.AI бесплатны по API, поэтому роли
  // разделяются не по цене, а по силе: дешёвая и быстрая крутит цикл шагов,
  // сильная планирует и рецензирует, мультимодальная смотрит картинки.
  // Любую роль можно переопределить переменной окружения.
  glmModelWorker: str('GLM_MODEL_WORKER') || str('GLM_MODEL', 'glm-4.5-flash'),
  glmModelPlanner: str('GLM_MODEL_PLANNER', 'glm-4.7-flash'),
  glmModelVision: str('GLM_MODEL_VISION', 'glm-4.6v-flash'),
  // Если роль недоступна (модель не найдена, лимит) — тихо падаем на worker,
  // чтобы задача не провалилась из-за второстепенного шага
  glmRoleFallback: bool('GLM_ROLE_FALLBACK', true),
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
  // Имя для проверки сертификата, если оно отличается от MAIL_HOST.
  // Нужен, когда почтовый сервер отдаёт сертификат на родительский домен:
  // например, подключение к mail.fl.h12.ose.su, а в сертификате DNS:h12.ose.su.
  // Проверка цепочки сертификатов при этом остаётся включённой.
  mailTlsServername: str('MAIL_TLS_SERVERNAME'),
  // Полное отключение проверки сертификата — только крайний случай
  mailTlsInsecure: bool('MAIL_TLS_INSECURE', false),
  // Пауза между повторами IDLE при сбоях подключения
  mailIdleRetryMaxMs: int('MAIL_IDLE_RETRY_MAX_MS', 300000),

  // Telegram
  telegramBotToken: str('TELEGRAM_BOT_TOKEN'),
  telegramChatId: str('TELEGRAM_CHAT_ID'),
  telegramAdminIds: str('TELEGRAM_ADMIN_IDS')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // MODX: коннектор публикации (modx/ai-publisher.connector.php)
  modxPublisherUrl: str('MODX_PUBLISHER_URL'),
  modxPublisherToken: str('MODX_PUBLISHER_TOKEN'),

  // Поиск
  tavilyApiKey: str('TAVILY_API_KEY'),
  searchMaxResults: int('SEARCH_MAX_RESULTS', 8),

  // Источники подсказок для сбора семантики (переопределяются в тестах)
  suggestYandexUrl: str('SUGGEST_YANDEX_URL', 'https://suggest.yandex.net/suggest-ff.cgi'),
  suggestGoogleUrl: str('SUGGEST_GOOGLE_URL', 'https://suggestqueries.google.com/complete/search'),
  suggestDdgUrl: str('SUGGEST_DDG_URL', 'https://duckduckgo.com/ac/'),
  yandexRegion: int('KEYWORDS_YANDEX_LR', 213),
  searchTimeoutMs: int('SEARCH_TIMEOUT_MS', 25000),

  // Облачное хранилище: r2 | pcloud | none | auto
  // auto = R2, если настроен; иначе pCloud, если настроен; иначе хранилище отключено
  cloudProvider: str('CLOUD_PROVIDER', 'auto').toLowerCase(),

  // Cloudflare R2 (S3-совместимое). Рекомендуемый провайдер:
  // 10 ГБ бесплатно, регистрация мгновенная, ссылки раздаёт CDN Cloudflare.
  r2AccountId: str('R2_ACCOUNT_ID'),
  r2AccessKeyId: str('R2_ACCESS_KEY_ID'),
  r2SecretAccessKey: str('R2_SECRET_ACCESS_KEY'),
  r2Bucket: str('R2_BUCKET'),
  r2PublicBaseUrl: str('R2_PUBLIC_BASE_URL').replace(/\/+$/, ''),
  // Юрисдикция бакета: пусто (default), eu, us или fedramp —
  // влияет на хост: https://<acc>.<jur>.r2.cloudflarestorage.com
  r2Jurisdiction: str('R2_JURISDICTION').toLowerCase(),
  r2Region: str('R2_REGION', 'auto'),
  // Переопределение хоста S3 API. Пусто = вывести из R2_ACCOUNT_ID.
  // Нужно для тестов и для любых других S3-совместимых хранилищ.
  r2Endpoint: str('R2_ENDPOINT').replace(/\/+$/, ''),
  r2Prefix: str('R2_PREFIX', 'ai-documents'),
  r2TimeoutMs: int('R2_TIMEOUT_MS', 60000),

  // Секрет для подписи ссылок на файлы, раздаваемые через наш сервер
  // (используется, когда R2_PUBLIC_BASE_URL не задан и бакет остаётся приватным).
  // По умолчанию берётся ADMIN_TOKEN.
  filesSecret: str('FILES_SECRET') || str('ADMIN_TOKEN'),

  // pCloud (в апреле 2026 отключил парольную авторизацию — см. README)
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
