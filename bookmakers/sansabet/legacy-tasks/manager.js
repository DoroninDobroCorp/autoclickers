const path = require('path');
const { TasksManager: Core } = require('../../../core/node/tasks/tasks-manager');
// Keep legacy single-bookmaker calls while all stored state uses the common manager.
class SansabetTasksManager {
 constructor(options = {}) {
  const runtime = path.resolve(options.runtimeRoot || process.env.AUTOMATION_RUNTIME_ROOT || process.cwd());
  const source = path.resolve(__dirname, '../../..');
  if (runtime === source || runtime.startsWith(source + path.sep)) throw new Error('Private runtime must be outside common source');
  const config = options.config || require(path.join(runtime, 'config.json'));
  this.core = new Core({...config, tasksFilePath: options.tasksFilePath || path.join(runtime, 'bet_tasks.json')});
 }
 addTask(task) {return this.core.addTask({...task, bookmakerId:task.bookmakerId || 'sansabet'});}
 getCurrentTask(bookmakerId='sansabet') {return this.core.getCurrentTask(bookmakerId);}
 getHistory(bookmakerId='sansabet', options={}) {
  if (bookmakerId && typeof bookmakerId === 'object') {options=bookmakerId; bookmakerId='sansabet';}
  return this.core.getHistory(bookmakerId, options);
 }
 read() {
  const data = this.core.read();
  return {current:data.currentTasks.sansabet || null, pending:data.pendingTasks.sansabet || null,
   processing:!!data.processing.sansabet, history:data.history.filter(task=>task.bookmakerId==='sansabet')};
 }
}
for (const method of Object.getOwnPropertyNames(Core.prototype)) {
 if (method !== 'constructor' && !Object.prototype.hasOwnProperty.call(SansabetTasksManager.prototype, method)) {
  SansabetTasksManager.prototype[method] = function(...args) {return this.core[method](...args);};
 }
}
module.exports = SansabetTasksManager;
