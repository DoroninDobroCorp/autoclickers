/**
 * SafeHttpClient — HTTP клиент с реальным iPhone TLS fingerprint
 * 
 * Использует curl-impersonate для имитации Safari iOS.
 * Запросы идут через прокси: Mac → iPhone USB tethering → 4G
 * 
 * Установка curl-impersonate:
 *   brew tap aspect-build/aspect
 *   brew install aspect-build/aspect/curl-impersonate
 * 
 * Или скачать бинарник:
 *   https://github.com/lwthiker/curl-impersonate/releases
 */

const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

class SafeHttpClient {
    constructor(options = {}) {
        this.proxyUrl = options.proxyUrl || null; // 'http://localhost:8888'
        this.timeout = options.timeout || 30;
        this.logger = options.logger || console;
        
        // curl-impersonate binary (Safari на iOS)
        this.curlBin = options.curlBin || this._findCurlImpersonate();
        
        // Rate limiting
        this.rateLimiting = options.rateLimiting !== false;
        this.minRequestInterval = options.minRequestInterval || 300; // ms
        this.lastRequestTime = 0;
        
        // Jitter (случайная задержка)
        this.jitter = options.jitter !== false;
        this.jitterRange = options.jitterRange || [50, 200]; // ms
        
        // Профиль iPhone
        this.profile = this._loadProfile(options.profilePath);
    }

    _findCurlImpersonate() {
        const candidates = [
            'curl_safari17',           // Safari 17
            'curl_safari15_5',         // Safari 15.5
            '/opt/homebrew/bin/curl_safari17',
            '/usr/local/bin/curl_safari17',
            'curl'                     // Fallback на обычный curl
        ];
        
        for (const bin of candidates) {
            try {
                execSync(`which ${bin.split(' ')[0]}`, { stdio: 'ignore' });
                return bin;
            } catch (e) {
                continue;
            }
        }
        
        this.logger.warn('⚠️ curl-impersonate not found, using regular curl');
        return 'curl';
    }

    _loadProfile(profilePath) {
        const defaultPath = path.join(__dirname, '../../infrastructure/profiles/iphone_volcano.json');
        const filePath = profilePath || defaultPath;
        
        if (fs.existsSync(filePath)) {
            try {
                return JSON.parse(fs.readFileSync(filePath, 'utf8'));
            } catch (e) {
                this.logger.warn(`Failed to load profile: ${e.message}`);
            }
        }
        
        // Дефолтный профиль Safari iOS 17
        return {
            user_agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
            headers: {
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "en-US,en;q=0.9",
                "Accept-Encoding": "gzip, deflate, br"
            }
        };
    }

    async _applyRateLimiting() {
        if (!this.rateLimiting) return;
        
        const now = Date.now();
        const elapsed = now - this.lastRequestTime;
        
        if (elapsed < this.minRequestInterval) {
            const wait = this.minRequestInterval - elapsed;
            await new Promise(r => setTimeout(r, wait));
        }
        
        this.lastRequestTime = Date.now();
    }

    async _applyJitter() {
        if (!this.jitter) return;
        
        const [min, max] = this.jitterRange;
        const delay = min + Math.random() * (max - min);
        await new Promise(r => setTimeout(r, delay));
    }

    _buildCurlCommand(method, url, options = {}) {
        const args = [
            this.curlBin,
            '-s', '-S',                          // Silent but show errors
            '--max-time', String(this.timeout),
            '-X', method
        ];
        
        // Proxy
        if (this.proxyUrl) {
            args.push('--proxy', this.proxyUrl);
        }
        
        // User-Agent
        args.push('-A', `"${this.profile.user_agent}"`);
        
        // Default headers from profile
        for (const [key, value] of Object.entries(this.profile.headers || {})) {
            args.push('-H', `"${key}: ${value}"`);
        }
        
        // Custom headers
        if (options.headers) {
            for (const [key, value] of Object.entries(options.headers)) {
                args.push('-H', `"${key}: ${value}"`);
            }
        }
        
        // Body
        if (options.body) {
            const body = typeof options.body === 'string' 
                ? options.body 
                : JSON.stringify(options.body);
            args.push('-d', `'${body.replace(/'/g, "'\\''")}'`);
        }
        
        // Get HTTP status code
        args.push('-w', '"\\n%{http_code}"');
        
        // URL
        args.push(`"${url}"`);
        
        return args.join(' ');
    }

    async request(method, url, options = {}) {
        await this._applyRateLimiting();
        await this._applyJitter();
        
        const cmd = this._buildCurlCommand(method, url, options);
        
        try {
            const output = execSync(cmd, {
                encoding: 'utf8',
                timeout: (this.timeout + 5) * 1000,
                maxBuffer: 10 * 1024 * 1024,
                shell: true
            });
            
            const lines = output.trim().split('\n');
            const statusCode = parseInt(lines.pop()) || 0;
            const body = lines.join('\n');
            
            let data = null;
            try {
                data = JSON.parse(body);
            } catch (e) {
                data = body;
            }
            
            return {
                ok: statusCode >= 200 && statusCode < 300,
                status: statusCode,
                data,
                text: body
            };
        } catch (error) {
            this.logger.error(`SafeHttpClient error: ${error.message}`);
            return {
                ok: false,
                status: 0,
                error: error.message
            };
        }
    }

    async get(url, headers = {}) {
        return this.request('GET', url, { headers });
    }

    async post(url, body, headers = {}) {
        return this.request('POST', url, { body, headers });
    }

    async put(url, body, headers = {}) {
        return this.request('PUT', url, { body, headers });
    }

    async delete(url, headers = {}) {
        return this.request('DELETE', url, { headers });
    }
}

module.exports = { SafeHttpClient };
