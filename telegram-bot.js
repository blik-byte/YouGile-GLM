// telegram-bot.js
const TelegramBot = require('node-telegram-bot-api');

let bot = null;

// ✅ Инициализация бота
function initBot() {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.log('⚠️ TELEGRAM_BOT_TOKEN не установлен, Telegram-бот отключён');
    return null;
  }

  bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
  
  console.log('🤖 Telegram-бот запущен');

  // ✅ ВРЕМЕННАЯ ОТЛАДКА — показать Chat ID
  bot.on('message', (msg) => {
    console.log(`💬 Получено сообщение от chat ID: ${msg.chat.id}`);
    console.log(`💬 Имя: ${msg.from.first_name} ${msg.from.last_name || ''}`);
    console.log(`💬 Username: @${msg.from.username || 'нет'}`);
    
    bot.sendMessage(msg.chat.id, 
      `✅ Бот работает!\n\n` +
      `Твой Chat ID: ${msg.chat.id}\n\n` +
      `Скопируй это число и добавь в Render как TELEGRAM_CHAT_ID`
    );
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
