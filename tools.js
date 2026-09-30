// tools.js
// Описание инструментов для GLM function calling.
//
// Добавлен web_analysis — раньше он упоминался в README и в tools_needed,
// но не был объявлен здесь и не был реализован: агент обещал возможность,
// которой не существовало, и в лучшем случае получал «Unknown tool».

const tools = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Поиск информации в интернете. Возвращает краткий ответ и список источников с заголовками, ссылками и фрагментами текста. Используй для сбора фактов, цен, новостей, данных о конкурентах. Формулируй конкретные запросы и не повторяй один и тот же запрос дважды.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Поисковый запрос. Конкретный, с ключевыми словами. Примеры: "ноутбук Lenovo ThinkPad цена Москва 2026", "требования SEO к метатегу description".',
          },
          maxResults: {
            type: 'number',
            description: 'Сколько источников вернуть (по умолчанию 8, максимум 10)',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_analysis',
      description:
        'Прочитать содержимое конкретной веб-страницы по URL и извлечь из неё данные. Используй ПОСЛЕ web_search, чтобы изучить найденный источник подробно: снять характеристики, цены, структуру страницы, текст статьи. Если передать question — вернётся готовый ответ по содержимому страницы вместе с ключевыми фактами.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'Полный URL страницы, начиная с http:// или https://',
          },
          question: {
            type: 'string',
            description:
              'Необязательно: на что именно смотреть на странице. Например "какие цены указаны", "какие мета теги используются", "основные тезисы статьи".',
          },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_document',
      description:
        'Создать документ и загрузить его в облачное хранилище pCloud. Возвращает публичную ссылку, которую обязательно нужно добавить в комментарий к задаче. Для таблиц используй xlsx или csv, для текстовых отчётов — docx или md.',
      parameters: {
        type: 'object',
        properties: {
          format: {
            type: 'string',
            enum: ['docx', 'xlsx', 'txt', 'md', 'csv', 'json'],
            description:
              'Формат файла. docx — отчёт с заголовками; xlsx — таблицы; md — разметка; csv — плоская таблица; txt — простой текст; json — структурированные данные.',
          },
          filename: {
            type: 'string',
            description: 'Имя файла без расширения, например "seo-audit-example-ru"',
          },
          title: {
            type: 'string',
            description: 'Заголовок документа (используется в docx)',
          },
          content: {
            type: 'string',
            description:
              'Текст документа. Для docx и md поддерживается разметка: "# Заголовок 1", "## Заголовок 2", "- пункт списка". Для json — валидная JSON-строка.',
          },
          tables: {
            type: 'array',
            description:
              'Таблицы для xlsx и csv: массив объектов {name, headers, rows}. name — название листа, headers — массив строк шапки, rows — массив массивов значений.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Название листа (до 31 символа)' },
                headers: { type: 'array', items: { type: 'string' } },
                rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
              },
            },
          },
        },
        required: ['format', 'filename'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_result',
      description:
        'Сохранить промежуточный результат шага в базу данных. Вызывай после каждого содержательного шага, чтобы результаты не потерялись и их можно было посмотреть в дашборде.',
      parameters: {
        type: 'object',
        properties: {
          taskId: {
            type: 'string',
            description: 'Реальный ID задачи в YouGile из контекста. Не придумывай свой.',
          },
          step: {
            type: 'string',
            description: 'Короткое название шага, например "Сбор цен конкурентов"',
          },
          data: {
            type: 'string',
            description: 'Результат шага: текст или JSON-строка',
          },
        },
        required: ['taskId', 'step', 'data'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_comment',
      description:
        'Добавить комментарий в чат задачи в YouGile. Используй для сообщений о прогрессе (не чаще одного раза на 2-3 шага) и для финального отчёта со ссылками на созданные документы.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'Реальный ID задачи в YouGile' },
          text: { type: 'string', description: 'Текст комментария' },
        },
        required: ['taskId', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_task_status',
      description:
        'Изменить статус задачи в YouGile (переместить в соответствующую колонку). Вызывай ОДИН раз в самом конце: "Готово" когда задача полностью выполнена, "Ошибка" если выполнить не удалось. "Выполняется" ставится автоматически, вручную вызывать не нужно.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'Реальный ID задачи в YouGile' },
          status: {
            type: 'string',
            enum: ['Выполняется', 'Готово', 'Ошибка'],
            description: 'Новый статус задачи',
          },
        },
        required: ['taskId', 'status'],
      },
    },
  },
];

/** Имена инструментов — удобно для тестов и валидации. */
const TOOL_NAMES = tools.map((tool) => tool.function.name);

module.exports = tools;
module.exports.TOOL_NAMES = TOOL_NAMES;
