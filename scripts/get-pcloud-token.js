#!/usr/bin/env node
// scripts/get-pcloud-token.js
// Одноразовая утилита: получает PCLOUD_AUTH_TOKEN по логину и паролю.
//
// Зачем: pCloud больше не даёт создавать OAuth-приложения новым разработчикам,
// поэтому токен получается напрямую через метод userinfo?getauth=1.
//
// Запуск:
//   node scripts/get-pcloud-token.js
//     (логины возьмутся из .env: PCLOUD_EMAIL, PCLOUD_PASSWORD, PCLOUD_REGION)
//
//   node scripts/get-pcloud-token.js --email you@mail.com --password "secret" --region eu
//
// Результат — токен, который нужно положить в переменную окружения
// PCLOUD_AUTH_TOKEN на Render. Сам пароль после этого нигде не хранится.
//
// ⚠️ Если на аккаунте включена двухфакторная авторизация, парольная
//    аутентификация через API может не сработать — тогда токен придётся
//    запрашивать у поддержки pCloud.

require('dotenv').config();

const HOSTS = {
  eu: 'https://eapi.pcloud.com',
  us: 'https://api.pcloud.com',
};

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const email = args.email || process.env.PCLOUD_EMAIL;
  const password = args.password || process.env.PCLOUD_PASSWORD;
  const region = String(args.region || process.env.PCLOUD_REGION || 'eu').toLowerCase();
  const host = HOSTS[region] || HOSTS.eu;

  if (!email || !password) {
    console.error('❌ Нужны логин и пароль.');
    console.error('   Вариант 1: добавьте в .env строки PCLOUD_EMAIL и PCLOUD_PASSWORD');
    console.error('   Вариант 2: node scripts/get-pcloud-token.js --email you@mail.com --password "secret"');
    process.exit(1);
  }

  console.log(`🔑 Запрашиваю токен на ${host} для ${email}...\n`);

  const url = new URL(`${host}/userinfo`);
  url.searchParams.set('getauth', '1');
  url.searchParams.set('username', email);
  url.searchParams.set('password', password);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(url.toString(), { signal: controller.signal });
    const data = await response.json();

    if (data.result !== 0) {
      console.error(`❌ pCloud ответил ошибкой ${data.result}: ${data.error || 'неизвестная ошибка'}`);
      console.error('\nВозможные причины:');
      console.error('  • неверный email или пароль');
      console.error('  • выбран не тот регион (eu / us) — проверьте в настройках аккаунта pCloud');
      console.error('  • аккаунт не подтверждён по email');
      console.error('  • включена двухфакторная авторизация — парольная аутентификация через API блокируется');
      process.exit(2);
    }

    console.log('✅ Токен получен!\n');
    console.log('Скопируйте значение в переменную окружения PCLOUD_AUTH_TOKEN на Render:\n');
    console.log(`PCLOUD_AUTH_TOKEN=${data.auth}\n`);
    console.log('Дополнительно полезно задать:');
    console.log(`PCLOUD_REGION=${region}`);
    if (data.userid) console.log(`PCLOUD_USER_ID=${data.userid}`);
    console.log('\n⚠️ Пароль в переменные окружения класть НЕ нужно — достаточно токена.');
    console.log('⚠️ Токен даёт полный доступ к диску. Не публикуйте его и не коммитьте в git.');
  } catch (error) {
    console.error(`❌ Запрос не удался: ${error.message}`);
    process.exit(3);
  } finally {
    clearTimeout(timer);
  }
}

main();
