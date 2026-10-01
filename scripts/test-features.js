#!/usr/bin/env node
// scripts/test-features.js
// Тесты новых возможностей: pCloud, цепочка поисковых провайдеров,
// извлечение текста со страниц, расширенный набор инструментов агента.
// Не требуют сети и внешних ключей — провайдеры подменяются заглушками.

require('dotenv').config({ quiet: true });

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const results = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push({ name, ok: true });
      console.log(`  ✅ ${name}`);
    })
    .catch((error) => {
      results.push({ name, ok: false, error });
      console.log(`  ❌ ${name}`);
      console.log(`     ${String(error.message).split('\n').slice(0, 3).join('\n     ')}`);
    });
}

async function main() {
  console.log('\n🧪 Тесты новых возможностей (pCloud, поиск, web_analysis)\n');

  const { extractContent, decodeEntities, fetchReadable } = require('../lib/web-content');
  const search = require('../lib/search');
  const pcloud = require('../pcloud-client');
  const executors = require('../tool-executors');
  const tools = require('../tools');

  /* ================================================================== */
  console.log('— Извлечение текста со страниц (web_analysis) —');
  /* ================================================================== */

  const SAMPLE_HTML = `<!DOCTYPE html>
<html lang="ru">
<head>
  <title>Обзор ноутбуков 2026 — TechBlog</title>
  <meta name="description" content="Сравнение популярных моделей ноутбуков для работы">
  <style>body { color: red; }</style>
  <script>var secret = "не должно попасть в текст";</script>
</head>
<body>
  <nav><a href="/">Главная</a><a href="/about">О нас</a></nav>
  <article>
    <h1>Обзор ноутбуков 2026</h1>
    <h2>Модель A</h2>
    <p>Цена &laquo;от 50&nbsp;000 рублей&raquo;, экран 14&quot;.</p>
    <ul><li>Первый пункт</li><li>Второй пункт</li></ul>
    <h2>Модель B</h2>
    <p>Цена от 80 000 &mdash; дороже, но мощнее &amp; тише.</p>
  </article>
  <div class="related-posts">Похожие статьи: не должно попасть</div>
  <footer>Copyright 2026</footer>
</body>
</html>`;

  await test('extractContent: заголовок и описание извлекаются', () => {
    const result = extractContent(SAMPLE_HTML, 'https://example.com');
    assert.ok(result.title.includes('Обзор ноутбуков'), `title: ${result.title}`);
    assert.ok(result.description.includes('Сравнение'), `description: ${result.description}`);
    assert.strictEqual(result.lang, 'ru');
  });

  await test('extractContent: script и style не попадают в текст', () => {
    const { text } = extractContent(SAMPLE_HTML);
    assert.ok(!text.includes('var secret'), 'содержимое <script> просочилось в текст');
    assert.ok(!text.includes('color: red'), 'содержимое <style> просочилось в текст');
  });

  await test('extractContent: nav, footer и «похожие статьи» отсекаются', () => {
    const { text } = extractContent(SAMPLE_HTML);
    assert.ok(!/Похожие статьи/.test(text), 'блок related-posts не отсечён');
    assert.ok(!/Copyright 2026/.test(text), 'footer не отсечён');
  });

  await test('extractContent: HTML-сущности декодируются', () => {
    const { text } = extractContent(SAMPLE_HTML);
    assert.ok(text.includes('«от 50'), `кавычки не декодированы: ${text.slice(0, 200)}`);
    assert.ok(text.includes('мощнее & тише'), 'амперсанд не декодирован');
    assert.ok(!text.includes('&laquo;') && !text.includes('&nbsp;') && !text.includes('&mdash;'));
  });

  await test('extractContent: структура заголовков сохраняется', () => {
    const { headings } = extractContent(SAMPLE_HTML);
    assert.ok(headings.includes('# Обзор ноутбуков 2026'), `headings: ${JSON.stringify(headings)}`);
    assert.ok(headings.includes('## Модель A'));
    assert.ok(headings.includes('## Модель B'));
  });

  await test('extractContent: списки становятся маркированными пунктами', () => {
    const { text } = extractContent(SAMPLE_HTML);
    assert.ok(text.includes('• Первый пункт'), 'маркер списка потерян');
    assert.ok(text.includes('• Второй пункт'));
  });

  await test('decodeEntities: числовые и шестнадцатеричные коды', () => {
    assert.strictEqual(decodeEntities('&#1055;&#1088;&#1080;&#1074;&#1077;&#1090;'), 'Привет');
    assert.strictEqual(decodeEntities('&#x41;&#x42;'), 'AB');
    assert.strictEqual(decodeEntities('&amp;&lt;&gt;&quot;'), '&<>"');
    assert.strictEqual(decodeEntities('без сущностей'), 'без сущностей');
  });

  await test('extractContent: пустой и мусорный HTML не роняют функцию', () => {
    for (const input of ['', '   ', '<html></html>', undefined, null, 12345]) {
      const result = extractContent(input);
      assert.strictEqual(typeof result.text, 'string');
      assert.strictEqual(typeof result.wordCount, 'number');
    }
  });

  await test('fetchReadable: отклоняет не-http протоколы и битые URL', async () => {
    await assert.rejects(() => fetchReadable('ftp://example.com/file'), /только http/);
    await assert.rejects(() => fetchReadable('file:///etc/passwd'), /только http/);
    await assert.rejects(() => fetchReadable('не url вовсе'), /Некорректный URL/);
  });

  /* ================================================================== */
  console.log('\n— Цепочка поисковых провайдеров (web_search) —');
  /* ================================================================== */

  await test('H4 провайдер DuckDuckGo Instant Answer удалён из кода', () => {
    const source = fs.readFileSync(require.resolve('../lib/search.js'), 'utf8');
    // Вырезаем комментарии: в них API упомянут как описание проблемы, а не как вызов
    const codeOnly = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !/^\s*\/\//.test(line))
      .join('\n');

    assert.ok(!/api\.duckduckgo\.com/.test(codeOnly), 'DuckDuckGo Instant Answer API всё ещё вызывается');
    assert.ok(/tavily/.test(codeOnly), 'основной провайдер Tavily пропал');
    assert.ok(/wikipedia/.test(codeOnly), 'бесплатный резервный провайдер пропал');
  });

  await test('H4 есть резервный провайдер, работающий без API-ключей', () => {
    // Wikipedia не требует ключа — поиск не «умирает», когда лимит Tavily исчерпан
    const keyless = Object.entries(search.PROVIDERS)
      .filter(([, provider]) => provider.available())
      .map(([name]) => name);
    assert.ok(keyless.length > 0, 'нет ни одного доступного провайдера');
    assert.ok(keyless.includes('wikipedia'), `Wikipedia должна быть доступна всегда, есть: ${keyless}`);
  });

  await test('search: пустой запрос возвращает явную ошибку, а не падает', async () => {
    for (const bad of ['', '   ', null, undefined, 0]) {
      const result = await search.search(bad);
      assert.strictEqual(result.success, undefined);
      assert.ok(result.error, 'должна быть явная ошибка');
      assert.deepStrictEqual(result.results, []);
    }
  });

  await test('search: слишком короткий запрос отклоняется', async () => {
    const result = await search.search('а');
    assert.ok(/короткий/i.test(result.error));
  });

  await test('H4 search: если все провайдеры отказали — модель получает явный запрет выдумывать', async () => {
    const original = { ...search.PROVIDERS };
    const failing = {
      fn: async () => {
        throw new Error('провайдер недоступен');
      },
      available: () => true,
    };
    search.PROVIDERS.tavily = failing;
    search.PROVIDERS.brave = failing;
    search.PROVIDERS.google = failing;
    search.PROVIDERS.wikipedia = failing;

    try {
      const result = await search.search('цены на ноутбуки Москва', { skipCache: true });
      assert.ok(result.error, 'должна быть явная ошибка, а не молчаливая пустота');
      assert.deepStrictEqual(result.results, []);
      assert.strictEqual(result.source, 'none');
      // Ключевое: модель должна понять, что данных нет, и не начать их выдумывать
      assert.ok(/придумыв/i.test(result.error), `нет запрета выдумывать данные: ${result.error}`);
      assert.strictEqual(result.providersTried.length, 4, 'не все провайдеры были опробованы');
    } finally {
      Object.assign(search.PROVIDERS, original);
    }
  });

  await test('H4 search: пустая выдача провайдера больше не маскируется под успех', async () => {
    const original = { ...search.PROVIDERS };
    const saved = process.env.TAVILY_API_KEY;
    process.env.TAVILY_API_KEY = 'fake-key';
    delete require.cache[require.resolve('../lib/config')];
    delete require.cache[require.resolve('../lib/search')];
    const fresh = require('../lib/search');

    fresh.PROVIDERS.tavily = {
      fn: async () => ({ query: 'q', answer: null, results: [], source: 'tavily' }),
      available: () => true,
    };
    fresh.PROVIDERS.brave = { fn: async () => { throw new Error('нет ключа'); }, available: () => false };
    fresh.PROVIDERS.google = { fn: async () => { throw new Error('нет ключа'); }, available: () => false };
    fresh.PROVIDERS.wikipedia = {
      fn: async () => ({ query: 'q', results: [{ title: 'T', url: 'https://u', content: 'C' }], source: 'wikipedia' }),
      available: () => true,
    };

    try {
      const result = await fresh.search('пустая выдача', { skipCache: true });
      assert.strictEqual(result.source, 'wikipedia', 'цепочка должна была дойти до следующего провайдера');
      assert.ok(result.results.length > 0);
      assert.ok(result.providersTried.some((p) => p.provider === 'tavily' && p.status === 'empty'));
    } finally {
      Object.assign(search.PROVIDERS, original);
      if (saved) process.env.TAVILY_API_KEY = saved;
      else delete process.env.TAVILY_API_KEY;
      delete require.cache[require.resolve('../lib/config')];
      delete require.cache[require.resolve('../lib/search')];
    }
  });

  await test('search: цепочка переходит к следующему провайдеру при ошибке', async () => {
    const calls = [];
    const original = { ...search.PROVIDERS };

    search.PROVIDERS.tavily = {
      fn: async (q) => {
        calls.push('tavily');
        throw new Error('Tavily 429: rate limited');
      },
      available: () => true,
    };
    search.PROVIDERS.wikipedia = {
      fn: async (q) => {
        calls.push('wikipedia');
        return {
          query: q,
          answer: null,
          results: [{ title: 'Node.js', url: 'https://ru.wikipedia.org/wiki/Node.js', content: 'текст' }],
          source: 'wikipedia',
        };
      },
      available: () => true,
    };

    process.env.SEARCH_PROVIDERS = 'tavily,wikipedia';

    try {
      const result = await search.search('Node.js среда выполнения', { skipCache: true });
      assert.ok(calls.includes('tavily'), 'первый провайдер не был вызван');
      assert.ok(calls.includes('wikipedia'), 'цепочка не дошла до запасного провайдера');
      assert.strictEqual(result.source, 'wikipedia');
      assert.ok(result.results.length > 0);
      assert.ok(result.providersTried.some((p) => p.provider === 'tavily' && p.status === 'error'));
    } finally {
      Object.assign(search.PROVIDERS, original);
      delete process.env.SEARCH_PROVIDERS;
    }
  });

  await test('search: пустой ответ провайдера не считается успехом', async () => {
    const original = { ...search.PROVIDERS };
    search.PROVIDERS.tavily = {
      fn: async () => ({ query: 'q', answer: null, results: [], source: 'tavily' }),
      available: () => true,
    };
    search.PROVIDERS.wikipedia = {
      fn: async () => ({
        query: 'q',
        results: [{ title: 'T', url: 'https://u', content: 'C' }],
        source: 'wikipedia',
      }),
      available: () => true,
    };
    process.env.SEARCH_PROVIDERS = 'tavily,wikipedia';

    try {
      const result = await search.search('запрос с пустой выдачей', { skipCache: true });
      assert.strictEqual(result.source, 'wikipedia', 'должен был сработать второй провайдер');
    } finally {
      Object.assign(search.PROVIDERS, original);
      delete process.env.SEARCH_PROVIDERS;
    }
  });

  await test('search: порядок провайдеров настраивается через SEARCH_PROVIDERS', () => {
    process.env.SEARCH_PROVIDERS = 'wikipedia,tavily,несуществующий';
    delete require.cache[require.resolve('../lib/search')];
    const fresh = require('../lib/search');
    assert.deepStrictEqual(fresh.providerOrder(), ['wikipedia', 'tavily']);
    delete process.env.SEARCH_PROVIDERS;
    delete require.cache[require.resolve('../lib/search')];
  });

  await test('webSearch: валидирует аргументы и не падает на undefined', async () => {
    const result = await executors.webSearch(undefined);
    assert.strictEqual(result.success, false);
    assert.ok(/query/i.test(result.error));
  });

  /* ================================================================== */
  console.log('\n— pCloud —');
  /* ================================================================== */

  await test('pcloud: регион EU использует eapi.pcloud.com', () => {
    assert.strictEqual(pcloud.host(), 'https://eapi.pcloud.com');
  });

  await test('pcloud: коды ошибок переведены на русский', () => {
    assert.ok(/авторизац/i.test(pcloud.ERROR_CODES[1000]));
    assert.ok(/квот/i.test(pcloud.ERROR_CODES[2008]));
    assert.ok(/email/i.test(pcloud.ERROR_CODES[2014]));
    assert.ok(/IP/i.test(pcloud.ERROR_CODES[4000]));
  });

  await test('pcloud: isConfigured() честен при отсутствии токена', () => {
    const savedToken = process.env.PCLOUD_AUTH_TOKEN;
    const savedEmail = process.env.PCLOUD_EMAIL;
    const savedPass = process.env.PCLOUD_PASSWORD;
    delete process.env.PCLOUD_AUTH_TOKEN;
    delete process.env.PCLOUD_EMAIL;
    delete process.env.PCLOUD_PASSWORD;

    delete require.cache[require.resolve('../lib/config')];
    delete require.cache[require.resolve('../pcloud-client')];
    const fresh = require('../pcloud-client');

    try {
      assert.strictEqual(fresh.isConfigured(), false);
    } finally {
      if (savedToken) process.env.PCLOUD_AUTH_TOKEN = savedToken;
      if (savedEmail) process.env.PCLOUD_EMAIL = savedEmail;
      if (savedPass) process.env.PCLOUD_PASSWORD = savedPass;
      delete require.cache[require.resolve('../lib/config')];
      delete require.cache[require.resolve('../pcloud-client')];
    }
  });

  await test('M22 createDocument: без настроенного облака возвращает понятную ошибку и содержимое', async () => {
    const result = await executors.createDocument('txt', 'тест-без-облака', '', 'Содержимое отчёта', []);
    assert.strictEqual(result.success, false);
    // Ошибка должна называть переменные, которые нужно заполнить
    assert.ok(/CLOUD_PROVIDER|R2_ACCOUNT_ID|R2_BUCKET/i.test(result.error), `нет указания на настройки: ${result.error}`);
    assert.ok(result.contentPreview.includes('Содержимое отчёта'), 'результат работы потерян');
    // И подсказывать модели, что делать дальше
    assert.ok(/комментари/i.test(result.error), 'нет инструкции передать содержимое в комментарии');
  });

  await test('M22 googleapis больше не в зависимостях', () => {
    const pkg = require('../package.json');
    assert.strictEqual(pkg.dependencies.googleapis, undefined);
    assert.strictEqual(pkg.dependencies.openai, undefined);
  });

  await test('pcloud.upload: полный цикл загрузки и публичной ссылки', async () => {
    // Подменяем сетевой слой: внутри pcloud-client идут прямые вызовы функций,
    // поэтому патчить экспорты модуля бессмысленно — проверяем реальный путь кода.
    process.env.PCLOUD_AUTH_TOKEN = 'test-token-for-ci';
    process.env.PCLOUD_FOLDER_ID = '12345';
    delete require.cache[require.resolve('../lib/config')];
    delete require.cache[require.resolve('../pcloud-client')];
    const fresh = require('../pcloud-client');

    const json = (obj) => ({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: async () => obj,
      text: async () => JSON.stringify(obj),
    });

    const seen = [];
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      const target = String(url);
      seen.push(target);

      if (target.includes('/uploadfile')) {
        return json({
          result: 0,
          fileids: [999],
          metadata: [{ fileid: 999, name: 'отчёт.xlsx', size: 2048, path: '/AI-документы/отчёт.xlsx' }],
        });
      }
      if (target.includes('/getfilepublink')) {
        return json({
          result: 0,
          linkid: 777,
          code: 'XABC',
          link: 'https://e.pcloud.link/publink/show?code=XABC',
          shortlink: 'https://pc.cd/xabc',
        });
      }
      if (target.includes('/getpublinkdownload')) {
        return json({ result: 0, hosts: ['eapisgp1.pcloud.com'], path: '/publink/download?code=XABC' });
      }
      return json({ result: 5000, error: 'unexpected call' });
    };

    let uploaded;
    const tmp = path.join(os.tmpdir(), `pcloud-upload-test-${Date.now()}.xlsx`);
    try {
      fs.writeFileSync(tmp, 'данные таблицы');
      uploaded = await fresh.upload(tmp, 'отчёт.xlsx');
    } finally {
      global.fetch = originalFetch;
      fs.rmSync(tmp, { force: true });
      delete process.env.PCLOUD_AUTH_TOKEN;
      delete process.env.PCLOUD_FOLDER_ID;
      delete require.cache[require.resolve('../lib/config')];
      delete require.cache[require.resolve('../pcloud-client')];
    }

    assert.strictEqual(uploaded.success, true, `ошибка загрузки: ${uploaded.error}`);
    assert.strictEqual(uploaded.provider, 'pcloud');
    assert.strictEqual(uploaded.fileId, 999);
    assert.strictEqual(uploaded.size, 2048);
    assert.ok(uploaded.link.includes('e.pcloud.link'), `link: ${uploaded.link}`);
    assert.strictEqual(uploaded.shortlink, 'https://pc.cd/xabc');
    assert.ok(uploaded.downloadLink.includes('eapisgp1.pcloud.com'), `downloadLink: ${uploaded.downloadLink}`);

    // Запрос должен идти на EU-хост с токеном в заголовке, а не в query
    assert.ok(seen.some((u) => u.startsWith('https://eapi.pcloud.com/')), `хосты: ${seen.join(', ')}`);
    assert.ok(!seen.some((u) => u.includes('test-token-for-ci')), 'токен не должен попадать в URL');
  });

  await test('pcloud: ошибка квоты (2008) возвращается в понятном виде', async () => {
    process.env.PCLOUD_AUTH_TOKEN = 'test-token';
    delete require.cache[require.resolve('../lib/config')];
    delete require.cache[require.resolve('../pcloud-client')];
    const fresh = require('../pcloud-client');

    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      status: 200,
      headers: new Map(),
      json: async () => ({ result: 2008, error: 'User is over quota' }),
      text: async () => '{"result":2008}',
    });

    const tmp = path.join(os.tmpdir(), `pcloud-quota-${Date.now()}.txt`);
    try {
      fs.writeFileSync(tmp, 'x');
      const result = await fresh.upload(tmp, 'файл.txt');
      assert.strictEqual(result.success, false);
      assert.ok(/квот/i.test(result.error), `ошибка непонятна: ${result.error}`);
      assert.strictEqual(result.code, 2008);
    } finally {
      global.fetch = originalFetch;
      fs.rmSync(tmp, { force: true });
      delete process.env.PCLOUD_AUTH_TOKEN;
      delete require.cache[require.resolve('../lib/config')];
      delete require.cache[require.resolve('../pcloud-client')];
    }
  });

  /* ================================================================== */
  console.log('\n— create_document: форматы и валидация —');
  /* ================================================================== */

  await test('createDocument: неподдерживаемый формат отклоняется', async () => {
    const result = await executors.createDocument('exe', 'virus', '', 'content');
    assert.strictEqual(result.success, false);
    assert.ok(/Неподдерживаемый формат/.test(result.error));
    assert.ok(result.error.includes('docx'), 'в ошибке должен быть список доступных форматов');
  });

  await test('createDocument: xlsx без tables отклоняется с подсказкой', async () => {
    const result = await executors.createDocument('xlsx', 'пустая-таблица', '', '', []);
    assert.strictEqual(result.success, false);
    assert.ok(/tables/.test(result.error));
  });

  await test('createDocument: docx без content и title отклоняется', async () => {
    const result = await executors.createDocument('docx', 'пустой', '', '', []);
    assert.strictEqual(result.success, false);
    assert.ok(/title или content/.test(result.error));
  });

  await test('createDocument: json с невалидным содержимым отклоняется', async () => {
    const result = await executors.createDocument('json', 'битый', '', '{ не json', []);
    assert.strictEqual(result.success, false);
    assert.ok(/валидным JSON/.test(result.error));
  });

  await test('M9 createDocument: имя файла санитизируется перед созданием', async () => {
    const result = await executors.createDocument('txt', '../../../etc/cron.d/backdoor', '', 'текст', []);
    // Облако не настроено, но проверка имени должна отработать без записи вне /tmp
    assert.strictEqual(result.success, false);
    assert.ok(!/\.\.\//.test(result.filename || ''), `имя не санитизировано: ${result.filename}`);
    assert.ok(!fs.existsSync('/etc/cron.d/backdoor.txt'), 'файл записан вне временной папки!');
  });

  await test('M5 временные файлы удаляются даже при ошибке загрузки', async () => {
    const before = new Set(fs.readdirSync(os.tmpdir()));

    await executors.createDocument('txt', 'чистка-временных', '', 'данные', []);
    await executors.createDocument('md', 'чистка-md', '', '# Заголовок', []);

    // Даём ФС момент на освобождение
    await new Promise((r) => setTimeout(r, 50));
    const after = fs.readdirSync(os.tmpdir());

    const leaked = after.filter((f) => !before.has(f) && /чистка|chistka/i.test(decodeURIComponent(f)));
    assert.deepStrictEqual(leaked, [], `во временной папке остались файлы: ${leaked.join(', ')}`);
  });

  await test('createDocument: md и csv создаются корректно (проверяем генератор)', async () => {
    const { createTxt } = require('../document-generator');
    const mdPath = await createTxt('проверка-md', '# Заголовок\n\n- пункт');
    assert.ok(fs.existsSync(mdPath));
    assert.strictEqual(fs.readFileSync(mdPath, 'utf8'), '# Заголовок\n\n- пункт');
    await fs.promises.unlink(mdPath);
  });

  /* ================================================================== */
  console.log('\n— web_analysis —');
  /* ================================================================== */

  await test('M33 web_analysis объявлен в tools.js (раньше его не существовало)', () => {
    const names = tools.map((t) => t.function.name);
    assert.ok(names.includes('web_analysis'), `в tools.js нет web_analysis: ${names.join(', ')}`);
  });

  await test('webAnalysis: валидирует URL', async () => {
    assert.strictEqual((await executors.webAnalysis('')).success, false);
    assert.ok(/url/i.test((await executors.webAnalysis('')).error));

    const bad = await executors.webAnalysis('ftp://example.com');
    assert.strictEqual(bad.success, false);
    assert.ok(/http/.test(bad.error));

    const notUrl = await executors.webAnalysis('это не ссылка');
    assert.strictEqual(notUrl.success, false);
    assert.ok(/Некорректный URL/.test(notUrl.error));
  });

  await test('M33 ai-agent умеет вызывать ВСЕ объявленные инструменты', () => {
    const { TOOL_HANDLERS } = require('../ai-agent');
    const declared = tools.map((t) => t.function.name);
    const missing = declared.filter((name) => typeof TOOL_HANDLERS[name] !== 'function');
    assert.deepStrictEqual(missing, [], `объявлены, но не реализованы: ${missing.join(', ')}`);

    const orphan = Object.keys(TOOL_HANDLERS).filter((name) => !declared.includes(name));
    assert.deepStrictEqual(orphan, [], `реализованы, но не объявлены: ${orphan.join(', ')}`);
  });

  await test('tools.js: у каждого инструмента есть описание и required', () => {
    for (const tool of tools) {
      assert.strictEqual(tool.type, 'function');
      assert.ok(tool.function.name, 'нет имени');
      assert.ok(tool.function.description && tool.function.description.length > 20, `слабое описание у ${tool.function.name}`);
      assert.strictEqual(tool.function.parameters.type, 'object');
      assert.ok(Array.isArray(tool.function.parameters.required), `нет required у ${tool.function.name}`);
      for (const required of tool.function.parameters.required) {
        assert.ok(tool.function.parameters.properties[required], `${required} в required, но не описан`);
      }
    }
  });

  await test('tools.js: экспортируется массив инструментов без лишних полей', () => {
    assert.ok(Array.isArray(tools));
    // Свойство TOOL_NAMES не должно уезжать в JSON запроса к GLM
    const serialized = JSON.stringify(tools);
    assert.ok(!serialized.includes('TOOL_NAMES'), 'служебное поле TOOL_NAMES уезжает в запрос к GLM');
    const parsed = JSON.parse(serialized);
    assert.ok(Array.isArray(parsed));
    assert.deepStrictEqual(Object.keys(parsed[0]), ['type', 'function']);
  });

  /* ================================================================== */
  console.log('\n— YouGile-клиент —');
  /* ================================================================== */

  const yougile = require('../lib/yougile-client');

  await test('M27 extractList разбирает все известные формы ответа YouGile', () => {
    assert.deepStrictEqual(yougile.extractList([{ id: 1 }]), [{ id: 1 }]);
    assert.deepStrictEqual(yougile.extractList({ content: [{ id: 2 }] }), [{ id: 2 }]);
    assert.deepStrictEqual(yougile.extractList({ items: [{ id: 3 }] }), [{ id: 3 }]);
    assert.deepStrictEqual(yougile.extractList({ tasks: [{ id: 4 }] }), [{ id: 4 }]);
    assert.deepStrictEqual(yougile.extractList(null), []);
    assert.deepStrictEqual(yougile.extractList('строка'), []);
    assert.deepStrictEqual(yougile.extractList({}), []);
  });

  await test('M7 вебхук: URL берётся из PUBLIC_BASE_URL, а не захардкожен', () => {
    const source = fs.readFileSync(require.resolve('../lib/yougile-client.js'), 'utf8');
    assert.ok(/publicBaseUrl/.test(source), 'URL вебхука должен браться из конфигурации');
    assert.ok(!/yougile-glm\.onrender\.com/.test(source), 'остался захардкоженный URL');
  });

  await test('M7 ensureWebhook не создаёт дубли подписок', () => {
    const source = fs.readFileSync(require.resolve('../lib/yougile-client.js'), 'utf8');
    const fn = source.slice(source.indexOf('async function ensureWebhook'));
    const getIdx = fn.indexOf("request('GET', '/webhooks')");
    const postIdx = fn.indexOf("request('POST', '/webhooks'");
    assert.ok(getIdx > -1, 'нет проверки существующих подписок');
    assert.ok(postIdx > getIdx, 'создание подписки должно идти ПОСЛЕ проверки');
  });

  await test('H5 addChatMessage экранирует HTML в тексте комментария', () => {
    const source = fs.readFileSync(require.resolve('../lib/yougile-client.js'), 'utf8');
    const fn = source.slice(source.indexOf('async function addChatMessage'));
    assert.ok(/textToHtml/.test(fn), 'текст комментария должен экранироваться');
  });

  /* ================================================================== */
  console.log('\n— Веб-дашборд —');
  /* ================================================================== */

  const dashboard = require('../lib/dashboard');

  await test('dashboard.collect() возвращает все разделы и не падает без внешних сервисов', async () => {
    const data = await dashboard.collect({ limit: 5 });

    const required = [
      'generatedAt', 'runtime', 'warnings', 'services', 'columns',
      'agentRuns', 'taskRuns', 'recentSteps', 'access', 'accessRequests', 'stats',
    ];
    for (const key of required) {
      assert.ok(key in data, `в ответе нет раздела "${key}"`);
    }

    // Даже когда MongoDB и YouGile недоступны, дашборд обязан отдать картину,
    // а не упасть — иначе диагностика невозможна в момент аварии
    for (const name of ['mongo', 'glm', 'cloud', 'search', 'telegram', 'yougile', 'mail']) {
      assert.ok(name in data.services, `нет состояния сервиса "${name}"`);
      assert.strictEqual(typeof data.services[name].ok, 'boolean');
    }

    assert.ok(Array.isArray(data.warnings));
    assert.ok(Number.isFinite(data.runtime.uptimeSec));
    assert.ok(data.runtime.memory.rssMb > 0);
  });

  await test('dashboard: предупреждает о критичных пробелах в конфигурации', async () => {
    const warnings = await dashboard.collectConfigWarnings();
    const texts = warnings.map((w) => w.text).join(' | ');

    assert.ok(warnings.every((w) => ['critical', 'warning', 'info'].includes(w.level)), 'неизвестный уровень предупреждения');
    assert.ok(Array.isArray(warnings), 'collectConfigWarnings должен возвращать массив');
    assert.ok(/ADMIN_TOKEN/.test(texts) || process.env.ADMIN_TOKEN, 'нет предупреждения про ADMIN_TOKEN');
    assert.ok(/TELEGRAM_ADMIN_IDS/.test(texts) || process.env.TELEGRAM_ADMIN_IDS, 'нет предупреждения про whitelist');
    assert.ok(/COLUMN_TO_EXECUTE/.test(texts) || process.env.COLUMN_TO_EXECUTE, 'нет предупреждения про колонку');
  });

  await test('дашборд: / открыт, /api/dashboard закрыт токеном', () => {
    const source = fs.readFileSync(require.resolve('../index.js'), 'utf8');

    const rootLine = source.split('\n').find((l) => /app\.get\('\/'/.test(l));
    assert.ok(rootLine && !/requireAdmin/.test(rootLine), '/ должен оставаться открытым — его пингует cron-job.org');
    assert.ok(/sendFile/.test(source), 'корень должен отдавать HTML дашборда');

    const healthLine = source.split('\n').find((l) => /app\.get\('\/health'/.test(l));
    assert.ok(healthLine && !/requireAdmin/.test(healthLine), '/health должен оставаться открытым');

    const apiLine = source.split('\n').find((l) => /app\.get\('\/api\/dashboard'/.test(l));
    assert.ok(apiLine && /requireAdmin/.test(apiLine), '/api/dashboard обязан требовать токен');
  });

  await test('дашборд: HTML не зависит от внешних ресурсов', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    // CDN не подключается намеренно: страница должна работать офлайн и в изолированном preview
    assert.ok(!/<script[^>]+src=["']https?:/i.test(html), 'подключён внешний скрипт');
    assert.ok(!/<link[^>]+href=["']https?:/i.test(html), 'подключена внешняя таблица стилей');
    assert.ok(/<style>/.test(html), 'стили должны быть встроены');
    assert.ok(html.includes('X-Admin-Token'), 'нет передачи токена в запросах');
    assert.ok(/esc\(/.test(html), 'нет экранирования при выводе данных');
  });

  /* ================================================================== */
  console.log('\n— Роутинг трёх моделей —');
  /* ================================================================== */

  const glm = require('../lib/glm-client');

  await test('роли моделей разрешаются независимо и переопределяются из окружения', () => {
    assert.strictEqual(glm.modelFor('worker'), 'glm-4.5-flash');
    assert.strictEqual(glm.modelFor('planner'), 'glm-4.7-flash');
    assert.strictEqual(glm.modelFor('vision'), 'glm-4.6v-flash');
    assert.strictEqual(glm.modelFor('unknown-role'), 'glm-4.5-flash', 'неизвестная роль должна идти на worker');

    process.env.GLM_MODEL_PLANNER = 'glm-4.7';
    delete require.cache[require.resolve('../lib/config')];
    delete require.cache[require.resolve('../lib/glm-client')];
    const fresh = require('../lib/glm-client');
    try {
      assert.strictEqual(fresh.modelFor('planner'), 'glm-4.7');
      assert.strictEqual(fresh.modelFor('worker'), 'glm-4.5-flash', 'переопределение не должно трогать другие роли');
    } finally {
      delete process.env.GLM_MODEL_PLANNER;
      delete require.cache[require.resolve('../lib/config')];
      delete require.cache[require.resolve('../lib/glm-client')];
    }
  });

  await test('детектор недоступности модели не срабатывает на обычных ошибках', () => {
    assert.strictEqual(glm.isModelUnavailable({ status: 404, body: '' }), true);
    assert.strictEqual(glm.isModelUnavailable({ status: 400, body: '{"error":"model not found"}' }), true);
    assert.strictEqual(glm.isModelUnavailable({ status: 400, body: 'invalid arguments' }), false);
    assert.strictEqual(glm.isModelUnavailable({ status: 429, body: 'rate limit' }), false);
    assert.strictEqual(glm.isModelUnavailable({ status: 500, body: 'boom' }), false);
  });

  await test('при недоступной модели роли запрос прозрачно уходит на worker', async () => {
    process.env.ZAI_API_KEY = 'test-key';
    delete require.cache[require.resolve('../lib/config')];
    delete require.cache[require.resolve('../lib/glm-client')];
    const freshGlm = require('../lib/glm-client');

    const bodies = [];
    const originalFetch = global.fetch;
    global.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body.model);

      if (bodies.length === 1) {
        return {
          ok: false,
          status: 404,
          headers: new Map(),
          text: async () => '{"error":{"message":"model not found"}}',
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () =>
          JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'готово' } }], usage: {} }),
      };
    };

    try {
      const result = await freshGlm.chatCompletion({
        role: 'vision',
        messages: [{ role: 'user', content: 'посмотри картинку' }],
      });

      assert.strictEqual(bodies.length, 2, `запросов ${bodies.length}, ожидалось 2 (роль + фолбэк)`);
      assert.strictEqual(bodies[0], 'glm-4.6v-flash', 'первый запрос должен идти на модель роли');
      assert.strictEqual(bodies[1], 'glm-4.5-flash', 'второй запрос должен уйти на worker');
      assert.strictEqual(result.message.content, 'готово');
      assert.strictEqual(result.model, 'glm-4.5-flash', 'в результате должна быть фактическая модель');
    } finally {
      global.fetch = originalFetch;
      delete require.cache[require.resolve('../lib/config')];
      delete require.cache[require.resolve('../lib/glm-client')];
    }
  });

  await test('analyze_image валидирует аргументы и не ходит в сеть на мусоре', async () => {
    const executors = require('../tool-executors');

    assert.strictEqual((await executors.analyzeImage('')).success, false);
    assert.ok(/url/i.test((await executors.analyzeImage('')).error));
    assert.strictEqual((await executors.analyzeImage('ftp://x/y.png')).success, false);
    assert.strictEqual((await executors.analyzeImage('не ссылка')).success, false);
  });

  await test('analyze_image отклоняет ссылку на не-изображение с подсказкой про web_analysis', async () => {
    const executors = require('../tool-executors');
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'text/html; charset=utf-8']]),
    });

    try {
      const result = await executors.analyzeImage('https://example.com/page.html');
      assert.strictEqual(result.success, false);
      assert.ok(/web_analysis/.test(result.error), `нет подсказки про web_analysis: ${result.error}`);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test('analyze_image отклоняет изображение больше лимита', async () => {
    const executors = require('../tool-executors');
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      status: 200,
      headers: new Map([
        ['content-type', 'image/png'],
        ['content-length', String(20 * 1024 * 1024)],
      ]),
    });

    try {
      const result = await executors.analyzeImage('https://example.com/huge.png');
      assert.strictEqual(result.success, false);
      assert.ok(/8 МБ/.test(result.error), result.error);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test('planTask и reviewResult не роняют задачу, когда планировщик недоступен', async () => {
    // Подменяем glm-client заглушкой, которая всегда падает
    const glmPath = require.resolve('../lib/glm-client');
    const original = require.cache[glmPath];
    require.cache[glmPath] = {
      id: glmPath,
      filename: glmPath,
      loaded: true,
      exports: {
        chatCompletion: async () => {
          throw new Error('GLM 503: planner down');
        },
        chatJson: async () => {
          throw new Error('GLM 503: planner down');
        },
        trimMessages: (m) => ({ messages: m, trimmed: 0 }),
        modelFor: (role) => role,
      },
    };
    delete require.cache[require.resolve('../ai-agent')];

    try {
      const agent = require('../ai-agent');
      assert.strictEqual(await agent.planTask('t1', 'Задача', 'описание'), null, 'план должен деградировать в null');
      assert.strictEqual(await agent.reviewResult({ taskTitle: 't', finalText: 'x' }), null, 'рецензия должна деградировать в null');

      // План встраивается в промпт, а его отсутствие не ломает промпт
      const withPlan = agent.buildSystemPrompt('t1', 'Задача', 'описание', '', {
        steps: [{ title: 'Собрать цены', tools: ['web_search'], output: 'таблица' }],
        success_criteria: ['таблица с 5 конкурентами'],
        risks: ['цены могли измениться'],
      });
      assert.ok(withPlan.includes('ПЛАН, СОСТАВЛЕННЫЙ ПЛАНИРОВЩИКОМ'));
      assert.ok(withPlan.includes('Собрать цены'));
      assert.ok(withPlan.includes('таблица с 5 конкурентами'));

      const withoutPlan = agent.buildSystemPrompt('t1', 'Задача', 'описание', '', null);
      assert.ok(!withoutPlan.includes('ПЛАН, СОСТАВЛЕННЫЙ ПЛАНИРОВЩИКОМ'));
      assert.ok(withoutPlan.includes('КОНТЕКСТ ЗАДАЧИ'), 'базовые секции промпта не должны теряться');
    } finally {
      if (original) require.cache[glmPath] = original;
      else delete require.cache[glmPath];
      delete require.cache[require.resolve('../ai-agent')];
    }
  });

  await test('analyze_image объявлен в tools и реализован в агенте', () => {
    const names = tools.map((t) => t.function.name);
    assert.ok(names.includes('analyze_image'));
    const { TOOL_HANDLERS } = require('../ai-agent');
    assert.strictEqual(typeof TOOL_HANDLERS.analyze_image, 'function');
  });

  /* ================================================================== */
  console.log('\n— Механический SEO-аудит —');
  /* ================================================================== */

  const http = require('http');
  const seoAuditor = require('../lib/seo-audit');

  const BAD_PAGE = `<!DOCTYPE html>
<html>
<head>
  <title>Очень длинный заголовок страницы, который непременно обрежется в поисковой выдаче и потеряет смысл</title>
  <script type="application/ld+json">{ "broken json"</script>
</head>
<body>
  <h1>Первый заголовок</h1>
  <h1>Второй заголовок</h1>
  <p>Короткий текст.</p>
  <img src="/a.png">
  <img src="/b.png">
  <img src="/c.png" alt="описание">
</body>
</html>`;

  const GOOD_PAGE = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SEO-продвижение сайта в Москве — цена и сроки</title>
  <meta name="description" content="Продвигаем сайты бизнеса в Москве и области. Прозрачная отчётность, договор с KPI, первые результаты за три месяца работы.">
  <link rel="canonical" href="SELF">
  <meta property="og:title" content="SEO-продвижение сайта в Москве">
  <meta property="og:image" content="/og.png">
  <script type="application/ld+json">
  {"@context":"https://schema.org","@graph":[
    {"@type":"LocalBusiness","name":"RocketUP","telephone":"+7 000 000-00-00"},
    {"@type":"Service","name":"SEO-продвижение"}
  ]}
  </script>
</head>
<body>
  <nav><a href="/uslugi/">Услуги</a></nav>
  <h1>SEO-продвижение сайта в Москве</h1>
  <h2>Сколько стоит продвижение</h2>
  <p>${'осмысленный текст '.repeat(120)}</p>
  <h2>Частые вопросы</h2>
  <p>Сколько стоит продвижение сайта? От 60 000 рублей в месяц.</p>
  <a href="/audit/">Заказать аудит</a>
  <a href="/cases/">Кейсы</a>
  <a href="/prices/">Цены</a>
  <img src="/team.jpg" alt="Команда за работой">
</body>
</html>`;

  function startSite(pages) {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        const path = req.url.split('?')[0];
        if (pages[path]) {
          let html = pages[path];
          html = html.replace('SELF', `http://localhost:${server.address().port}${path}`);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          return res.end(html);
        }
        if (path === '/robots.txt') { res.statusCode = 200; return res.end('User-agent: *\nAllow: /'); }
        if (path === '/sitemap.xml') { res.statusCode = 200; return res.end('<?xml version="1.0"?><urlset></urlset>'); }
        if (path === '/llms.txt' && pages.__llms) { res.statusCode = 200; return res.end('# Site\n> about'); }
        res.statusCode = 404;
        res.end('not found');
      });
      server.listen(0, '127.0.0.1', () => resolve({
        url: (path) => `http://127.0.0.1:${server.address().port}${path}`,
        close: () => new Promise((done) => server.close(done)),
      }));
    });
  }

  await test('auditPage: находит типовые проблемы больной страницы', async () => {
    const site = await startSite({ '/bad/': BAD_PAGE });
    try {
      const report = await seoAuditor.auditPage(site.url('/bad/'));

      assert.strictEqual(report.success, true, report.error);
      const checks = report.findings.map((f) => f.check);

      assert.ok(checks.includes('title-long'), `длинный title не найден: ${checks.join(',')}`);
      assert.ok(checks.includes('description-missing'), 'нет нахождения об отсутствии description');
      assert.ok(checks.includes('h1-multiple'), 'два H1 не замечены');
      assert.ok(checks.includes('canonical'), 'отсутствие canonical не замечено');
      assert.ok(checks.includes('viewport-missing'), 'отсутствие viewport не замечено');
      assert.ok(checks.includes('jsonld-broken'), 'битый JSON-LD не замечен');
      assert.ok(checks.includes('images-alt'), 'картинки без alt не замечены');
      assert.ok(checks.includes('thin-content'), 'тонкий контент не замечен');

      // Приоритизация: ошибки идут раньше предупреждений
      assert.strictEqual(report.findings[0].severity, 'error', 'findings не отсортированы по серьёзности');
      // Реальные error на этой странице: нет viewport и битый JSON-LD.
      // Проверка https на loopback-хостах не срабатывает намеренно.
      const errorChecks = report.findings.filter((f) => f.severity === 'error').map((f) => f.check);
      assert.ok(errorChecks.includes('viewport-missing'), `нет viewport-missing: ${errorChecks}`);
      assert.ok(errorChecks.includes('jsonld-broken'), `нет jsonld-broken: ${errorChecks}`);
      assert.ok(!errorChecks.includes('https'), 'https не должен флагаться на локальном хосте');
      assert.ok(report.score.total < 60, `больная страница получила ${report.score.total}/100 — слишком щедро`);
      assert.ok(report.facts.images.withAlt === 1 && report.facts.images.total === 3);
    } finally {
      await site.close();
    }
  });

  await test('auditPage: здоровая страница получает высокий балл без ошибок', async () => {
    const site = await startSite({ '/good/': GOOD_PAGE, __llms: true });
    try {
      const report = await seoAuditor.auditPage(site.url('/good/'));

      assert.strictEqual(report.success, true, report.error);
      assert.strictEqual(report.errors, 0, `ошибки на здоровой странице: ${JSON.stringify(report.findings.filter(f => f.severity === 'error'))}`);
      assert.ok(report.score.total >= 80, `здоровая страница получила ${report.score.total}/100`);

      // Факты сняты верно
      assert.strictEqual(report.facts.headings.h1, 1);
      assert.ok(report.facts.schemaTypes.includes('LocalBusiness'), `schema: ${report.facts.schemaTypes}`);
      assert.ok(report.facts.schemaTypes.includes('Service'), 'тип Service из @graph не распознан');
      assert.strictEqual(report.facts.schemaBroken, false);
      assert.ok(report.facts.wordCount > 200, report.facts.wordCount);
      assert.ok(report.facts.links.internal >= 3);
      assert.ok(report.facts.domainFiles['llms.txt'].ok, 'llms.txt не найден');
      assert.ok(report.facts.domainFiles['sitemap.xml'].ok, 'sitemap не найден');

      // Веса категорий в сумме дают 100
      const weights = Object.values(report.weights).reduce((a, b) => a + b, 0);
      assert.strictEqual(weights, 100, `сумма весов ${weights}`);
      const maxScore = Object.values(report.score.byCategory).reduce((a, r) => a + r.weight, 0);
      assert.strictEqual(maxScore, 100);
    } finally {
      await site.close();
    }
  });

  await test('parseHead/schemaTypes: @graph, массив @type и битый JSON', () => {
    const types = seoAuditor.schemaTypes([
      { '@graph': [{ '@type': 'Organization' }, { '@type': ['Article', 'NewsArticle'] }] },
      { __broken: true },
    ]);
    assert.deepStrictEqual(types.sort(), ['Article', 'NewsArticle', 'Organization']);
  });

  await test('seoAudit: список страниц даёт сжатую сводку, а не полные отчёты', async () => {
    const site = await startSite({ '/a/': GOOD_PAGE, '/b/': BAD_PAGE, __llms: true });
    try {
      const executors = require('../tool-executors');
      const result = await executors.seoAudit(null, [site.url('/a/'), site.url('/b/')], false);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.pageCount, 2);
      assert.ok(result.reports[0].score > result.reports[1].score, 'здоровая страница должна обгонять больную');
      assert.ok(Array.isArray(result.reports[1].topFindings));
      assert.ok(result.reports[1].topFindings.length <= 5, 'сводка не сжата');
      assert.ok(!('findings' in result.reports[0]), 'в сводке не должно быть полного списка findings');
    } finally {
      await site.close();
    }
  });

  await test('seoAudit: валидация аргументов и недоступная страница', async () => {
    const executors = require('../tool-executors');

    const noArgs = await executors.seoAudit();
    assert.strictEqual(noArgs.success, false);
    assert.ok(/url/i.test(noArgs.error));

    const dead = await executors.seoAudit('http://127.0.0.1:1/nope');
    assert.strictEqual(dead.success, false);
    assert.ok(/недоступна|Сервер вернул/.test(dead.error), dead.error);
  });

  await test('seo_audit объявлен в tools и реализован в агенте', () => {
    const names = tools.map((t) => t.function.name);
    assert.ok(names.includes('seo_audit'));
    const { TOOL_HANDLERS } = require('../ai-agent');
    assert.strictEqual(typeof TOOL_HANDLERS.seo_audit, 'function');
  });

  await test('SEO-промпты построены на чек-листах и запрещают выдумывать факты', () => {
    const seo = require('../prompts/seo');
    const checklists = require('../prompts/checklists');

    for (const key of ['seoAudit', 'competitorAnalysis', 'keywords']) {
      assert.ok(seo[key] && seo[key].length > 500, `промпт ${key} пустой`);
      assert.ok(/create_document/.test(seo[key]), `${key} не требует создать документ`);
    }

    assert.ok(seo.seoAudit.includes('seo_audit'), 'промпт аудита не вызывает механический инструмент');
    assert.ok(seo.seoAudit.includes(checklists.SCORING.slice(0, 40)), 'веса категорий не вшиты в промпт');
    assert.ok(/НЕ придумывай|не придумывай/i.test(seo.seoAudit), 'нет запрета выдумывать факты');
    assert.ok(/Google Drive/.test(seo.seoAudit) === false, 'промпт всё ещё ссылается на удалённый Google Drive');
  });

  /* ================================================================== */
  console.log('\n— Семантика без Wordstat —');
  /* ================================================================== */

  const keywords = require('../lib/keywords');

  await test('normalize: регистр, ё, пробелы', () => {
    assert.strictEqual(keywords.normalize('  СЕО   Аудит '), 'сео аудит');
    assert.strictEqual(keywords.normalize('Ёлка ёлка'), 'елка елка');
    assert.strictEqual(keywords.normalize(''), '');
    assert.strictEqual(keywords.normalize(null), '');
  });

  await test('intentOf: маркеры интентов не хватают лишнего', () => {
    assert.strictEqual(keywords.intentOf('купить ноутбук москва'), 'commercial');
    assert.strictEqual(keywords.intentOf('seo аудит цена'), 'commercial');
    assert.strictEqual(keywords.intentOf('сео аудит москва'), 'local');
    assert.strictEqual(keywords.intentOf('как сделать сео аудит'), 'info');
    assert.strictEqual(keywords.intentOf('сео аудит это'), 'info');
    assert.strictEqual(keywords.intentOf('сео аудит или контекст'), 'comparison');
    assert.strictEqual(keywords.intentOf('сео аудит отзывы'), 'reviews');
    assert.strictEqual(keywords.intentOf('личный кабинет вход'), 'navigation');
    // «сайт» больше не навигационный маркер: это основное слово ниши
    assert.strictEqual(keywords.intentOf('сео аудит сайта'), 'general');
  });

  await test('demandLabel: пороги прокси-спроса', () => {
    assert.strictEqual(keywords.demandLabel({ hits: 1, sources: new Set(['yandex']) }), 'low');
    assert.strictEqual(keywords.demandLabel({ hits: 2, sources: new Set(['yandex', 'google']) }), 'medium');
    assert.strictEqual(keywords.demandLabel({ hits: 3, sources: new Set(['yandex', 'google', 'duckduckgo']) }), 'high');
  });

  await test('research: собирает из трёх источников, фильтрует склейки и кластеризует', async () => {
    // Мок-сервер, имитирующий форматы всех трёх источников подсказок
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const part = url.searchParams.get('part') || url.searchParams.get('q') || '';
      res.setHeader('Content-Type', 'application/json');

      if (url.pathname === '/yandex') {
        return res.end(JSON.stringify([
          part + ' сайта', part + ' сайта цена', part + ' моссео', part + ' это',
        ]));
      }
      if (url.pathname === '/google') {
        return res.end(JSON.stringify([part, [part + ' сайта', part + ' онлайн', part + ' моссео']]));
      }
      if (url.pathname === '/ddg') {
        return res.end(JSON.stringify([{ phrase: part + ' сайта' }, { phrase: part + ' отзывы' }]));
      }
      res.statusCode = 404;
      res.end('[]');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    for (const key of ['SUGGEST_YANDEX_URL', 'SUGGEST_GOOGLE_URL', 'SUGGEST_DDG_URL']) process.env[key] = undefined;
    process.env.SUGGEST_YANDEX_URL = base + '/yandex';
    process.env.SUGGEST_GOOGLE_URL = base + '/google';
    process.env.SUGGEST_DDG_URL = base + '/ddg';
    for (const key of Object.keys(require.cache)) {
      if (/lib[\\/](config|keywords)\.js$/.test(key)) delete require.cache[key];
    }
    const freshKeywords = require('../lib/keywords');

    try {
      const result = await freshKeywords.research('сео аудит', { maxQueries: 12 });

      assert.strictEqual(result.success, true, result.error);
      assert.ok(result.collected > 5, `собрано ${result.collected}`);
      assert.ok(result.queriesUsed <= 12, `бюджет превышен: ${result.queriesUsed}`);

      const all = Object.values(result.clusters).flat().map((item) => item.keyword);
      assert.ok(all.includes('сео аудит сайта'), 'ключевой хвост потерян');
      assert.ok(!all.some((k) => /моссео/.test(k)), 'склейка не отфильтрована: ' + all.join(', '));

      assert.ok(result.clusters.commercial, 'коммерческий кластер не выделен');
      assert.ok(result.clusters.commercial.some((i) => /цена/.test(i.keyword)));
      assert.ok(result.clusters.reviews?.some((i) => /отзывы/.test(i.keyword)), 'кластер отзывов не выделен');

      // Спрос помечен как оценка, а не как частотность
      assert.ok(/не частотность Wordstat/.test(result.note), 'нет оговорки про природу метки спроса');
      assert.ok(result.top.length <= 30);
      assert.ok(result.top[0].hits >= result.top[result.top.length - 1].hits, 'top не отсортирован');
    } finally {
      await new Promise((resolve) => server.close(resolve));
      for (const key of ['SUGGEST_YANDEX_URL', 'SUGGEST_GOOGLE_URL', 'SUGGEST_DDG_URL']) delete process.env[key];
      for (const key of Object.keys(require.cache)) {
        if (/lib[\\/](config|keywords)\.js$/.test(key)) delete require.cache[key];
      }
    }
  });

  await test('research: все источники молчат — честная ошибка, а не пустой успех', async () => {
    process.env.SUGGEST_YANDEX_URL = 'http://127.0.0.1:9/nope';
    process.env.SUGGEST_GOOGLE_URL = 'http://127.0.0.1:9/nope';
    process.env.SUGGEST_DDG_URL = 'http://127.0.0.1:9/nope';
    for (const key of Object.keys(require.cache)) {
      if (/lib[\\/](config|keywords)\.js$/.test(key)) delete require.cache[key];
    }
    const freshKeywords = require('../lib/keywords');

    try {
      const result = await freshKeywords.research('сео аудит', { maxQueries: 5, alphabet: false });
      assert.strictEqual(result.success, false);
      assert.ok(/подсказок|источник/i.test(result.error), result.error);
    } finally {
      for (const key of ['SUGGEST_YANDEX_URL', 'SUGGEST_GOOGLE_URL', 'SUGGEST_DDG_URL']) delete process.env[key];
      for (const key of Object.keys(require.cache)) {
        if (/lib[\\/](config|keywords)\.js$/.test(key)) delete require.cache[key];
      }
    }
  });

  await test('keyword_research объявлен, реализован и валидирует seed', async () => {
    const names = tools.map((t) => t.function.name);
    assert.ok(names.includes('keyword_research'));
    const { TOOL_HANDLERS } = require('../ai-agent');
    assert.strictEqual(typeof TOOL_HANDLERS.keyword_research, 'function');

    const executors = require('../tool-executors');
    const empty = await executors.keywordResearch('   ');
    assert.strictEqual(empty.success, false);
    assert.ok(/seed/i.test(empty.error));
  });

  await test('промпт семантики требует keyword_research и запрещает выдумывать частотности', () => {
    const seo = require('../prompts/seo');
    assert.ok(seo.keywords.includes('keyword_research'), 'промпт не использует инструмент');
    assert.ok(/не выдумывай частотности/i.test(seo.keywords), 'нет запрета на выдуманные частотности');
    assert.ok(/Search Console|Метрик/i.test(seo.keywords), 'нет отсылки к источнику реальных показов');
  });

  /* ================================================================== */
  console.log('\n— Семантика: черновики и гейт согласования —');
  /* ================================================================== */

  /** Мини-БД в памяти: поддерживает коллекции, нужные approvals и semantics. */
  function makeFakeDb() {
    const store = new Map();
    const coll = (name) => {
      if (!store.has(name)) store.set(name, []);
      const rows = store.get(name);
      return {
        insertOne: async (doc) => { rows.push(doc); return { insertedId: rows.length }; },
        findOne: async (query) => rows.find((row) => Object.entries(query).every(([k, v]) => row[k] === v)) || null,
        findOneAndUpdate: async (query, update) => {
          const row = rows.find((r2) => Object.entries(query).every(([k, v]) => r2[k] === v));
          if (!row) return null;
          Object.assign(row, update.$set || {});
          return row;
        },
        updateOne: async (query, update) => {
          const row = rows.find((r2) => Object.entries(query).every(([k, v]) => r2[k] === v));
          if (row) Object.assign(row, update.$set || {});
          return { modifiedCount: row ? 1 : 0 };
        },
        find: (query = {}) => ({
          sort: () => ({
            limit: () => ({
              toArray: async () =>
                rows.filter((row) => Object.entries(query).every(([k, v]) => row[k] === v)),
            }),
          }),
        }),
        estimatedDocumentCount: async () => rows.length,
      };
    };
    return { getDb: async () => ({ collection: coll }), coll, store };
  }

  /** Подмена db и keywords заглушками на время прогона. */
  async function withSemanticsStubs(run) {
    const dbPath = require.resolve('../db');
    const kwPath = require.resolve('../lib/keywords');
    const originalDb = require.cache[dbPath];
    const originalKw = require.cache[kwPath];
    const fake = makeFakeDb();

    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { ...fake, COLLECTIONS: {} } };
    require.cache[kwPath] = {
      id: kwPath, filename: kwPath, loaded: true,
      exports: {
        normalize: (v) => String(v || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim(),
        intentOf: (v) => (/цена|купить/.test(v) ? 'commercial' : 'general'),
        research: async (seed) => ({
          success: true,
          seed,
          top: [
            { keyword: `${seed} цена`, demand: 'high', sources: ['yandex'], hits: 5 },
            { keyword: `${seed} отзывы`, demand: 'medium', sources: ['google'], hits: 3 },
          ],
        }),
      },
    };
    for (const key of Object.keys(require.cache)) {
      if (/(lib[\\/])?(semantics|approvals)\.js$/.test(key) || /(^|[\\/])tool-executors\.js$/.test(key)) delete require.cache[key];
    }

    try {
      return await run(fake);
    } finally {
      if (originalDb) require.cache[dbPath] = originalDb; else delete require.cache[dbPath];
      if (originalKw) require.cache[kwPath] = originalKw; else delete require.cache[kwPath];
      for (const key of Object.keys(require.cache)) {
        if (/(lib[\\/])?(semantics|approvals)\.js$/.test(key) || /(^|[\\/])tool-executors\.js$/.test(key)) delete require.cache[key];
      }
    }
  }

  await test('каталог семантики загружается и группы ищутся по id и названию', () => {
    const semantics = require('../lib/semantics');
    const catalog = semantics.loadCatalog();

    assert.ok(catalog.sections.length >= 3, 'секций меньше трёх');
    const all = catalog.sections.reduce((sum, section) => sum + section.groups.length, 0);
    assert.ok(all >= 15, `групп ${all}, ожидалось не меньше 15`);

    const byId = semantics.findGroups(catalog, 'seo-wordpress');
    assert.strictEqual(byId.length, 1);
    assert.ok(byId[0].queries.length > 5, 'у CMS-группы должны быть запросы владельца');
    assert.ok(byId[0].queries.every((q) => q.freqSource === 'owner'), 'частотности владельца помечены неверно');

    const byTitle = semantics.findGroups(catalog, 'Интернет-магазины');
    assert.strictEqual(byTitle.length, 1);
    assert.ok(byTitle[0].subcategories.length >= 10, 'подкатегории интернет-магазинов потеряны');
  });

  await test('buildDraft: частотности владельца неприкосновенны, подсказки без частот', async () => {
    await withSemanticsStubs(async () => {
      const semantics = require('../lib/semantics');
      const draft = await semantics.buildDraft({ groups: 'seo-wordpress', expand: true });

      assert.strictEqual(draft.success, true, draft.error);
      const group = draft.groups[0];
      const owner = group.queries.filter((q) => q.freqSource === 'owner');
      const suggested = group.queries.filter((q) => q.freqSource === 'suggest');

      assert.ok(owner.length > 5, 'запросы владельца потеряны');
      assert.ok(owner.every((q) => q.freq > 0), 'у запросов владельца должна остаться частотность');
      assert.ok(suggested.every((q) => q.freq === null), 'кандидатам из подсказок приписана частотность!');
      assert.ok(suggested.length > 0, 'до-расширение не сработало');

      // Заявка на согласование создана и привязана
      assert.ok(draft.approvalId, 'нет заявки на согласование');
      const approval = await require('../lib/approvals').get(draft.approvalId);
      assert.strictEqual(approval.kind, 'semantics_draft');
      assert.strictEqual(approval.status, 'pending');

      // Статус черновика — ожидание
      assert.strictEqual(await semantics.draftStatus(draft), 'pending');
      const gate = await semantics.assertApproved(draft.id);
      assert.strictEqual(gate.ok, false, 'гейт пропустил неодобренный черновик!');
      assert.ok(/запрещено процессом/i.test(gate.error), gate.error);
    });
  });

  await test('после /approve гейт открывается, правки черновика закрываются', async () => {
    await withSemanticsStubs(async () => {
      const semantics = require('../lib/semantics');
      const approvals = require('../lib/approvals');

      const draft = await semantics.buildDraft({ groups: 'seo-tilda' });
      assert.strictEqual(draft.success, true, draft.error);

      const decision = await approvals.decide(draft.approvalId, 'approved', 'owner-chat');
      assert.strictEqual(decision.ok, true, decision.error);

      assert.strictEqual(await semantics.draftStatus(draft), 'approved');
      const gate = await semantics.assertApproved(draft.id);
      assert.strictEqual(gate.ok, true, `гейт не открылся: ${gate.error}`);

      // Правки одобренного черновика запрещены: изменения только новым черновиком
      const revision = await semantics.reviseDraft(draft.id, { remove: ['tilda seo'] });
      assert.strictEqual(revision.success, false);
      assert.ok(/уже одобрен/i.test(revision.error), revision.error);
    });
  });

  await test('reviseDraft: владелец вычеркивает мусор и добавляет свои запросы до одобрения', async () => {
    await withSemanticsStubs(async () => {
      const semantics = require('../lib/semantics');
      const draft = await semantics.buildDraft({ groups: 'seo-wordpress' });

      const before = draft.groups[0].queries.length;
      const victim = draft.groups[0].queries[draft.groups[0].queries.length - 1].q;

      const revision = await semantics.reviseDraft(draft.id, {
        remove: [victim],
        add: [{ q: 'продвижение сайта на вордпресс цена', freq: 140 }],
      });

      assert.strictEqual(revision.success, true, revision.error);
      const updated = await semantics.getDraft(draft.id);
      const queries = updated.groups[0].queries;

      assert.strictEqual(queries.length, before, 'число запросов изменилось неожиданно');
      assert.ok(!queries.some((q) => q.q === victim), 'вычеркнутый запрос остался');
      const added = queries.find((q) => q.q === 'продвижение сайта на вордпресс цена');
      assert.ok(added, 'добавленный запрос не найден');
      assert.strictEqual(added.freq, 140, 'частотность владельца не сохранилась');
      assert.strictEqual(added.freqSource, 'owner', 'запрос с частотностью должен помечаться как owner');
    });
  });

  await test('исключённые владельцем группы не попадают в работу и объяснимо отказывают', () => {
    const semantics = require('../lib/semantics');
    const catalog = semantics.loadCatalog();

    const excluded = semantics.excludedGroups(catalog);
    assert.ok(excluded.has('seo-modx'), 'seo-modx должна быть в списке исключённых');

    // Без явного выбора исключённая группа не появляется
    const all = semantics.findGroups(catalog);
    assert.ok(!all.some((group) => group.id === 'seo-modx'), 'исключённая группа попала в общий список');

    // Явный запрос исключённой группы распознаётся для объяснимого отказа
    const match = semantics.findExcludedMatch(catalog, 'seo-modx');
    assert.ok(match, 'не распознан явный запрос исключённой группы');
    assert.ok(/владел/i.test(match.reason), 'в причине нет ссылки на решение владельца');
  });

  await test('semantics_draft и semantics_status объявлены и реализованы', () => {
    const names = tools.map((t) => t.function.name);
    assert.ok(names.includes('semantics_draft'));
    assert.ok(names.includes('semantics_status'));
    const { TOOL_HANDLERS } = require('../ai-agent');
    assert.strictEqual(typeof TOOL_HANDLERS.semantics_draft, 'function');
    assert.strictEqual(typeof TOOL_HANDLERS.semantics_status, 'function');
  });

  await test('промт требует согласования семантики до создания страниц', () => {
    const { buildSystemPrompt } = require('../ai-agent');
    const prompt = buildSystemPrompt('t', 'задача', 'описание', '');
    assert.ok(/СОГЛАСОВАНИЕ/i.test(prompt) || /согласование/i.test(prompt));
    assert.ok(/approved/.test(prompt), 'нет требования статуса approved');
    assert.ok(/Частотности владельца не пересчитывай/i.test(prompt), 'нет защиты частотностей владельца');
  });

  /* ================================================================== */
  console.log('\n— Генератор страниц и гейт одобренной семантики —');
  /* ================================================================== */

  const pageBuilder = require('../lib/page-builder');

  await test('fitToLimit: режет по границе слова и не превышает лимит', () => {
    assert.strictEqual(pageBuilder.fitToLimit('короткий', 60).trimmed, false);

    const long = 'Продвижение сайта на wordpress с гарантией результата и прозрачной отчётностью каждый месяц';
    const fitted = pageBuilder.fitToLimit(long, 60);
    assert.strictEqual(fitted.trimmed, true);
    assert.ok(fitted.value.length <= 60, `длина ${fitted.value.length}`);
    assert.ok(fitted.value.endsWith('…'), 'нет отметки об усечении');
    assert.ok(!fitted.value.slice(0, -1).endsWith(' '), 'обрыв на пробеле');
  });

  await test('markdownToHtml: H1 модели становится H2, списки и абзацы корректны', () => {
    const html = pageBuilder.markdownToHtml(
      '# Главный заголовок\n\nАбзац первый.\nПродолжение абзаца.\n\n## Раздел\n\n- пункт один\n- пункт два\n\nИтоговый абзац.'
    );

    assert.ok(!/<h1>/.test(html), 'H1 зарезервирован за страницей, модель не должна его ставить');
    assert.ok(html.includes('<h2>Главный заголовок</h2>'), 'модельный H1 не понижен до H2');
    assert.ok(html.includes('<h3>Раздел</h3>'), 'модельный H2 не понижен до H3');
    assert.ok(html.includes('<ul>'), 'нет списка');
    assert.ok(html.includes('<li>пункт один</li>'));
    assert.ok(html.includes('<p>Абзац первый. Продолжение абзаца.</p>'), 'строки абзаца не склеены');
    assert.ok(html.includes('<p>Итоговый абзац.</p>'));
  });

  await test('buildAlias: транслитерация и ограничение длины', () => {
    assert.strictEqual(pageBuilder.buildAlias('Продвижение сайта на WordPress', ''), 'prodvizhenie-sayta-na-wordpress');
    assert.ok(pageBuilder.buildAlias('ы'.repeat(200), '').length <= 70);
    assert.strictEqual(pageBuilder.buildAlias('', ''), 'page');
  });

  await test('buildPageSpec: код дожимает метатеги модели до лимитов и собирает FAQ', async () => {
    const glmPath = require.resolve('../lib/glm-client');
    const original = require.cache[glmPath];
    require.cache[glmPath] = {
      id: glmPath, filename: glmPath, loaded: true,
      exports: {
        chatJson: async () => ({
          pagetitle: 'Очень длинный title про продвижение сайта на вордпресс, который совершенно точно не влезет в шестьдесят символов выдачи',
          description: 'Д'.repeat(240),
          longtitle: 'Развёрнутый заголовок страницы про продвижение',
          introtext: 'Анонс страницы',
          content_markdown: '## Состав работ\n\n- аудит\n- семантика\n\nАбзац с конкретикой.',
          faq: [{ q: 'Сколько стоит продвижение wordpress?', a: 'От 60 000 рублей в месяц.' }],
          schema_hint: 'Service, FAQPage',
        }),
        chatCompletion: async () => ({ message: { content: '{}' } }),
      },
    };
    delete require.cache[require.resolve('../lib/page-builder')];

    try {
      const freshBuilder = require('../lib/page-builder');
      const spec = await freshBuilder.buildPageSpec({ cluster: 'продвижение сайта на wordpress', kind: 'promo' });

      assert.strictEqual(spec.success, true, spec.error);
      assert.ok(spec.pagetitle.length <= 60, `title ${spec.pagetitle.length}`);
      assert.ok(spec.description.length <= 160, `description ${spec.description.length}`);
      assert.ok(spec.warnings.some((w) => /title укорочен/.test(w)), 'нет предупреждения об усечении title');
      assert.ok(spec.content.includes('Частые вопросы'), 'FAQ-блок не вшит в тело');
      assert.ok(spec.content.includes('Сколько стоит продвижение wordpress?'), 'вопрос FAQ потерян');
      assert.ok(spec.content.includes('<h2>'), 'нет H2 в теле');
      assert.strictEqual(spec.published, 0, 'страница не должна создаваться опубликованной');
      assert.strictEqual(spec.template, 4, 'promo должен идти в шаблон «SEO продвижение»');
      assert.ok(/prodvizhenie/.test(spec.alias), `alias: ${spec.alias}`);
    } finally {
      if (original) require.cache[glmPath] = original;
      else delete require.cache[glmPath];
      delete require.cache[require.resolve('../lib/page-builder')];
    }
  });

  await test('site_page_create: гейт отсекает pending, чужой кластер и пропускает approved', async () => {
    await withSemanticsStubs(async () => {
      // Модель подменяем: тест проверяет гейт и маршрутизацию, а не генерацию текста
      const glmPath = require.resolve('../lib/glm-client');
      const originalGlm = require.cache[glmPath];
      require.cache[glmPath] = {
        id: glmPath, filename: glmPath, loaded: true,
        exports: {
          chatJson: async () => ({
            pagetitle: 'Продвижение сайта на wordpress',
            description: 'Описание страницы продвижения.',
            content_markdown: '## Состав работ\n\n- аудит\n',
            faq: [{ q: 'Сколько стоит?', a: 'От 60 000 ₽.' }],
          }),
          chatCompletion: async () => ({ message: { content: '{}' } }),
        },
      };
      for (const key of Object.keys(require.cache)) {
        if (/(lib[\\/])?page-builder\.js$/.test(key) || /(^|[\\/])tool-executors\.js$/.test(key)) delete require.cache[key];
      }

      const executors = require('../tool-executors');

      const draft = await require('../lib/semantics').buildDraft({ groups: 'seo-wordpress' });
      const cluster = draft.groups[0].queries[0].q;

      // 1. pending — отказ до всякого обращения к MODX
      const gated = await executors.sitePageCreate({ draftId: draft.id, cluster });
      assert.strictEqual(gated.success, false);
      assert.strictEqual(gated.gated, true, 'гейт не пометил отказ');
      assert.ok(/не одобрена/i.test(gated.error), gated.error);

      // 2. approved, но кластер вне черновика — отказ
      const approvals = require('../lib/approvals');
      await approvals.decide(draft.approvalId, 'approved', 'owner');

      const foreign = await executors.sitePageCreate({ draftId: draft.id, cluster: 'казино вулкан купить' });
      assert.strictEqual(foreign.success, false);
      assert.ok(/нет в одобренном черновике/i.test(foreign.error), foreign.error);

      // 3. approved + кластер из черновика: гейт пройден, упираемся в ненастроенный MODX
      const passed = await executors.sitePageCreate({ draftId: draft.id, cluster });
      assert.notStrictEqual(passed.gated, true, 'гейт не должен мешать одобренному черновику');
      assert.strictEqual(passed.success, false, 'без настроенного MODX создание невозможно');
      assert.ok(/MODX_PUBLISHER_URL/i.test(passed.error), passed.error);

      if (originalGlm) require.cache[glmPath] = originalGlm;
      else delete require.cache[glmPath];
      for (const key of Object.keys(require.cache)) {
        if (/(lib[\\/])?page-builder\.js$/.test(key) || /(^|[\\/])tool-executors\.js$/.test(key)) delete require.cache[key];
      }
    });
  });

  await test('site_page_create объявлен и требует draftId и cluster', () => {
    const tool = tools.find((t) => t.function.name === 'site_page_create');
    assert.ok(tool, 'инструмент не объявлен');
    assert.deepStrictEqual(tool.function.parameters.required, ['draftId', 'cluster']);
    assert.ok(tool.function.description.includes('published=0'), 'в описании нет гарантии черновика');
  });

  /* ================================================================== */

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Всего: ${results.length} | ✅ ${results.length - failed.length} | ❌ ${failed.length}`);
  if (failed.length > 0) {
    console.log('\nПровалены:');
    for (const f of failed) console.log(`  • ${f.name}\n    ${String(f.error.message).split('\n')[0]}`);
  }
  console.log('='.repeat(60));

  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('💥 Тесты упали:', error);
  process.exit(1);
});
