// drive-client.js
// Загрузка файлов в Google Drive через Service Account.
//
// ⚠️ Известная проблема: Service Account не имеет собственной квоты хранилища,
// поэтому загрузка падает. Модуль оставлен как запасной путь; основной —
// pcloud-client.js. См. README, раздел «Облачное хранилище».
//
// Исправлено:
//  M20 — process.env.GOOGLE_DRIVE_PRIVATE_KEY.replace() бросал TypeError,
//        если переменная не задана. Теперь проверка явная и понятная.
//  M21 — parents: [undefined] при незаполненном GOOGLE_DRIVE_FOLDER_ID
//        давал неинформативную ошибку API.

const fs = require('fs');
const path = require('path');
const { config } = require('./lib/config');

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

const MIME_TYPES = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.txt': 'text/plain',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
};

function isConfigured() {
  return Boolean(
    process.env.GOOGLE_DRIVE_CLIENT_EMAIL && process.env.GOOGLE_DRIVE_PRIVATE_KEY
  );
}

function getAuth() {
  const { google } = require('googleapis');

  const clientEmail = process.env.GOOGLE_DRIVE_CLIENT_EMAIL;
  const privateKeyRaw = process.env.GOOGLE_DRIVE_PRIVATE_KEY;

  if (!clientEmail || !privateKeyRaw) {
    throw new Error(
      'Google Drive не настроен: нужны GOOGLE_DRIVE_CLIENT_EMAIL и GOOGLE_DRIVE_PRIVATE_KEY'
    );
  }

  return new google.auth.GoogleAuth({
    credentials: {
      client_email: clientEmail,
      // В переменных окружения переводы строк хранятся как литерал "\n"
      private_key: privateKeyRaw.replace(/\\n/g, '\n'),
    },
    scopes: SCOPES,
  });
}

async function uploadFile(filePath, filename) {
  console.log(`📤 Загружаю ${filename} в Google Drive...`);

  if (!isConfigured()) {
    return {
      success: false,
      error: 'Google Drive не настроен (нет GOOGLE_DRIVE_CLIENT_EMAIL / GOOGLE_DRIVE_PRIVATE_KEY)',
    };
  }

  if (!fs.existsSync(filePath)) {
    return { success: false, error: `Файл не найден: ${filePath}` };
  }

  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!folderId) {
    return { success: false, error: 'GOOGLE_DRIVE_FOLDER_ID не задан' };
  }

  try {
    const { google } = require('googleapis');
    const drive = google.drive({ version: 'v3', auth: getAuth() });

    const extension = path.extname(filename).toLowerCase();

    const file = await drive.files.create({
      requestBody: {
        name: path.basename(filename),
        parents: [folderId],
      },
      media: {
        mimeType: MIME_TYPES[extension] || 'application/octet-stream',
        body: fs.createReadStream(filePath),
      },
      fields: 'id,name,webViewLink,webContentLink',
    });

    console.log(`✅ Файл загружен: ${file.data.name} (ID ${file.data.id})`);

    await drive.permissions.create({
      fileId: file.data.id,
      requestBody: { role: 'reader', type: 'anyone' },
    });

    return {
      success: true,
      provider: 'gdrive',
      fileId: file.data.id,
      link: file.data.webViewLink,
      downloadLink: file.data.webContentLink,
      filename: file.data.name,
    };
  } catch (error) {
    console.error(`❌ Ошибка загрузки в Google Drive: ${error.message}`);
    return { success: false, provider: 'gdrive', error: error.message };
  }
}

module.exports = { uploadFile, isConfigured };
