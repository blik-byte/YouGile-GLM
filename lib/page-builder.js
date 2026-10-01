// lib/page-builder.js
// Генерация спеки страницы MODX по одобренному кластеру семантики.
//
// Разделение ответственности то же, что в аудите: модель пишет смысл,
// код гарантирует измеримые ограничения SEO (длины title/description,
// один H1, транслитерация alias, наличие FAQ-блока и разметки).
// Если модель прислала слишком длинный title — код укорачивает по границе
// слова и помечает это в speке, а не молча публикует брак.

const { chatJson } = require('./glm-client');
const { transliterate, toStr } = require('./text');
const { config } = require('./config');

const TITLE_MAX = 60;
const DESCRIPTION_MAX = 160;

/** Мини-конвертер markdown-разметки модели в HTML страницы MODX. */
function markdownToHtml(markdown) {
  const lines = toStr(markdown).split(/\r?\n/);
  const html = [];
  let list = null;
  let paragraph = [];

  const flushList = () => {
    if (list && list.length > 0) html.push(`<ul>\n${list.map((item) => `  <li>${item}</li>`).join('\n')}</ul>`);
    list = null;
  };
  const flushParagraph = () => {
    if (paragraph.length > 0) html.push(`<p>${paragraph.join(' ')}</p>`);
    paragraph = [];
  };

  for (const raw of lines) {
    const line = raw.trim();

    if (!line) {
      flushList();
      flushParagraph();
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushList();
      flushParagraph();
      const level = Math.min(heading[1].length + 1, 6); // H1 reserved for the page
      html.push(`<h${level}>${heading[2]}</h${level}>`);
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (bullet) {
      flushParagraph();
      if (!list) list = [];
      list.push(bullet[1]);
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushList();
  flushParagraph();
  return html.join('\n');
}

/** Укорачивание по границе слова с суффиксом-многоточием без обрыва смысла. */
function fitToLimit(text, limit) {
  const value = toStr(text).trim();
  if (value.length <= limit) return { value, trimmed: false };

  const cut = value.slice(0, limit - 1);
  const boundary = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf(','), cut.lastIndexOf(' —'));
  const fitted = (boundary > limit * 0.5 ? cut.slice(0, boundary) : cut).trimEnd();

  return { value: `${fitted}…`.slice(0, limit), trimmed: true };
}

function buildAlias(title, cluster) {
  const base = transliterate(title || cluster || 'page');
  return (base || 'page').slice(0, 70);
}

const PAGE_PROMPT = `Ты пишешь страницу сайта веб-студии под поисковый кластер.

Требования к результату:
1. Текст закрывает интент кластера и отвечает на 3-5 смежных вопросов клиента.
2. Структура: вступление с ответом на главный вопрос (answer-first), затем
   разделы H2-H3, список преимуществ или состава услуги, блок цен или
   «от чего зависит цена», FAQ из 3-4 реальных вопросов, призыв к действию.
3. Конкретика вместо воды: процессы, сроки, состав работ, критерии качества.
   Не выдумывай цифры клиентов, награды и отзывы — их нет в исходных данных.
4. FAQ-блок обязан повторять формулировки вопросов из кластера.
5. Никакой внутренней перелинковки ссылками: её проставит человек после публикации.

Верни ТОЛЬКО JSON:
{
  "pagetitle": "title до 60 символов с ключом кластера в начале",
  "longtitle": "развёрнутый заголовок до 80 символов",
  "description": "meta description до 160 символов с выгодой и ключом",
  "introtext": "анонс для списка статей, 1-2 предложения",
  "content_markdown": "тело страницы в markdown: ## и ### для заголовков, - для списков",
  "faq": [{"q": "вопрос", "a": "ответ 1-2 предложения"}],
  "schema_hint": "какие типы schema.org уместны: Service, FAQPage, Article"
}`;

/**
 * Сборка спеки страницы.
 *
 * @param {object} params
 * @param {string} params.cluster - опорный запрос одобренного кластера
 * @param {string[]} [params.related] - хвосты кластера для покрытия в тексте
 * @param {'article'|'promo'} params.kind - статья в блог или страница продвижения
 * @param {object} [params.context] - дополнительные факты для модели
 * @returns {Promise<object>} спека для modx-client.createPage
 */
async function buildPageSpec({ cluster, related = [], kind = 'promo', context = {} }) {
  const normalizedCluster = toStr(cluster).trim();
  if (!normalizedCluster) {
    return { success: false, error: 'Не задан кластер (опорный запрос) страницы' };
  }

  let generated;
  try {
    generated = await chatJson(
      PAGE_PROMPT,
      `Кластер: ${normalizedCluster}\n` +
        `Смежные запросы кластера: ${related.slice(0, 12).join('; ') || 'нет'}\n` +
        `Тип страницы: ${kind === 'article' ? 'статья в блог' : 'страница услуги продвижения'}\n` +
        (context.city ? `Гео: ${context.city}\n` : '') +
        (context.notes ? `Дополнительно: ${context.notes}\n` : ''),
      { timeout: 120000 }
    );
  } catch (error) {
    return { success: false, error: `Модель не вернула спеку страницы: ${error.message}` };
  }

  const titleFit = fitToLimit(generated.pagetitle || normalizedCluster, TITLE_MAX);
  const descriptionFit = fitToLimit(generated.description || '', DESCRIPTION_MAX);

  const faq = Array.isArray(generated.faq) ? generated.faq.slice(0, 6) : [];
  const faqHtml =
    faq.length > 0
      ? `<h2>Частые вопросы</h2>\n${faq
          .map((item) => `<h3>${toStr(item.q).trim()}</h3>\n<p>${toStr(item.a).trim()}</p>`)
          .join('\n')}`
      : '';

  const contentHtml = [markdownToHtml(generated.content_markdown), faqHtml]
    .filter(Boolean)
    .join('\n');

  const spec = {
    success: true,
    kind,
    cluster: normalizedCluster,
    pagetitle: titleFit.value,
    longtitle: fitToLimit(generated.longtitle || titleFit.value, 80).value,
    description: descriptionFit.value,
    introtext: fitToLimit(generated.introtext || descriptionFit.value, 300).value,
    alias: buildAlias(titleFit.value, normalizedCluster),
    content: contentHtml,
    faq,
    schemaHint: toStr(generated.schema_hint),
    template: kind === 'article' ? config.modxTemplateArticle : config.modxTemplatePromo,
    parent: kind === 'article' ? config.modxParentArticle : config.modxParentPromo,
    published: 0,
    warnings: [],
  };

  if (titleFit.trimmed) spec.warnings.push(`title укорочен до ${TITLE_MAX} символов по границе слова`);
  if (descriptionFit.trimmed) spec.warnings.push(`description укорочен до ${DESCRIPTION_MAX} символов`);
  if (faq.length === 0) spec.warnings.push('модель не дала FAQ-блок: страница слабее для ИИ-выдачи');
  if (!/<h2/.test(contentHtml)) spec.warnings.push('в теле нет подзаголовков H2');

  return spec;
}

module.exports = { buildPageSpec, markdownToHtml, fitToLimit, buildAlias, TITLE_MAX, DESCRIPTION_MAX };
