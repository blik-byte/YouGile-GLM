// telegram-bot.js
const TelegramBot = require('node-telegram-bot-api');
const { createYougileTask } = require('./email-worker');

let bot = null;

// ✅ Инициализация бота
function initBot() {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.log('⚠️ TELEGRAM_BOT_TOKEN не установлен, Telegram-бот отключён');
    return null;
  }

  bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
  
  console.log('🤖 Telegram-бот запущен');

  // Команда /start
  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, 
      '👋 Привет! Я AI-агент YouGile.\n\n' +
      'Доступные команды:\n' +
      '/task <текст> — создать задачу\n' +
      '/status — статус задач\n' +
      '/help — помощь\n\n' +
      'Или просто напиши задачу текстом!'
    );
  });

  // Команда /help
  bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId,
      '📚 Справка по командам:\n\n' +
      '/task <текст задачи> — создать новую задачу\n' +
      'Пример: /task Проведи SEO-аудит сайта example.ru\n\n' +
      '/status — показать статус всех задач\n\n' +
      '/help — показать эту справку\n\n' +
      '💡 Можно просто написать задачу текстом, и я создам её автоматически!'
    );
  });

  // Команда /task
  bot.onText(/\/task (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const taskText = match[1];
    
    bot.sendMessage(chatId, '🤖 Создаю задачу...');
    
    try {
      const taskData = {
        title: taskText.substring(0, 100),
        can_execute: true,
        execution_plan: ['Проанализировать запрос', 'Выполнить необходимые действия', 'Сохранить результат'],
        tools_needed: ['web_search', 'web_analysis']
      };
      
      const task = await createYougileTask(taskData);
      
      bot.sendMessage(chatId,
        `✅ Задача создана!\n\n` +
        `📋 ID: ${task.id}\n` +
        `📝 Заголовок: ${task.title}\n\n` +
        `Задача добавлена в YouGile и будет обработана автоматически.`
      );
      
    } catch (error) {
      bot.sendMessage(chatId, `❌ Ошибка создания задачи: ${error.message}`);
    }
  });

  // Команда /status
  bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    
    bot.sendMessage(chatId, '📊 Запрашиваю статус задач...');
    
    try {
      const response = await fetch(
        `https://rocketup.yougile.com/api-v2/tasks`,
        {
          headers: {
            'Authorization': `Bearer ${process.env.YOUGILE_GLM_API_KEY}`
          }
        }
      );
      
      const data = await response.json();
      const tasks = data.content || [];
      
      if (tasks.length === 0) {
        bot.sendMessage(chatId, '📭 Нет активных задач');
        return;
      }
      
      let message = `📊 Статус задач (${tasks.length}):\n\n`;
      
      tasks.slice(0, 10).forEach((task, i) => {
        const status = task.completed ? '✅ Готово' : '🔄 В работе';
        message += `${i + 1}. ${status} ${task.title}\n`;
      });
      
      if (tasks.length > 10) {
        message += `\n... и ещё ${tasks.length - 10} задач`;
      }
      
      bot.sendMessage(chatId, message);
      
    } catch (error) {
      bot.sendMessage(chatId, `❌ Ошибка получения статуса: ${error.message}`);
    }
  });

  // Обработка любого текстового сообщения
  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    
    const chatId = msg.chat.id;
    const text = msg.text;
    
    bot.sendMessage(chatId, '🤖 Создаю задачу из твоего сообщения...');
    
    try {
      const taskData = {
        title: text.substring(0, 100),
        can_execute: true,
        execution_plan: ['Проанализировать запрос', 'Выполнить необходимые действия', 'Сохранить результат'],
        tools_needed: ['web_search', 'web_analysis']
      };
      
      const task = await createYougileTask(taskData);
      
      bot.sendMessage(chatId,
        `✅ Задача создана!\n\n` +
        `📋 ID: ${task.id}\n` +
        `📝 Заголовок: ${task.title}\n\n` +
        `Задача добавлена в YouGile и будет обработана автоматически.`
      );
      
    } catch (error) {
      bot.sendMessage(chatId, `❌ Ошибка: ${error.message}`);
    }
  });

  return bot;
}

// ✅ Отправка уведомления
async function sendNotification(message) {
  if (!bot || !process.env.TELEGRAM_CHAT_ID) {
    console.log('⚠️ Telegram-бот не инициализирован или Chat ID не установлен');
    return;
  }

  try {
    await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, message, { parse_mode: 'HTML' });
    console.log('📱 Уведомление отправлено в Telegram');
  } catch (error) {
    console.error('❌ Ошибка отправки уведомления:', error.message);
  }
}

module.exports = {
  initBot,
  sendNotification
};
