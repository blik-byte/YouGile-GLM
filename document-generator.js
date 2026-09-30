// document-generator.js
// Создание файлов DOCX / XLSX / TXT во временной папке.
//
// Исправлено:
//  M9 — имя файла санитизируется. Прежний код делал path.join('/tmp', `${filename}.docx`)
//       с именем, пришедшим от модели: при filename = "../../etc/x" файл уезжал
//       за пределы /tmp, а одинаковые имена перезаписывали чужие документы.
//  M5 — путь возвращается вместе с гарантией, что вызывающий код удалит файл
//       даже при ошибке загрузки (см. tool-executors.createDocument).

const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
const ExcelJS = require('exceljs');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');

const { sanitizeFilename } = require('./lib/text');

const TMP_DIR = process.env.TMP_DIR || os.tmpdir();

/**
 * Уникальный безопасный путь во временной папке.
 * Метка времени + случайный суффикс исключают перезапись параллельных документов.
 */
function buildTempPath(filename, extension) {
  const safe = sanitizeFilename(filename, 'document');
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return path.join(TMP_DIR, `${safe}-${unique}.${extension}`);
}

function markdownToParagraphs(content) {
  const lines = String(content || '').split(/\r?\n/);
  const paragraphs = [];

  for (const line of lines) {
    if (line.startsWith('### ')) {
      paragraphs.push(new Paragraph({ text: line.slice(4), heading: HeadingLevel.HEADING_3 }));
    } else if (line.startsWith('## ')) {
      paragraphs.push(new Paragraph({ text: line.slice(3), heading: HeadingLevel.HEADING_2 }));
    } else if (line.startsWith('# ')) {
      paragraphs.push(new Paragraph({ text: line.slice(2), heading: HeadingLevel.HEADING_1 }));
    } else if (/^\s*[-*]\s+/.test(line)) {
      paragraphs.push(
        new Paragraph({
          children: [new TextRun(line.replace(/^\s*[-*]\s+/, ''))],
          bullet: { level: 0 },
        })
      );
    } else if (/^\s*\d+[.)]\s+/.test(line)) {
      paragraphs.push(new Paragraph({ children: [new TextRun(line.trim())] }));
    } else if (line.trim()) {
      paragraphs.push(new Paragraph({ children: [new TextRun(line)] }));
    }
  }

  return paragraphs;
}

async function createDocx(filename, title, content) {
  console.log(`📄 Создаю DOCX: ${filename}`);

  const doc = new Document({
    sections: [
      {
        properties: {},
        children: [
          new Paragraph({ text: String(title || filename || 'Документ'), heading: HeadingLevel.TITLE }),
          ...markdownToParagraphs(content),
        ],
      },
    ],
  });

  const filePath = buildTempPath(filename, 'docx');
  const buffer = await Packer.toBuffer(doc);
  await fs.writeFile(filePath, buffer);

  console.log(`✅ DOCX создан: ${filePath}`);
  return filePath;
}

async function createXlsx(filename, tables) {
  console.log(`📊 Создаю XLSX: ${filename}`);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'YouGile AI Agent';
  workbook.created = new Date();

  const list = Array.isArray(tables) && tables.length > 0 ? tables : [{ name: 'Данные', headers: [], rows: [] }];
  const usedNames = new Set();

  for (const table of list) {
    // Имена листов в Excel ограничены 31 символом и не должны повторяться
    let sheetName = String(table?.name || 'Данные').slice(0, 31).replace(/[\\/*?:[\]]/g, ' ');
    let suffix = 2;
    while (usedNames.has(sheetName)) sheetName = `${sheetName.slice(0, 28)}_${suffix++}`;
    usedNames.add(sheetName);

    const sheet = workbook.addWorksheet(sheetName);

    const headers = Array.isArray(table?.headers) ? table.headers : [];
    if (headers.length > 0) {
      sheet.addRow(headers);
      const headerRow = sheet.getRow(1);
      headerRow.font = { bold: true };
      headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E0E0' } };
      headerRow.commit();
    }

    const rows = Array.isArray(table?.rows) ? table.rows : [];
    for (const row of rows) {
      sheet.addRow(Array.isArray(row) ? row : [row]);
    }

    // Ширины колонок — по фактическому содержимому, а не фиксированные 20
    const columnCount = Math.max(headers.length, ...rows.map((r) => (Array.isArray(r) ? r.length : 1)), 1);
    for (let i = 1; i <= columnCount; i++) {
      let width = String(headers[i - 1] || '').length;
      for (const row of rows.slice(0, 50)) {
        width = Math.max(width, String(Array.isArray(row) ? row[i - 1] : row || '').length);
      }
      sheet.getColumn(i).width = Math.min(Math.max(width + 2, 10), 60);
    }
  }

  const filePath = buildTempPath(filename, 'xlsx');
  await workbook.xlsx.writeFile(filePath);

  console.log(`✅ XLSX создан: ${filePath}`);
  return filePath;
}

async function createTxt(filename, content) {
  console.log(`📝 Создаю TXT: ${filename}`);

  const filePath = buildTempPath(filename, 'txt');
  await fs.writeFile(filePath, String(content || ''), 'utf8');

  console.log(`✅ TXT создан: ${filePath}`);
  return filePath;
}

/** Удаление временного файла; не бросает исключение, если файла уже нет. */
async function removeTemp(filePath) {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`⚠️ Не удалось удалить временный файл: ${error.message}`);
  }
}

module.exports = { createDocx, createXlsx, createTxt, removeTemp, buildTempPath, TMP_DIR };
