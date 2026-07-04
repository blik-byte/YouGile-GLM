// document-generator.js
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

// ✅ Создание DOCX
async function createDocx(filename, title, content) {
  console.log(`📄 Создаю DOCX: ${filename}...`);
  
  const paragraphs = content.split('\n').map(line => {
    if (line.startsWith('# ')) {
      return new Paragraph({
        text: line.substring(2),
        heading: HeadingLevel.HEADING_1
      });
    } else if (line.startsWith('## ')) {
      return new Paragraph({
        text: line.substring(3),
        heading: HeadingLevel.HEADING_2
      });
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      return new Paragraph({
        children: [new TextRun(line.substring(2))],
        bullet: { level: 0 }
      });
    } else if (line.trim()) {
      return new Paragraph({
        children: [new TextRun(line)]
      });
    }
    return null;
  }).filter(p => p !== null);
  
  const doc = new Document({
    sections: [{
      properties: {},
      children: [
        new Paragraph({
          text: title,
          heading: HeadingLevel.TITLE
        }),
        ...paragraphs
      ]
    }]
  });
  
  const filePath = path.join('/tmp', `${filename}.docx`);
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(filePath, buffer);
  
  console.log(`✅ DOCX создан: ${filePath}`);
  return filePath;
}

// ✅ Создание XLSX
async function createXlsx(filename, tables) {
  console.log(`📊 Создаю XLSX: ${filename}...`);
  
  const workbook = new ExcelJS.Workbook();
  
  for (const table of tables) {
    const sheet = workbook.addWorksheet(table.name || 'Данные');
    
    if (table.headers && table.headers.length > 0) {
      sheet.addRow(table.headers);
      sheet.getRow(1).font = { bold: true };
      sheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE0E0E0' }
      };
    }
    
    if (table.rows && table.rows.length > 0) {
      for (const row of table.rows) {
        sheet.addRow(row);
      }
    }
    
    sheet.columns.forEach(column => {
      column.width = 20;
    });
  }
  
  const filePath = path.join('/tmp', `${filename}.xlsx`);
  await workbook.xlsx.writeFile(filePath);
  
  console.log(`✅ XLSX создан: ${filePath}`);
  return filePath;
}

// ✅ Создание TXT
async function createTxt(filename, content) {
  console.log(`📝 Создаю TXT: ${filename}...`);
  
  const filePath = path.join('/tmp', `${filename}.txt`);
  fs.writeFileSync(filePath, content);
  
  console.log(`✅ TXT создан: ${filePath}`);
  return filePath;
}

module.exports = {
  createDocx,
  createXlsx,
  createTxt
};
