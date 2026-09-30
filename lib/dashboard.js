// lib/dashboard.js
// Сбор данных для веб-дашборда.
//
// Каждый блок обёрнут в try/catch: дашборд должен показывать картину даже когда
// MongoDB, YouGile или pCloud недоступны. Иначе диагностика превращается
// в «всё или ничего».

const os = require('os');

const db = require('../db');
const yougile = require('./yougile-client');
const search = require('./search');
const pcloud = require('../pcloud-client');
const { config } = require('./config');

const startedAt = Date.now();

/** Безопасное выполнение блока: ошибка не роняет весь отчёт. */
async function safe(fn, fallback) {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    return { ok: false, error: error.message, data: fallback };
  }
}

/** Состояние внешних сервисов — что настроено, что работает. */
async function collectServices() {
  const mongo = await safe(async () => {
    const connection = await db.connectToMongo();
    await connection.command({ ping: 1 });
    return { connected: true, database: config.mongoDbName };
  });

  const cloud = await safe(async () => {
    if (!pcloud.isConfigured()) {
      return { configured: false, note: 'PCLOUD_AUTH_TOKEN не задан' };
    }
    const info = await pcloud.getUserInfo();
    return {
      configured: true,
      region: config.pcloudRegion,
      email: info.email || null,
      quotaGb: info.quota ? Number((info.quota / 1024 ** 3).toFixed(2)) : null,
      usedGb: info.usedquota ? Number((info.usedquota / 1024 ** 3).toFixed(2)) : null,
      premium: Boolean(info.premium),
    };
  });

  const searchProviders = await safe(async () => {
    const order = search.providerOrder();
    return {
      order,
      tavily: Boolean(config.tavilyApiKey),
      brave: Boolean(process.env.BRAVE_API_KEY),
      googleCse: Boolean(process.env.GOOGLE_API_KEY && process.env.GOOGLE_CX),
      wikipedia: true,
      activeCount: order.filter((name) => search.PROVIDERS[name].available()).length,
    };
  });

  const telegram = await safe(async () => {
    const { getBot } = require('../telegram-bot');
    const bot = getBot();
    if (!bot || !config.telegramBotToken) {
      return { configured: false, polling: false };
    }
    let webhookInfo = null;
    try {
      webhookInfo = await bot.getWebHookInfo();
    } catch {
      /* не критично */
    }
    return {
      configured: true,
      polling: Boolean(bot.isPolling && bot.isPolling()),
      chatIdSet: Boolean(config.telegramChatId),
      adminCount: config.telegramAdminIds.length,
      whitelistStrict: config.telegramAdminIds.length > 0,
      webhookUrl: webhookInfo?.url || null,
    };
  });

  const yougileService = await safe(async () => {
    if (!config.yougileApiKey) return { configured: false, note: 'API-ключ не задан' };
    const columns = await yougile.listColumns();
    return {
      configured: true,
      columnsCount: columns.length,
      columns: columns.slice(0, 20).map((column) => ({
        id: column.id,
        title: column.title,
      })),
    };
  });

  const mail = {
    ok: true,
    data: {
      configured: Boolean(config.mailUser && config.mailPassword),
      user: config.mailUser || null,
      host: config.mailHost,
      folder: config.mailInbox,
      doneFolder: config.mailDoneFolder,
      markers: config.mailTaskSubjectMarkers,
      tlsInsecure: config.mailTlsInsecure,
    },
  };

  const glm = {
    ok: true,
    data: {
      configured: Boolean(config.zaiApiKey),
      model: config.glmModel,
      maxSteps: config.glmMaxSteps,
      timeoutMs: config.glmTimeoutMs,
      contextBudget: config.glmMaxContextChars,
    },
  };

  return { mongo, cloud, search: searchProviders, telegram, yougile: yougileService, mail, glm };
}

/** Счётчики задач по колонкам YouGile. */
async function collectColumns() {
  return safe(async () => {
    const columns = {
      'К выполнению': config.columnToExecute,
      Выполняется: config.columnExecuting,
      'Ждут подтверждения': config.columnAwaitingConfirmation,
      Готово: config.columnDone,
      Ошибка: config.columnError,
    };

    const counts = await yougile.countByColumn(columns);

    return Object.entries(columns).map(([name, id]) => ({
      name,
      columnId: id || null,
      configured: Boolean(id),
      count: typeof counts[name] === 'number' ? counts[name] : null,
      error: counts[name] && counts[name].error ? counts[name].error : null,
    }));
  }, []);
}

/** Последние запуски агента: сколько шагов, чем закончилось, сколько длилось. */
async function collectAgentRuns(limit = 15) {
  return safe(async () => {
    const runs = await db.recentAgentRuns(limit);
    return runs.map((run) => {
      const started = run.startedAt ? new Date(run.startedAt).getTime() : null;
      const finished = run.finishedAt ? new Date(run.finishedAt).getTime() : null;
      return {
        id: String(run._id),
        taskId: run.taskId,
        title: run.title || null,
        mode: run.mode || 'task',
        completed: Boolean(run.completed),
        steps: run.steps ?? null,
        toolCalls: run.toolCalls ?? null,
        error: run.error || null,
        startedAt: run.startedAt || null,
        durationSec: started && finished ? Math.round((finished - started) / 1000) : null,
        running: !finished,
      };
    });
  }, []);
}

/** Реестр запусков задач — источник правды о блокировках и попытках. */
async function collectTaskRuns(limit = 25) {
  return safe(async () => {
    const runs = await db.listTaskRuns(limit);
    return runs.map((run) => ({
      taskId: run.taskId,
      title: run.title || null,
      status: run.status,
      attempts: run.attempts || 0,
      startedAt: run.startedAt || null,
      finishedAt: run.finishedAt || null,
      updatedAt: run.updatedAt || null,
      error: run.error || null,
    }));
  }, []);
}

