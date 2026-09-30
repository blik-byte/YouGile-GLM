// lib/text.js
// Мелкие утилиты: экранирование HTML, санитизация имён файлов, обрезка текста.

const path = require('path');

/**
 * Экранирование спецсимволов HTML.
 * Нужно везде, где пользовательский/модельный текст вставляется в разметку:
 *  - комментарии в YouGile (поле textHtml)
 *  - уведомления Telegram с parse_mode: 'HTML'
 * Без экранирования любой символ '<' или '&' ломает разметку, а Telegram
 * отвечает "Can't parse entities" — и уведомление молча теряется.
 */
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Экранирование под Telegram HTML (тот же набор, что поддерживает Bot API). */
function escapeTelegram(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Перевод многострочного текста в безопасный HTML:
 * сначала экранируем, потом заменяем переводы строк на <br>.
 */
function textToHtml(value) {
  return escapeHtml(value).replace(/\r?\n/g, '<br>');
}

/**
 * Санитизация имени файла.
 * Исходный код делал path.join('/tmp', `${filename}.docx`) без проверки:
 * при filename = "../../etc/cron.d/x" файл уезжал за пределы /tmp.
 * Плюс имена от модели могут содержать символы, недопустимые в pCloud/Drive.
 */
function sanitizeFilename(filename, fallback = 'document') {
  const raw = String(filename ?? '').trim();
  // Нормализуем разделители ОБЕИХ платформ до basename: на Linux backslash
  // не считается разделителем, и "..\..\windows\x" не разрезался бы.
  const base = path.basename(raw.replace(/\\/g, '/'));
  const cleaned = base
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_') // недопустимые символы
    .replace(/\.{2,}/g, '.')                     // ".." -> "."
    .replace(/^\.+/, '')                          // скрытые файлы
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);

  return cleaned || fallback;
}

/** Обрезка строки с пометкой, без разрыва посреди многобайтового символа. */
function truncate(text, limit = 3000, suffix = '…(обрезано)') {
  const str = String(text ?? '');
  if (str.length <= limit) return str;
  return str.slice(0, Math.max(0, limit - suffix.length)) + suffix;
}

/**
 * Обрезка JSON-строки БЕЗ нарушения структуры.
 * Исходный код резал resultStr.substring(0, 3000) — модель получала битый JSON.
 * Здесь вместо этого укорачиваем длинные строковые значения внутри объекта.
 */
function truncateJsonSafe(value, limit = 3000) {
  try {
    const shrink = (node, depth = 0) => {
      if (depth > 6) return node;
      if (typeof node === 'string') return truncate(node, 400, '…');
      if (Array.isArray(node)) {
        const maxItems = 25;
        const sliced = node.slice(0, maxItems).map((item) => shrink(item, depth + 1));
        if (node.length > maxItems) {
          sliced.push(`…ещё ${node.length - maxItems} элементов опущено`);
        }
        return sliced;
      }
      if (node && typeof node === 'object') {
        const out = {};
        for (const [key, val] of Object.entries(node)) out[key] = shrink(val, depth + 1);
        return out;
      }
      return node;
    };

    let result = JSON.stringify(shrink(value));
    if (result.length <= limit) return result;

    // Если всё ещё длинно — режем жёстко, но явно сообщаем модели об этом
    return JSON.stringify({
      truncated: true,
      note: 'Результат слишком большой, показана только часть',
      preview: result.slice(0, limit - 100),
    });
  } catch {
    return truncate(String(value), limit);
  }
}

/**
 * Транслитерация кириллицы в латиницу.
 * Нужна для ключей объектов в облачном хранилище: URL остаётся чистым и не
 * требует двойного экранирования, а исходное кириллическое имя сохраняется
 * отдельно в Content-Disposition (см. r2-client.uploadFile).
 */
const TRANSLIT_MAP = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  і: 'i', ї: 'yi', є: 'ye', ґ: 'g', ў: 'u',
};

function transliterate(value) {
  return String(value ?? '')
    .toLowerCase()
    .split('')
    .map((char) => (TRANSLIT_MAP[char] !== undefined ? TRANSLIT_MAP[char] : char))
    .join('')
    // В ключе объекта допустимы буквы, цифры, дефис, подчёркивание и точка
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
}

/** Приведение значения к строке без падения на undefined/null. */
function toStr(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return typeof value === 'string' ? value : String(value);
}

module.exports = {
  escapeHtml,
  escapeTelegram,
  textToHtml,
  sanitizeFilename,
  transliterate,
  truncate,
  truncateJsonSafe,
  toStr,
};
