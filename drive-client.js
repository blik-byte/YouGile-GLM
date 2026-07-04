// drive-client.js
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

function getAuth() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_DRIVE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_DRIVE_PRIVATE_KEY.replace(/\\n/g, '\n')
    },
    scopes: SCOPES
  });
  return auth;
}

async function uploadFile(filePath, filename) {
  console.log(`📤 Загружаю файл ${filename} в Google Drive...`);
  
  try {
    const auth = getAuth();
    const drive = google.drive({ version: 'v3', auth });
    
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes = {
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.txt': 'text/plain',
      '.pdf': 'application/pdf',
      '.csv': 'text/csv'
    };
    const mimeType = mimeTypes[ext] || 'application/octet-stream';
    
    const fileMetadata = {
      name: filename,
      parents: [process.env.GOOGLE_DRIVE_FOLDER_ID]
    };
    
    const media = {
      mimeType: mimeType,
      body: fs.createReadStream(filePath)
    };
    
    const file = await drive.files.create({
      requestBody: fileMetadata,
      media: media,
      fields: 'id,name,webViewLink,webContentLink'
    });
    
    console.log(`✅ Файл загружен: ${file.data.name}, ID: ${file.data.id}`);
    
    // Делаем файл доступным по ссылке для всех
    await drive.permissions.create({
      fileId: file.data.id,
      requestBody: {
        role: 'reader',
        type: 'anyone'
      }
    });
    
    return {
      success: true,
      fileId: file.data.id,
      link: file.data.webViewLink,
      downloadLink: file.data.webContentLink,
      filename: file.data.name
    };
    
  } catch (error) {
    console.error(`❌ Ошибка загрузки файла: ${error.message}`);
    return { success: false, error: error.message };
  }
}

module.exports = { uploadFile };
