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
