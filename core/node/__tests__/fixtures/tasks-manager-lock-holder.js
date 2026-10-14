// child process of the lock-ownership tests: takes the REAL cross-process lock of the real manager and
// holds it inside a synchronous critical section ("slow filesystem", "slow writer"), then optionally
// writes one history record inside that section.
//   node tasks-manager-lock-holder.js <tasks file> <hold ms> [label]
const { TasksManager } = require('../../tasks/tasks-manager.js');
const [file, holdMs, label] = process.argv.slice(2);
console.log = () => {}; console.warn = () => {};
const manager = new TasksManager({ tasksFilePath: file, startupCleanup: false });
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
manager._withLock(() => {
  process.stdout.write(`LOCKED ${process.pid}\n`);
  sleep(Number(holdMs));
  if (label) {
    manager.recordBetResult({ id: `${label}-${process.pid}`, bookmakerId: '1win', home: 'A', away: 'B', outcome: label, matchKey: 'a_b', stake: 1 },
      'completed', { odds: 1.9, stake: 1 });
  }
});
process.stdout.write('RELEASED\n');
