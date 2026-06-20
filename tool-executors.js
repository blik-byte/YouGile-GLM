// tool-executors.js
const db = require('./db');

// 🔍 Умный поиск с кэшем и fallback
async function webSearch(query) {
  console.log(`🔍 Поиск: "${query.substring(0, 50)}..."`);
  
  // 1. Проверяем кэш (7 дней)
  try {
    const cached = await db.getCachedSearch(query);
    if (cached) {
      console.log(`📦 Из кэша`);
      return { ...cached, from_cache: true };
    }
  } catch (e) {
    console.warn(`⚠️ Ошибка кэша: ${e.message}`);
  }
  
  // 2. Tavily (если есть ключ) — 1000 запросов/мес бесплатно
  if (process.env.TAVILY_API_KEY) {
    try {
      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: process.env.TAVILY_API_KEY,
          query,
          max_results: 5,
          include_answer: true,
          search_depth: 'basic'
        })
      });
      
      if (response.ok) {
        const data = await response.json();
        const result = {
          query,
          answer: data.answer || 'Нет краткого ответа',
          results: (data.results || []).map(r => ({
            title: r.title,
            url: r.url,
            content: (r.content || '').substring(0, 500)
          })),
          source: 'tavily'
        };
        
        try { await db.cacheSearch(query, result); } catch (_) {}
        return result;
      }
    } catch (e) {
      console.warn(`⚠️ Tavily error: ${e.message}`);
    }
  }
  
  // 3. Fallback на DuckDuckGo
  try {
    const response = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`
    );
    const data = await response.json();
    
    const result = {
      query,
      answer: data.Abstract || 'Нет краткого описания',
      results: (data.RelatedTopics || [])
        .filter(t => t.Text)
        .slice(0, 5)
        .map(t => ({
          title: (t.Text || '').substring(0, 100),
          url: t.FirstURL,
          content: t.Text
        })),
      source: 'duckduckgo'
    };
    
    try { await db.cacheSearch(query, result); } catch (_) {}
    return result;
  } catch (e) {
    return { query, error: e.message, source: 'fallback' };
  }
}

// 💾 Сохранение результата в MongoDB
async function saveResult(taskId, step, data) {
  try {
    const id = await db.saveTaskStep(taskId, step, data);
    return { success: true, id: id.toString() };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// 🔄 Обновление статуса задачи в YouGile
async function updateTaskStatus(taskId, status) {
  const COLUMN_IDS = {
    'Выполняется': process.env.COLUMN_EXECUTING,
    'Готово': process.env.COLUMN_DONE,
    'Ошибка': process.env.COLUMN_ERROR
  };
  
  const columnId = COLUMN_IDS[status];
  console.log(`🔄 Обновляю статус задачи ${taskId} → ${status} (columnId: ${columnId})`);
  
  if (!columnId) {
    console.warn(`⚠️ Неизвестный статус: ${status}`);
    return { success: false, error: `Unknown status: ${status}` };
  }
  
  try {
    const payload = { columnId };
    
    // Если статус "Готово" — помечаем задачу как выполненную
    if (status === 'Готово') {
      payload.completed = true;
      console.log(`✅ Помечаю задачу как выполненную (completed: true)`);
    }
    
    const response = await fetch(
      `https://rocketup.yougile.com/api-v2/tasks/${taskId}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.YOUGILE_GLM_API_KEY}`
        },
        body: JSON.stringify(payload)
      }
    );
    
    const responseText = await response.text();
    console.log(`🔄 YouGile статус: ${response.status}`);
    console.log(`🔄 YouGile ответ: ${responseText.substring(0, 300)}`);
    
    return { success: response.ok, status: response.status };
  } catch (e) {
    console.error(`❌ Ошибка updateTaskStatus: ${e.message}`);
    return { success: false, error: e.message };
  }
}

// 💬 Добавление комментария к задаче
async function addComment(taskId, text) {
  console.log(`💬 Добавляю комментарий к задаче ${taskId}...`);
  console.log(`💬 Текст (первые 200 симв.): ${text.substring(0, 200)}`);
  
  try {
    // В YouGile chatId = taskId
    const response = await fetch(
      `https://rocketup.yougile.com/api-v2/chats/${taskId}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.YOUGILE_GLM_API_KEY}`
        },
        body: JSON.stringify({
          text: text,
          textHtml: `<p>${text.replace(/\n/g, '<br>')}</p>`,
          label: 'AI'
        })
      }
    );
    
    const responseText = await response.text();
    console.log(`💬 YouGile статус: ${response.status}`);
    console.log(`💬 YouGile ответ: ${responseText.substring(0, 300)}`);
    
    return { success: response.ok, status: response.status };
  } catch (e) {
    console.error(`❌ Ошибка addComment: ${e.message}`);
    return { success: false, error: e.message };
  }
}

module.exports = {
  webSearch,
  saveResult,
  updateTaskStatus,
  addComment
};
