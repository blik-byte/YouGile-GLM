// lib/task-planner.js
// Индивидуальное планирование задач, создаваемых из Telegram.
//
// ПОЧЕМУ ЭТОТ ФАЙЛ СУЩЕСТВУЕТ.
// Раньше createTaskFromText в telegram-bot.js зашивал в карточку одинаковый
// план «Проанализировать запрос / Выполнить необходимые действия / Сохранить
// результат» и инструменты web_search+web_analysis для ЛЮБОГО сообщения.
// Владелец справедливо спросил: «Что значит проанализировать запрос? Какой?
// Никакого индивидуального подхода…» — модель на этапе создания задачи просто
// не участвовала. Теперь участвует: планировщик (роль planner) расписывает
// 3-7 конкретных шагов под запрос и выбирает инструменты из полного реестра.
//
// Для согласованных конвейеров (семантика, страница, SEO-аудит) план
// детерминированный — реальные шаги кода, без импровизации модели.

const { chatJson } = require('./glm-client');
const { config } = require('./config');
const tools = require('../tools');
const { toStr } = require('./text');

const { TOOL_NAMES, toolsForPrompt } = tools;

/** Планы согласованных конвейеров — ровно те шаги, которые выполняет код. */
const WORKFLOW_PLANS = {
  semantics: {
    plan: [
      'Найти группу в каталоге владельца по названию или id из сообщения',
      'Собрать черновик семантики: запросы владельца + кандидаты из подсказок',
      'Сформировать файл черновика (.xlsx) и положить в хранилище',
      'Создать заявку на согласование и уведомить владельца (кнопка загрузки частотностей)',
      'Отчёт комментарием в задаче: id черновика, состав, ссылка на файл',
    ],
    tools: ['semantics_draft', 'keyword_research', 'create_document'],
  },
  page: {
    plan: [
      'Проверить, что черновик ОДОБРЕН владельцем (гейт согласования)',
      'Проверить, что указанный кластер входит в черновик',
      'Сгенерировать текст страницы по кластеру (модель, по запросам черновика)',
      'Создать ЧЕРНОВИК ресурса в MODX (published=0, без правок существующих страниц)',
      'Отчёт комментарием: id ресурса, alias, ссылка в админку, замечания генератора',
    ],
    tools: ['site_page_create', 'semantics_status', 'web_analysis'],
  },
  seo_audit: {
    plan: [
      'Определить адрес сайта из сообщения',
      'Механический аудит главной страницы: мета-теги, заголовки H1-H6, скорость, мобильность, микроразметка, robots/sitemap, битые ссылки',
      'Свести находки в оценки по категориям и итоговый балл',
      'Сформировать приоритетные рекомендации (что исправить первым)',
      'Сохранить отчёт файлом (.xlsx) и прислать ссылку комментарием в задаче',
    ],
    tools: ['seo_audit', 'web_analysis', 'create_document'],
  },
};

const PLANNER_PROMPT = `Ты — планировщик задач AI-агента. Из сообщения владельца сформируй ОДНУ задачу.

Требования к execution_plan (3-7 шагов):
- шаги КОНКРЕТНЫЕ: упоминай сайты, названия, сущности и форматы из сообщения. Плохо: «Проанализировать запрос». Хорошо: «Собрать через web_search факты о компании iek-snab.ru: ассортимент, цены, позиции»;
- предпоследний шаг — что сделать с результатом (документ, комментарий);
- последний шаг — куда и в каком формате сохранить итог (документ .xlsx/.docx со ссылкой в комментарии задачи и краткий вывод);
- не выдумывай действия, которые агент не умеет (звонки, доступы, покупки).

tools_needed — ТОЛЬКО инструменты из списка ниже, ровно те, что реально понадобятся:
${toolsForPrompt()}

Если задачу агент выполнить НЕ может (нужны действия человека: доступы, согласования, работа в реальном мире) — верни can_execute: false и steps для человека.

Верни ТОЛЬКО JSON:
{
  "title": "краткое название задачи (до 100 символов)",
  "can_execute": true,
  "execution_plan": ["Шаг 1: ...", "Шаг 2: ..."],
  "tools_needed": ["web_search"]
}`;

/**
 * Валидация и нормализация плана (чистая функция — тестируется).
 * На любом мусоре от модели возвращает безопасный результат, никогда не бросает.
 */
function sanitizeTaskPlan(raw, originalText) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const text = toStr(originalText).trim();

  let title = toStr(source.title).trim().slice(0, 100);
  if (!title) title = text.slice(0, 100) || 'Задача из Telegram';

  // execution_plan: массив строк; строку — по переводам строк; мусор — отбросить
  let plan = source.execution_plan;
  if (typeof plan === 'string') plan = plan.split('\n');
  if (!Array.isArray(plan)) plan = [];
  plan = plan
    .map((step) => toStr(step).trim())
    .filter((step) => step.length >= 3)
    .slice(0, 7);

  if (plan.length === 0) {
    plan = [
      'Разобрать запрос и определить состав работ',
      'Выполнить работы, используя подходящие инструменты',
      'Сохранить результат документом и отчитаться комментарием в задаче',
    ];
  }

  // tools_needed: только из реестра, без дублей, не больше 6
  let toolsNeeded = source.tools_needed;
  if (typeof toolsNeeded === 'string') toolsNeeded = toolsNeeded.split(',');
  if (!Array.isArray(toolsNeeded)) toolsNeeded = [];
  const seen = new Set();
  toolsNeeded = toolsNeeded
    .map((name) => toStr(name).trim())
    .filter((name) => TOOL_NAMES.includes(name) && !seen.has(name) && seen.add(name))
    .slice(0, 6);
  if (toolsNeeded.length === 0) toolsNeeded = ['web_search'];

  return {
    title,
    can_execute: source.can_execute !== false,
    execution_plan: plan,
    tools_needed: toolsNeeded,
  };
}

/**
 * Спланировать задачу из текста сообщения.
 * Ошибка GLM не блокирует создание задачи — откат на общий план.
 */
async function planTaskFromText(text) {
  try {
    const parsed = await chatJson(PLANNER_PROMPT, toStr(text), {
      role: 'planner',
      timeout: Math.min(config.glmTimeoutMs, 60000),
    });
    return sanitizeTaskPlan(parsed, text);
  } catch (error) {
    console.warn(`⚠️ Планировщик задачи недоступен (${error.message}) — беру общий план`);
    return sanitizeTaskPlan(null, text);
  }
}

module.exports = { planTaskFromText, sanitizeTaskPlan, WORKFLOW_PLANS, PLANNER_PROMPT };
