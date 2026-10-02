/**
 * LockManager - Process lock file management
 * 
 * Prevents multiple instances of bettor running simultaneously.
 * Uses PID-based lock files.
 */

const fs = require('fs');

/**
 * Acquire lock to prevent multiple instances
 * @param {string} lockFilePath - path to lock file
 * @returns {boolean} true if lock acquired
 */
function acquireLock(lockFilePath) {
    const currentPid = process.pid;

    const writeLock = () => {
        try {
            fs.writeFileSync(lockFilePath, `${currentPid}:${Date.now()}`, { flag: 'wx' });
            console.log(`🔒 Lock acquired (PID: ${currentPid})`);
            return true;
        } catch (e) {
            if (e.code !== 'EEXIST') {
                console.log(`⚠️ Could not create lock file: ${e.message}`);
                return false;
            }
            return false;
        }
    };

    if (writeLock()) {
        return true;
    }

    if (fs.existsSync(lockFilePath)) {
        try {
            const lockData = fs.readFileSync(lockFilePath, 'utf8').trim();
            const [pid] = lockData.split(':');
            const lockPid = parseInt(pid);
            
            // Check if process with this PID exists
            try {
                process.kill(lockPid, 0);
                console.error('🚨 CRITICAL: Duplicate bettor instance detected!');
                console.error(`❌ Process with PID ${lockPid} already running`);
                return false;
            } catch (e) {
                console.log(`⚠️ Stale lock found (PID ${lockPid} not running), overwriting...`);
                try {
                    fs.unlinkSync(lockFilePath);
                } catch (unlinkError) {
                    console.log(`⚠️ Could not remove stale lock: ${unlinkError.message}`);
                    return false;
                }
            }
        } catch (e) {
            console.log(`⚠️ Could not read lock file, creating new...`);
            try {
                fs.unlinkSync(lockFilePath);
            } catch (unlinkError) {
                if (unlinkError.code !== 'ENOENT') {
                    console.log(`⚠️ Could not remove unreadable lock: ${unlinkError.message}`);
                    return false;
                }
            }
        }
    }

    return writeLock();
}

/**
 * Release lock on exit
 * @param {string} lockFilePath - path to lock file
 */
function releaseLock(lockFilePath) {
    const currentPid = process.pid;
    try {
        if (fs.existsSync(lockFilePath)) {
            const content = fs.readFileSync(lockFilePath, 'utf8');
            if (content.startsWith(`${currentPid}:`)) {
                fs.unlinkSync(lockFilePath);
                console.log('🔓 Lock released');
            }
        }
    } catch (e) {
        // Ignore errors on cleanup
    }
}

module.exports = { acquireLock, releaseLock };
