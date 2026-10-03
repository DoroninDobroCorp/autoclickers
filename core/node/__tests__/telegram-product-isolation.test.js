const fs = require('fs');
const os = require('os');
const path = require('path');
const { TelegramNotifier } = require('../integrations/telegram-notifier');

test('two products keep counters and notification targets separate', () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'notifier-isolation-'));
 try {
  const a=new TelegramNotifier({botToken:'test-a',logsChatId:'a',countersFile:path.join(root,'a','counters.json')});
  const b=new TelegramNotifier({botToken:'test-b',logsChatId:'b',countersFile:path.join(root,'b','counters.json')});
  expect(a.getNextBetNumber('Betfair')).toBe(1);
  expect(a.getNextBetNumber('Betfair')).toBe(2);
  expect(b.getNextBetNumber('Betfair')).toBe(1);
  expect(a.bookmakerChatIds).toEqual({});
  expect(b.bookmakerChatIds).toEqual({});
  const restored=new TelegramNotifier({botToken:'test-a',logsChatId:'a',countersFile:path.join(root,'a','counters.json')});
  expect(restored.getNextBetNumber('Betfair')).toBe(3);
  expect(fs.statSync(path.join(root,'a','counters.json')).mode & 0o777).toBe(0o600);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
