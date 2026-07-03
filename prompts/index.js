const seoPrompts = require('./seo');
const humanPrompts = require('./human-tasks');
const researchPrompts = require('./research');
const documentsPrompts = require('./documents');

const TASK_PATTERNS = {
  'seo-audit': {
    keywords: ['аудит', 'проверка сайта', 'seo-аудит', 'анализ сайта'],
    prompt: seoPrompts.seoAudit
  },
  'competitor': {
    keywords: ['конкурент', 'анализ конкурентов', 'сравнить'],
    prompt: seoPrompts.competitorAnalysis
  },
  'keywords': {
    keywords: ['ключевые слова', 'семантика', 'семантическое ядро', 'ключи'],
    prompt: seoPrompts.keywords
  },
  'instructions': {
    keywords: ['инструкция', 'как сделать', 'пошагово', 'руководство'],
    prompt: humanPrompts.instructions
  },
  'planning': {
    keywords: ['план', 'планирование', 'расписание', 'график'],
    prompt: humanPrompts.planning
  },
  'research': {
    keywords: ['исследование', 'изучить', 'найди информацию'],
    prompt: researchPrompts.general
  },
  'news': {
    keywords: ['новости', 'тренды', 'что нового'],
    prompt: researchPrompts.news
  }
};

function getPromptForTask(taskTitle, taskDescription) {
  const text = `${taskTitle} ${taskDescription}`.toLowerCase();
  
  let bestMatch = 'research';
  let maxScore = 0;
  
  for (const [type, config] of Object.entries(TASK_PATTERNS)) {
    let score = 0;
    for (const keyword of config.keywords) {
      if (text.includes(keyword.toLowerCase())) {
        score += keyword.length;
      }
    }
    
    if (score > maxScore) {
      maxScore = score;
      bestMatch = type;
    }
  }
  
  console.log(`🎯 Тип задачи: ${bestMatch}`);
  return TASK_PATTERNS[bestMatch].prompt;
}

module.exports = { getPromptForTask };