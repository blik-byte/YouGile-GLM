# Доступы и секреты

Значения секретов **здесь не хранятся** и в репозиторий не попадают. В таблицах — только что это, где живёт и как проверить, что работает.

## Внешние доступы

| Доступ | Где хранится | Зачем | Как проверить |
|---|---|---|---|
| GitHub fine-grained PAT, репозиторий `blik-byte/YouGile-GLM`, `Contents: Read and write` | передаётся владельцем в чат; в git-конфиг не записывается | push изменений в `main` → автодеплой Render | `git ls-remote https://<token>@github.com/blik-byte/YouGile-GLM.git` |
| Render, сервис `yougile-glm` → `ADMIN_TOKEN` | переменные Render; локально не нужен | дашборд, `/api/*`, подпись ссылок на файлы | `GET /api/dashboard` с заголовком `X-Admin-Token` |
| YouGile → `YOUGILE_GLM_API_KEY` (ключ **аккаунта агента**) | переменные Render | чтение/создание задач, досок, проектов | `GET /api-v2/projects` с заголовком авторизации |
| YouGile → `YOUGILE_GLM_USER_ID` | переменные Render | подпись комментариев агентом | `GET /find-glm-user` с `X-Admin-Token` |
| Z.AI → `ZAI_API_KEY` | переменные Render | GLM-4.5 Flash: планы, выполнение, ответы | любой шаг агента в дашборде |
| Telegram → `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_IDS` | переменные Render | бот, whitelist | `/help` боту; `TELEGRAM_ADMIN_IDS` делает режим строгим |
| Почта → `MAIL_USER`, `MAIL_PASSWORD` (app-пароль) | переменные Render | приём задач по IMAP | `GET /process-mail` с `X-Admin-Token` || MODX → `MODX_PUBLISHER_TOKEN` + настройка `ai_publisher_token` на сайте | переменные Render + MODX | создание страниц | `/modx` в боте или `GET /api/modx/status` |
| MongoDB → `MONGODB_URI` | переменные Render | результаты, блокировки, whitelist, файлы (при `CLOUD_PROVIDER=mongo`) | `GET /db-check` с `X-Admin-Token` |
| Cloudflare R2 (опционально) → `R2_*` | переменные Render | альтернативное хранилище | `/api/dashboard`, блок «облако» |

Аккаунт агента нужен, чтобы в истории YouGile было видно, кто создал задачу и кто её выполнил — отдельно от аккаунта владельца.

## Переменные окружения по группам

Полный документированный список с комментариями — `.env.example`. Здесь — карта, чтобы не искать.

- **Обязательные:** `MONGODB_URI`, `ZAI_API_KEY`, `YOUGILE_GLM_API_KEY`, `ADMIN_TOKEN`.
- **Колонки доски:** `COLUMN_DEFAULT`, `COLUMN_TO_EXECUTE`, `COLUMN_REVIEW`, `COLUMN_DONE`, `COLUMN_ERROR`.
- **Модели:** `GLM_MODEL` (исполнитель), `GLM_MODEL_PLANNER` (`glm-4.7-flash`), `GLM_MODEL_VISION` (`glm-4.6v-flash`), `GLM_MODEL_WORKER`, `GLM_MAX_STEPS`, `GLM_MAX_CONTEXT_CHARS`.
- **Почта:** `MAIL_*` (хост, ящик, папка `AI_DONE`, интервалы, TLS). Ящик агента — `ai@rocket-up.space` на `s5.nska.net` (IMAP 993, SSL). Старый `ai@fl.h12.ose.su` не работает: сервер отклонял входящие от Mail.ru по списку Spamhaus, а Mail.ru отклонял его исходящие как спам.
- **Telegram:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_IDS`.
- **MODX:** `MODX_PUBLISHER_URL`, `MODX_PUBLISHER_TOKEN`, `MODX_TEMPLATE_PROMO`, `MODX_PARENT_PROMO`, `MODX_TEMPLATE_ARTICLE`, `MODX_PARENT_ARTICLE`, `MODX_AUTO_PUBLISH`.
- **Хранилище:** `CLOUD_PROVIDER` (`mongo` по умолчанию), `FILES_SECRET`, `R2_*`, `PCLOUD_*`.
- **Поведение задач:** `TASK_BATCH_SIZE`, `TASK_RUNNING_TTL_MIN`, `TASK_MAX_ATTEMPTS`, `TASK_RETRY_COOLDOWN_MIN`.
- **Петля приёмки:** `REVIEW_POLL_INTERVAL_MS` (по умолчанию 120000, меньше 15000 отключает опрос), `REVIEW_POLL_PROJECT` (проект, чьи чаты опрашиваются).
- **Kwork-дайджест:** `KWORK_DIGEST_INTERVAL_MS` (по умолчанию 3600000 — раз в час; меньше 60000 отключает отправку). Письма разбираются почтовым воркером по адресу `MAIL_USER`.
- **Прочее:** `PUBLIC_BASE_URL`, `HTTP_TIMEOUT_MS`, `REPORT_TZ`, `REPORT_HOUR`, `LOG_LEVEL`, `TZ`.

## Правила

1. Секрет, отправленный в чат, считается раскрытым для истории чата: не вставлять его в файлы, коммиты, README, логи. При подозрении на утечку — перевыпустить.
2. PAT для GitHub — только `Contents: Read and write` на один репозиторий, срок до 365 дней. Истёк → `401 Bad credentials` при push, лечится перевыпуском.
3. При старте сервис пишет в лог, что подключено, а что нет. Первым делом при сбое — лог Render, затем `/api/dashboard`.
4. Диагностика по кодам: `401` — токен не совпал; `403` — политика `create_only` в MODX или отсутствие прав у токена; `412` — анти-бот защита хостинга; `429` — лимит YouGile (50 запросов/мин).
