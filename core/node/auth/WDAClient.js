/**
 * Direct WebDriverAgent Client
 * Works directly with WDA without Appium middleware
 */

const http = require('http');

class WDAClient {
    constructor(options = {}) {
        this.host = options.host || 'localhost';
        this.port = options.port || 8100;
        this.sessionId = null;
        this.logger = options.logger || console;
    }

    async request(method, path, body = null) {
        return new Promise((resolve, reject) => {
            const options = {
                hostname: this.host,
                port: this.port,
                path: path,
                method: method,
                headers: { 'Content-Type': 'application/json' },
                timeout: 30000
            };
            
            const req = http.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        resolve({ value: data });
                    }
                });
            });
            
            req.on('error', reject);
            req.on('timeout', () => reject(new Error('Request timeout')));
            
            if (body) req.write(JSON.stringify(body));
            req.end();
        });
    }

    async createSession() {
        this.logger.log('🔌 Creating WDA Safari session...');
        const res = await this.request('POST', '/session', {
            capabilities: { alwaysMatch: { browserName: 'Safari' } }
        });
        this.sessionId = res.sessionId;
        this.logger.log(`✅ Session created: ${this.sessionId}`);
        return this.sessionId;
    }

    async deleteSession() {
        if (this.sessionId) {
            await this.request('DELETE', `/session/${this.sessionId}`);
            this.logger.log('🔌 Session closed');
            this.sessionId = null;
        }
    }

    async navigate(url) {
        this.logger.log(`🔗 Navigating to: ${url}`);
        await this.request('POST', `/session/${this.sessionId}/url`, { url });
    }

    async getPageSource() {
        const res = await this.request('GET', `/session/${this.sessionId}/source`);
        return res.value;
    }

    async findElement(using, value) {
        const res = await this.request('POST', `/session/${this.sessionId}/element`, {
            using, value
        });
        return res.value?.ELEMENT || res.value?.element;
    }

    async findElements(using, value) {
        const res = await this.request('POST', `/session/${this.sessionId}/elements`, {
            using, value
        });
        return res.value || [];
    }

    async click(elementId) {
        await this.request('POST', `/session/${this.sessionId}/element/${elementId}/click`);
    }

    async sendKeys(elementId, text) {
        await this.request('POST', `/session/${this.sessionId}/element/${elementId}/value`, {
            value: text.split('')
        });
    }

    async execute(script, args = []) {
        const res = await this.request('POST', `/session/${this.sessionId}/execute/sync`, {
            script, args
        });
        return res.value;
    }

    async pause(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ==================== HIGH LEVEL METHODS ====================

    async tap(selector) {
        const el = await this.findElement('css selector', selector);
        if (el) {
            await this.click(el);
            return true;
        }
        return false;
    }

    async tapByXPath(xpath) {
        const el = await this.findElement('xpath', xpath);
        if (el) {
            await this.click(el);
            return true;
        }
        return false;
    }

    async type(selector, text) {
        const el = await this.findElement('css selector', selector);
        if (el) {
            await this.sendKeys(el, text);
            return true;
        }
        return false;
    }

    async getLocalStorage(key) {
        return this.execute(`return localStorage.getItem('${key}')`);
    }

    async setLocalStorage(key, value) {
        return this.execute(`localStorage.setItem('${key}', '${value}')`);
    }
}

module.exports = { WDAClient };
