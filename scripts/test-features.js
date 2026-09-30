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