/** Последние сохранённые шаги — видно, чем агент занимался. */
async function collectRecentSteps(limit = 15) {
  return safe(async () => {
    const connection = await db.getDb();
    const rows = await connection
      .collection(db.COLLECTIONS.results)
      .find({})
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();

    return rows.map((row) => ({
      taskId: row.taskId,
      step: row.step,
      timestamp: row.timestamp,
      preview: typeof row.data === 'string' ? row.data.slice(0, 200) : JSON.stringify(row.data).slice(0, 200),
    }));
  }, []);
}

/** Кто имеет доступ к Telegram-боту и кто просит. */
async function collectAccess() {
  const access = await safe(async () => {
    const rows = await db.listAccess();
    return rows.map((row) => ({
      chatId: row.chatId,
      firstName: row.firstName || null,
      username: row.username || null,
      role: row.role || 'user',
      grantedAt: row.grantedAt || null,
      notes: row.notes || null,
    }));
  }, []);

  const requests = await safe(async () => {
    const rows = await db.listRequests();
    return rows.slice(0, 20).map((row) => ({
      chatId: row.chatId,
      firstName: row.firstName || null,
      username: row.username || null,
      hits: row.hits || 1,
      lastSeenAt: row.lastSeenAt || null,
      lastText: row.lastText || null,
    }));
  }, []);

  return { access, requests };
}

/** Состояние самого процесса: память, аптайм, нагрузка. */
function collectRuntime() {
  const memory = process.memoryUsage();
  return {
    uptimeSec: Math.round(process.uptime()),
    sinceProcessStart: new Date(startedAt).toISOString(),
    node: process.version,
    pid: process.pid,
    platform: `${os.type()} ${os.release()}`,
    timezone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
    reportTimezone: process.env.REPORT_TZ || 'Europe/Moscow',
    memory: {
      rssMb: Number((memory.rss / 1024 ** 2).toFixed(1)),
      heapUsedMb: Number((memory.heapUsed / 1024 ** 2).toFixed(1)),
      heapTotalMb: Number((memory.heapTotal / 1024 ** 2).toFixed(1)),
      externalMb: Number((memory.external / 1024 ** 2).toFixed(1)),
    },
    loadAverage: os.loadavg().map((value) => Number(value.toFixed(2))),
    cpus: os.cpus().length,
  };
}

/** Предупреждения о незаполненных переменных окружения. */
function collectConfigWarnings() {
  const warnings = [];

  if (!config.adminToken) {
    warnings.push({
      level: 'critical',
      text: 'ADMIN_TOKEN не задан — дашборд и служебные эндпоинты недоступны. Задайте случайную длинную строку.',
    });
  }
  if (!config.telegramAdminIds.length) {
    warnings.push({
      level: 'critical',
      text: 'TELEGRAM_ADMIN_IDS пуст — бот принимает команды от любого пользователя. Добавьте свой chat ID.',
    });
  }
  if (!config.columnToExecute) {
    warnings.push({ level: 'critical', text: 'COLUMN_TO_EXECUTE не задан — агент не забирает задачи в работу.' });
  }
  if (!pcloud.isConfigured()) {
    warnings.push({
      level: 'warning',
      text: 'pCloud не настроен — документы создаются, но ссылку отдать некуда. Выполните npm run pcloud:token.',
    });
  }
  if (!config.tavilyApiKey) {
    warnings.push({
      level: 'warning',
      text: 'TAVILY_API_KEY не задан — поиск работает только через Wikipedia. Добавьте ключ для полноценного поиска.',
    });
  }
  if (!config.telegramBotToken || !config.telegramChatId) {
    warnings.push({ level: 'warning', text: 'Telegram не настроен полностью — уведомления могут не отправляться.' });
  }
  if (config.mailTlsInsecure) {
    warnings.push({ level: 'warning', text: 'MAIL_TLS_INSECURE=true — проверка сертификата почтового сервера отключена.' });
  }
  if (!config.publicBaseUrl || config.publicBaseUrl.includes('onrender.com')) {
    warnings.push({
      level: 'info',
      text: 'PUBLIC_BASE_URL не задан или остался значением по умолчанию — вебхук YouGile может подписываться не на тот адрес.',
    });
  }

  return warnings;
}

/**
 * Полный снимок состояния системы для дашборда.
 */
async function collect({ limit = 15 } = {}) {
  const [services, columns, agentRuns, taskRuns, recentSteps, access, stats] = await Promise.all([
    collectServices(),
    collectColumns(),
    collectAgentRuns(limit),
    collectTaskRuns(limit + 10),
    collectRecentSteps(limit),
    collectAccess(),
    safe(() => db.getStats(), null),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    runtime: collectRuntime(),
    warnings: collectConfigWarnings(),
    services,
    columns: columns.data,
    columnsError: columns.ok ? null : columns.error,
    agentRuns: agentRuns.data,
    agentRunsError: agentRuns.ok ? null : agentRuns.error,
    taskRuns: taskRuns.data,
    taskRunsError: taskRuns.ok ? null : taskRuns.error,
    recentSteps: recentSteps.data,
    recentStepsError: recentSteps.ok ? null : recentSteps.error,
    access: access.access.data,
    accessRequests: access.requests.data,
    stats: stats.data,
    statsError: stats.ok ? null : stats.error,
  };
}

module.exports = { collect, collectServices, collectRuntime, collectConfigWarnings };
