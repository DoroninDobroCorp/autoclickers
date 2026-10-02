/**
 * 1win Autobetting Prematch Runner (big_value architecture)
 */

const fs = require('fs');
const path = require('path');

const LOCK_FILE = path.join(process.env.AUTOMATION_RUNTIME_ROOT || '.', '.bettor_prematch.lock');

function acquireLockSync() {
    const currentPid = process.pid;
    if (fs.existsSync(LOCK_FILE)) {
        try {
            const content = fs.readFileSync(LOCK_FILE, 'utf8').trim();
            const [pid, timestamp] = content.split(':');
            const lockPid = parseInt(pid);
            try {
                process.kill(lockPid, 0);
                console.error('🚨 1win prematch bettor already running (PID: ' + lockPid + ')');
                process.exit(1);
            } catch (e) {
                console.log('⚠️ Stale lock found (PID ' + lockPid + ' dead), reclaiming...');
            }
        } catch (e) {}
    }
    fs.writeFileSync(LOCK_FILE, currentPid + ':' + Date.now(), { flag: 'w' });
    console.log('🔒 Prematch Lock acquired (PID: ' + currentPid + ')');

    const cleanup = () => {
        try {
            if (fs.existsSync(LOCK_FILE)) {
                fs.unlinkSync(LOCK_FILE);
                console.log('🔓 Prematch Lock released');
            }
        } catch (e) {}
    };
    process.on('exit', cleanup);
    process.on('uncaughtException', (e) => { console.error(e); cleanup(); process.exit(1); });
}

acquireLockSync();

const { BaseBettor } = require('../../../core/node/betting');
const { OneWinAdapter } = require('./OneWinAdapter.js');
const { SimpleLogger } = require('../../../core/node/betting/SimpleLogger.js');

const runtimeRoot = process.env.AUTOMATION_RUNTIME_ROOT;
if (!runtimeRoot) throw new Error('AUTOMATION_RUNTIME_ROOT must point to private project state');
const configPath = process.env.ONEWIN_CONFIG_FILE || path.join(runtimeRoot, '1win.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
config.sessionStatePath = process.env.ONEWIN_SESSION_STATE || path.join(runtimeRoot, '1win-session.json');
config.screenshotDir = path.join(runtimeRoot, 'screenshots');

config.bookmakerName = '1win';
config.displayName = '1win (Prematch)';
config.isPrematch = true;
config.mode = 'prematch';
config.stateFilePath = path.join(process.env.AUTOMATION_RUNTIME_ROOT || '.', '.bettor_prematch_state.json');
config.tasksFilePath = path.join(process.env.AUTOMATION_RUNTIME_ROOT || '.', '.bettor_prematch_tasks.json');

// Point primary analyzer to prematch
config.analyzer = config.prematchAnalyzer;

if (process.env.MAX_SUCCESSFUL) config.maxSuccessful = parseInt(process.env.MAX_SUCCESSFUL);
if (process.env.MAX_BETS) config.maxBets = parseInt(process.env.MAX_BETS);
if (process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true') config.dryRun = true;
if (process.env.VERBOSE === '1' || process.env.VERBOSE === 'true') config.verbose = true;
if (process.env.TG_QUIET === '1' || process.env.TG_QUIET === 'true') config.tgQuiet = true;

const args = process.argv.slice(2);
if (args.includes('--dry-run')) config.dryRun = true;
if (args.includes('--verbose')) config.verbose = true;

const logger = new SimpleLogger({
    name: '1win_prematch',
    logDir: __dirname,
    verbose: config.verbose
});
config.logger = logger;

async function run() {
    const adapter = new OneWinAdapter(config);
    const bettor = new BaseBettor(adapter, config);

    const onShutdown = async (signal) => {
        console.log('\n🛑 Received ' + signal + ', shutting down prematch...');
        await bettor.stop();
        await adapter.close();
        process.exit(0);
    };
    process.on('SIGINT', () => onShutdown('SIGINT'));
    process.on('SIGTERM', () => onShutdown('SIGTERM'));

    console.log('='.repeat(60));
    console.log('1WIN PREMATCH AUTOBETTING (big_value architecture)');
    console.log('DryRun: ' + !!config.dryRun + ' | Verbose: ' + !!config.verbose);
    console.log('='.repeat(60));

    try {
        await bettor.start();
        console.log('✅ Prematch Bettor finished');
    } catch (e) {
        console.error('❌ Prematch Bettor error:', e.message);
        process.exit(1);
    }
}

run().catch(e => {
    console.error('Fatal:', e.message);
    process.exit(1);
});
