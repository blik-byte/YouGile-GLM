// lib/web-content.js
// Извлечение читаемого текста из HTML-страницы — основа инструмента web_analysis.
//
// Работает без сторонних зависимостей: для документов, которые приносит агент,
// полноценный readability-алгоритм избыточен, а cheerio/puppeteer тянули бы
// десятки мегабайт в бесплатный dyno Render.

const { fetchWithTimeout } = require('./http');
const { toStr } = require('./text');

const MAX_BYTES = Number(process.env.WEB_MAX_BYTES || 3 * 1024 * 1024);

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…',
  copy: '©', reg: '®', trade: '™', bull: '•', middot: '·',
  eacute: 'é', egrave: 'è', agrave: 'à', ouml: 'ö', uuml: 'ü', auml: 'ä',
  szlig: 'ß', ntilde: 'ñ', ccedil: 'ç',
  'lt;': '<', 'gt;': '>',
};

function decodeEntities(text) {
  return String(text)
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-zA-Z]+);/g, (match, name) => ENTITIES[name.toLowerCase()] ?? ENTITIES[name.toLowerCase() + ';'] ?? match);
}

/** Убирает теги, содержимое которых — не текст для чтения. */
function stripNoise(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<template[\s\S]*?<\/template>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<canvas[\s\S]*?<\/canvas>/gi, ' ')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, ' ')
    .replace(/<form[\s\S]*?<\/form>/gi, ' ')
    // Навигация, подвал, боковые панели, блоки «похожие статьи», cookie-баннеры
    .replace(/<(nav|footer|aside|header)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(div|section)[^>]*\b(class|id)="[^"]*(nav|menu|sidebar|footer|header|cookie|banner|advert|promo|related|share|social|comment)[^"]*"[\s\S]*?<\/\1>/gi, ' ');
}

/**
 * Разбор страницы на структурные части.
 * @param {string} html
 * @param {string} [url]
 * @returns {{title:string, description:string, headings:string[], text:string, wordCount:number, lang:string|null}}
 */
function extractContent(html, url = '') {
  const source = toStr(html);

  const grab = (re) => {
    const match = source.match(re);
    return match ? decodeEntities(match[1]).replace(/\s+/g, ' ').trim() : '';
  };

  const title =
    grab(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
    grab(/<title[^>]*>([\s\S]*?)<\/title>/i) ||
    grab(/<h1[^>]*>([\s\S]*?)<\/h1>/i);

  const description =
    grab(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ||
    grab(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i) ||
    grab(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);

  const langMatch = source.match(/<html[^>]+lang=["']([a-zA-Z-]+)["']/i);

  // Заголовки — полезная структура документа для модели
  const headings = [];
  const headingRe = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let headingMatch;
  while ((headingMatch = headingRe.exec(source)) !== null && headings.length < 60) {
    const text = decodeEntities(headingMatch[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (text) headings.push(`${'#'.repeat(Number(headingMatch[1]))} ${text}`);
  }

  let body = source;
  const bodyMatch = source.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) body = bodyMatch[1];

  let text = stripNoise(body);

  // Блочные элементы → переводы строк, чтобы структура не слипалась
  text = text
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)>/gi, '\n')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/td>/gi, ' | ')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, ' ');

  text = decodeEntities(text)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const wordCount = text ? text.split(/\s+/).length : 0;

  return {
    url,
    title: title.slice(0, 300),
    description: description.slice(0, 500),
    lang: langMatch ? langMatch[1] : null,
    headings,
    text,
    wordCount,
  };
}

/**
 * Загрузка страницы и извлечение текста.
 * @param {string} url
 * @param {object} [options]
 * @param {number} [options.timeout]
 * @param {number} [options.maxChars]
 */
async function fetchReadable(url, options = {}) {
  const timeout = options.timeout ?? 30000;
  const maxChars = options.maxChars ?? 20000;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Некорректный URL: ${url}`);
  }

  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error(`Поддерживаются только http(s), получен протокол ${parsed.protocol}`);
  }

  const response = await fetchWithTimeout(
    parsed.toString(),
    {
      redirect: 'follow',
      headers: {
        // Обычный браузерный UA: многие сайты отдают 403 на дефолтный Node-заголовок
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru,en;q=0.8',
      },
    },
    { timeout }
  );

  if (!response.ok) {
    const error = new Error(`Сервер вернул ${response.status} ${response.statusText || ''}`.trim());
    error.status = response.status;
    throw error;
  }

  const contentType = response.headers.get('content-type') || '';
  const buffer = await response.arrayBuffer();

  if (buffer.byteLength > MAX_BYTES) {
    throw new Error(`Страница больше ${Math.round(MAX_BYTES / 1024 / 1024)} МБ — не обрабатывается`);
  }

  if (/application\/pdf/i.test(contentType)) {
    throw new Error('Это PDF. Инструмент чтения PDF пока не реализован — используйте web_search для поиска HTML-версии.');
  }

  if (!/text\/html|application\/xhtml|text\/xml|application\/xml|text\/plain/i.test(contentType)) {
    throw new Error(`Неподдерживаемый тип содержимого: ${contentType || 'не определён'}`);
  }

  const charsetMatch = contentType.match(/charset=([\w-]+)/i);
  const html = Buffer.from(buffer).toString(charsetMatch ? charsetMatch[1] : 'utf8');

  const content = extractContent(html, parsed.toString());

  if (content.wordCount < 20) {
    throw new Error(
      'Со страницы не удалось извлечь текст — вероятно, содержимое загружается JavaScript. ' +
        'Попробуйте web_search по этой теме или найдите другой источник.'
    );
  }

  if (content.text.length > maxChars) {
    content.text = content.text.slice(0, maxChars);
    content.truncated = true;
  }

  return content;
}

module.exports = { fetchReadable, extractContent, decodeEntities, stripNoise };
