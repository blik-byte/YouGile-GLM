// lib/steward-compact.js
// Короткое описание проекта → полный план для applyPlan.
//
// Нужен в двух местах: в консольном steward-new.js и в HTTP-эндпоинте,
// через который агент без прав на команды создаёт структуру запросом.

'use strict';

const DEFAULT_COLUMNS = ['Входящие', 'В работе', 'На проверку', 'Готово'];

/** Превращает короткое описание в полный план. */
function expandCompact(input) {
  if (!input || !input.project || !input.project.title) {
    throw new Error('Нужен объект project с полем title');
  }

  const boardTitle = (input.board && input.board.title) || 'Задачи';
  const columns = (input.board && input.board.columns) || DEFAULT_COLUMNS;
  const tasks = Array.isArray(input.tasks) ? input.tasks : [];

  const prepared = tasks.map((task, index) => {
    if (!task || !task.title) throw new Error(`Задача #${index + 1}: нужно поле title`);
    return {
      code: task.code || `T-${index + 1}`,
      column: task.column || columns[0],
      title: task.title,
      description: task.description || '',
      checklist: task.checklist || [],
      assignees: task.assignees || [],
    };
  });

  const usedColumns = [...columns];
  for (const task of prepared) {
    if (!usedColumns.includes(task.column)) usedColumns.push(task.column);
  }

  return {
    project: { title: input.project.title, description: input.project.description || '' },
    boards: [
      {
        title: boardTitle,
        columns: usedColumns.map((title) => ({ title })),
        tasks: prepared,
      },
    ],
  };
}

module.exports = { expandCompact, DEFAULT_COLUMNS };
