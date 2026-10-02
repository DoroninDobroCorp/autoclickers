const fs = require('fs');
const path = require('path');

class SimpleLogger {
    constructor(options = {}) {
        this.name = options.name || 'bettor';
        this.logDir = options.logDir || __dirname;
        this.logFile = options.logFile || path.join(this.logDir, `${this.name}.log`);
        this.verbose = options.verbose !== false;
        this.maxSize = options.maxSize || 5 * 1024 * 1024; // 5MB default
        this.maxOldFiles = options.maxOldFiles || 1; // Keep only 1 old file
        this.writeCount = 0;
        this.checkInterval = 1000; // Check every 1000 writes
        
        // Rotate if needed on start
        this._rotateIfNeeded();
    }
    
    _rotateIfNeeded() {
        try {
            if (fs.existsSync(this.logFile)) {
                const stats = fs.statSync(this.logFile);
                if (stats.size > this.maxSize) {
                    // Rotate current log
                    const rotatedFile = `${this.logFile}.${Date.now()}.old`;
                    fs.renameSync(this.logFile, rotatedFile);
                    // Cleanup old rotated files
                    this._cleanupOldFiles();
                }
            }
        } catch (e) {
            // Ignore rotation errors
        }
    }
    
    _cleanupOldFiles() {
        try {
            const dir = path.dirname(this.logFile);
            const baseName = path.basename(this.logFile);
            const files = fs.readdirSync(dir)
                .filter(f => f.startsWith(baseName) && f.endsWith('.old'))
                .map(f => ({ name: f, path: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtime }))
                .sort((a, b) => b.mtime - a.mtime); // Newest first
            
            // Delete all but maxOldFiles
            for (let i = this.maxOldFiles; i < files.length; i++) {
                fs.unlinkSync(files[i].path);
            }
        } catch (e) {
            // Ignore cleanup errors
        }
    }
    
    _timestamp() {
        return new Date().toISOString().replace('T', ' ').substring(0, 19);
    }
    
    _write(level, message) {
        const ts = this._timestamp();
        const line = `[${ts}] [${level}] ${message}\n`;
        
        // Write to file
        try {
            fs.appendFileSync(this.logFile, line);
            
            // Periodic rotation check
            this.writeCount++;
            if (this.writeCount >= this.checkInterval) {
                this.writeCount = 0;
                this._rotateIfNeeded();
            }
        } catch (e) {
            // Fallback to console only
        }
        
        // Write to console
        if (level === 'ERROR') {
            console.error(message);
        } else {
            console.log(message);
        }
    }
    
    log(message) {
        this._write('INFO', message);
    }
    
    error(message) {
        this._write('ERROR', message);
    }
    
    warn(message) {
        this._write('WARN', message);
    }
    
    debug(message) {
        if (this.verbose) {
            this._write('DEBUG', message);
        }
    }
}

module.exports = { SimpleLogger };
