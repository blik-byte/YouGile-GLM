#!/usr/bin/env node
/**
 * scripts/test-kwork-mail.js
 * Тесты разбора письма Kwork: HTML → список проектов.
 * Разметка в фикстуре повторяет реальное письмо от news@kwork.ru.
 */

'use strict';

const assert = require('assert');
const mail = require('../lib/kwork-mail');
const filter = require('../lib/kwork-filter');

const row = ({ id, title, category, buyer, price }) => `
<tr>
  <td style="padding: 10px 15px;">
    <div style="font-size: 14px;">
      <a href="https://kwork.ru/new_offer?project=${id}" style="color:#457edb;">${title}</a>
    </div>
    <div style="font-size: 12px;margin-top: 5px;">${category}</div>
  </td>
  <td style="padding: 10px 15px;">
    <a href="https://kwork.ru/user/test"><span>${buyer}</span></a>
    <div style="margin-top: 5px"><div style="font-size: 13px;">2 проекта на бирже</div></div>
  </td>
  <td style="padding: 10px 15px;text-align: center;white-space: nowrap;color: #090;font-weight: 700;">
    ${price}
  </td>
</tr>`;

const html = `
<table style="width: 100%;">
  <tr>
    <td>Название</td><td>Покупатель</td><td>Цена</td>
  </tr>
  ${row({
    id: '3194458',
    title: 'SEO-разведка для тревел-блога',
    category: 'SEO и трафик > Семантическое ядро > > С нуля',
    buyer: 'ITINERO',
    price: '30 000 Р',
  })}
  ${row({
    id: '3198851',
    title: 'Продвижение сайта по России',
    category: 'SEO и трафик > Продвижение сайта в топ',
    buyer: 'starline13',
    price: '2 000 Р',
  })}
  ${row({
    id: '3198672',
    title: 'Закупка ссылок для сайта интернет-магазина',
    category: 'SEO и трафик > Ссылки > > Статейные и крауд',
    buyer: '4048899',
    price: '5 000 Р',
  })}
</table>`;

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('письмо Kwork распознаётся по отправителю и теме', () => {
  assert.strictEqual(
    mail.isKworkProjectsMail({ from: '"Kwork" <news@kwork.ru>', subject: 'Новые проекты на бирже Kwork', html }),
    true
  );
  assert.strictEqual(
    mail.isKworkProjectsMail({ from: 'someone@example.com', subject: 'Привет', html: '<p>текст</p>' }),
    false
  );
});

test('из письма извлекаются название, ссылка, категория, покупатель и цена', () => {
  const projects = mail.parseProjects(html);
  assert.strictEqual(projects.length, 3);

  const first = projects[0];
  assert.strictEqual(first.id, '3194458');
  assert.strictEqual(first.title, 'SEO-разведка для тревел-блога');
  assert.ok(first.url.includes('new_offer?project=3194458'));
  assert.strictEqual(first.projectUrl, 'https://kwork.ru/projects/3194458');
  assert.strictEqual(first.category, 'SEO и трафик > Семантическое ядро > > С нуля');
  assert.strictEqual(first.buyer, 'ITINERO');
  assert.strictEqual(first.price, '30 000 Р');
});

test('цена и покупатель не склеиваются в мусор', () => {
  for (const project of mail.parseProjects(html)) {
    assert.ok(project.price.length <= 12, `странная цена: ${project.price}`);
    assert.ok(!project.buyer.includes('проекта на бирже'), `мусор в покупателе: ${project.buyer}`);
  }
});

test('фильтр работает по названию вместе с категорией', () => {
  const rules = filter.loadFilters();
  const projects = mail.parseProjects(html);

  const verdicts = projects.map((project) => filter.classify(`${project.title} ${project.category}`, rules).verdict);

  assert.deepStrictEqual(verdicts, ['accept', 'reject', 'accept']);
});

test('цена очищается от подвала письма', () => {
  const single = `<tr><td><a href="https://kwork.ru/new_offer?project=1">SEO аудит</a></td><td><span>Buyer</span></td><td>5 000 Р Ваши настройки на бирже</td></tr>`;
  const [project] = mail.parseProjects(single);
  assert.strictEqual(project.price, '5 000 Р');
});

test('зарубежный сайт отклоняется', () => {
  const rules = filter.loadFilters();
  const result = filter.classify('SEO-оптимизация и линкбилдинг зарубежного инт-магазина', rules);
  assert.strictEqual(result.verdict, 'reject');
  assert.ok(result.reason.includes('зарубеж'));
});

test('письмо без проектов не ломает разбор', () => {
  const result = mail.parseKworkEmail({ from: 'news@kwork.ru', subject: 'Новые проекты на бирже Kwork', html: '<p>пусто</p>' });
  assert.strictEqual(result.isKwork, true);
  assert.deepStrictEqual(result.projects, []);
});

test('чужое письмо отбрасывается целиком', () => {
  const result = mail.parseKworkEmail({ from: 'boss@example.com', subject: 'Отчёт', html });
  assert.strictEqual(result.isKwork, false);
  assert.deepStrictEqual(result.projects, []);
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✅ ${name}`);
      passed += 1;
    } catch (error) {
      console.error(`  ❌ ${name}`);
      console.error(`     ${error.message}`);
      process.exitCode = 1;
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`kwork-mail: всего ${tests.length} | ✅ ${passed} | ❌ ${tests.length - passed}`);
  console.log('='.repeat(60));

  if (process.exitCode) process.exit(process.exitCode);
})();
