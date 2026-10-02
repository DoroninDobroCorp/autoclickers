function normalizeExecutionMode(value) {
    const mode = String(value || 'analyzer-only').trim().toLowerCase();
    if (mode === 'telegram-only' || mode === 'tg-only') return 'telegram-only';
    if (mode === 'hybrid' || mode === 'both') return 'hybrid';
    return 'analyzer-only';
}

function applyExecutionModeConfig(config, args = [], env = process.env, options = {}) {
    const defaultMode = normalizeExecutionMode(options.defaultMode || config.executionMode || 'analyzer-only');

    let requestedMode = defaultMode;
    const explicitModeArg = args.find((arg) => arg.startsWith('--execution-mode='));
    if (explicitModeArg) {
        requestedMode = normalizeExecutionMode(explicitModeArg.split('=').slice(1).join('='));
    } else if (args.includes('--telegram-only')) {
        requestedMode = 'telegram-only';
    } else if (args.includes('--hybrid')) {
        requestedMode = 'hybrid';
    } else if (args.includes('--analyzer-only')) {
        requestedMode = 'analyzer-only';
    } else if (env.AUTOBETTING_EXECUTION_MODE) {
        requestedMode = normalizeExecutionMode(env.AUTOBETTING_EXECUTION_MODE);
    }

    const taskRunnerIntervalArg = args.find((arg) => arg.startsWith('--task-runner-interval-ms='));
    const enableTaskApi = args.includes('--task-api') ||
        args.includes('--enable-task-api') ||
        env.TELEGRAM_TASK_API === '1' ||
        env.TELEGRAM_TASK_API === 'true';
    const disableTaskApi = args.includes('--no-task-api') || args.includes('--disable-task-api');
    const enableTelegramIngress = args.includes('--telegram-ingress') ||
        args.includes('--enable-telegram-ingress') ||
        env.TELEGRAM_INGRESS === '1' ||
        env.TELEGRAM_INGRESS === 'true';
    const disableTelegramIngress = args.includes('--no-telegram-ingress') ||
        args.includes('--disable-telegram-ingress');

    config.executionMode = requestedMode;
    config.enableAnalyzerPolling = requestedMode !== 'telegram-only';
    config.enableTelegramQueue = requestedMode !== 'analyzer-only';
    config.enableTaskRunner = requestedMode !== 'telegram-only' || Boolean(config.tasksFilePath);
    config.enableTaskQueueApi = disableTaskApi ? false : (enableTaskApi ? true : requestedMode !== 'analyzer-only');
    config.enableTelegramIngress = disableTelegramIngress
        ? false
        : (enableTelegramIngress ? true : (config.enableTelegramIngress ?? config.telegram?.ingress?.enabled ?? false));

    if (taskRunnerIntervalArg) {
        const value = Number(taskRunnerIntervalArg.split('=').slice(1).join('='));
        if (Number.isFinite(value) && value > 0) {
            config.taskRunnerIntervalMs = value;
        }
    }

    return requestedMode;
}

function describeExecutionMode(mode) {
    switch (normalizeExecutionMode(mode)) {
        case 'telegram-only':
            return 'telegram-only';
        case 'hybrid':
            return 'hybrid';
        default:
            return 'analyzer-only';
    }
}

module.exports = {
    normalizeExecutionMode,
    applyExecutionModeConfig,
    describeExecutionMode
};
