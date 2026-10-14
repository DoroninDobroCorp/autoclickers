// child process of tasks-manager-execution.test.js: appends N history entries through the real manager
const { TasksManager } = require('../../tasks/tasks-manager.js');
const [file, label, count] = process.argv.slice(2);
console.log = () => {}; console.warn = () => {};
const manager = new TasksManager({ tasksFilePath: file });
for (let i = 0; i < Number(count); i += 1) {
  manager.recordBetResult({ id: `${label}-${i}`, bookmakerId: '1win', home: 'A', away: 'B', outcome: label, matchKey: 'a_b', stake: 1 }, 'completed', { odds: 1.9, stake: 1 });
}
