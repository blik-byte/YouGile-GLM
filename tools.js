// tools.js
const tools = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Поиск информации в интернете. Используй для сбора данных.",
      parameters: {
        type: "object",
        properties: {
          query: { 
            type: "string", 
            description: "Поисковый запрос" 
          }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "save_result",
      description: "Сохранить результат в базу данных",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "ID задачи в YouGile" },
          step: { type: "string", description: "Название шага" },
          data: { type: "string", description: "Результат (текст/JSON)" }
        },
        required: ["taskId", "step", "data"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "update_task_status",
      description: "Обновить статус задачи в YouGile",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          status: { 
            type: "string", 
            enum: ["Выполняется", "Готово", "Ошибка"] 
          }
        },
        required: ["taskId", "status"]
      }
    }
  },
  {
  type: "function",
  function: {
    name: "create_document",
    description: "Создать документ (docx/xlsx/txt) и загрузить в облако. Возвращает публичную ссылку.",
    parameters: {
      type: "object",
      properties: {
        format: { 
          type: "string", 
          enum: ["docx", "xlsx", "txt"],
          description: "Формат файла" 
        },
        filename: { 
          type: "string", 
          description: "Имя файла (без расширения)" 
        },
        title: { 
          type: "string", 
          description: "Заголовок документа (для docx)" 
        },
        content: { 
          type: "string", 
          description: "Содержимое документа (для docx/txt, можно использовать markdown)" 
        },
        tables: {
          type: "array",
          description: "Массив таблиц для xlsx: [{name, headers, rows}]",
          items: { 
            type: "object",
            properties: {
              name: { type: "string" },
              headers: { type: "array", items: { type: "string" } },
              rows: { type: "array", items: { type: "array", items: { type: "string" } } }
            }
          }
        }
      },
      required: ["format", "filename"]
    }
  }
},
  {
    type: "function",
    function: {
      name: "add_comment",
      description: "Добавить комментарий к задаче в YouGile",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          text: { type: "string" }
        },
        required: ["taskId", "text"]
      }
    }
  }
];

module.exports = tools;
