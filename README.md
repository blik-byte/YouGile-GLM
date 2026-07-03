# YouGile GLM AI-Agent

AI-агент для автоматизации задач в YouGile с интеграцией email, GLM (Zhipu AI) и MongoDB.

## 🚀 Возможности

- 📧 **Приём задач через email** — отправляй письмо с темой `[TASK]` → создаётся задача
- 🤖 **Автовыполнение задач** — AI-агент выполняет задачи через GLM API
- 💬 **Чат с агентом** — задавай вопросы в чате YouGile → агент отвечает
- 💾 **Сохранение результатов** — все данные в MongoDB
- 🔧 **Гибкие промпты** — разные промпты для разных типов задач

## 📋 Требования

- Node.js 18+
- MongoDB (локально или Atlas)
- YouGile аккаунт
- Zhipu AI API ключ

## 🛠️ Установка

```bash
# Клонирование
git clone https://github.com/your-username/yougile-glm.git
cd yougile-glm

# Установка зависимостей
npm install

# Создание .env файла
cp .env.example .env
# Отредактируй .env, добавь свои ключи

# Запуск
npm start