/**
 * Safari Driver Client
 * Uses native macOS safaridriver for real Safari automation on iPhone
 * Much more reliable than WDA for web content
 */

const http = require('http');

class SafariDriver {
    constructor(options = {}) {
        this.host = options.host || 'localhost';
        this.port = options.port || 4444;
        this.udid = options.udid;
        this.sessionId = null;
        this.logger = options.logger || console;
    }

    async request(method, path, body = null) {
        return new Promise((resolve, reject) => {
            const req = http.request({
                hostname: this.host,
                port: this.port,
                path: path,
                method: method,
                headers: { 'Content-Type': 'application/json' },
                timeout: 30000
            }, res => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); }
                    catch (e) { resolve({ value: data }); }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => reject(new Error('Request timeout')));
            if (body) req.write(JSON.stringify(body));
            req.end();
        });
    }

    async createSession() {
        this.logger.log('🔌 Creating Safari session on iPhone...');
        
        const res = await this.request('POST', '/session', {
            capabilities: {
                alwaysMatch: {
                    browserName: 'safari',
                    platformName: 'iOS',
                    'safari:deviceUDID': this.udid,
                    'safari:useSimulator': false
                }
            }
        });

        if (res.value?.sessionId) {
            this.sessionId = res.value.sessionId;
            this.logger.log(`✅ Session created: ${this.sessionId}`);
            return this.sessionId;
        }
        
        throw new Error('Failed to create session: ' + JSON.stringify(res));
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

    async getUrl() {
        const res = await this.request('GET', `/session/${this.sessionId}/url`);
        return res.value;
    }

    async getTitle() {
        const res = await this.request('GET', `/session/${this.sessionId}/title`);
        return res.value;
    }

    async execute(script, args = []) {
        const res = await this.request('POST', `/session/${this.sessionId}/execute/sync`, {
            script, args
        });
        return res.value;
    }

    async executeAsync(script, args = []) {
        const res = await this.request('POST', `/session/${this.sessionId}/execute/async`, {
            script, args
        });
        return res.value;
    }

    async findElement(using, value) {
        const res = await this.request('POST', `/session/${this.sessionId}/element`, {
            using, value
        });
        return res.value?.['element-6066-11e4-a52e-4f735466cecf'] || res.value?.ELEMENT;
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
            text
        });
    }

    async pause(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ==================== HIGH LEVEL METHODS ====================

    async getLocalStorage(key) {
        return this.execute(`return localStorage.getItem('${key}')`);
    }

    async setLocalStorage(key, value) {
        return this.execute(`localStorage.setItem('${key}', ${JSON.stringify(value)})`);
    }

    async closePopups() {
        return this.execute(`
            // Close modals
            document.querySelectorAll('.modal .close, .cdk-overlay-pane button.close, .modal-backdrop').forEach(el => {
                if (el.click) el.click();
                else el.remove();
            });
            // Clear CDK overlay
            const cdk = document.querySelector('.cdk-overlay-container');
            if (cdk) cdk.innerHTML = '';
            // Remove fixed overlays
            document.querySelectorAll('[style*="position: fixed"]').forEach(el => {
                const z = parseInt(getComputedStyle(el).zIndex) || 0;
                if (z > 100 && !el.classList.contains('navbar')) el.remove();
            });
            return true;
        `);
    }

    async fillAngularInput(selector, value) {
        return this.execute(`
            const input = document.querySelector('${selector}');
            if (input) {
                input.value = '${value}';
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
            }
            return false;
        `);
    }

    async clickByText(text) {
        return this.execute(`
            const texts = '${text}'.split('|');
            for (const t of texts) {
                const els = [...document.querySelectorAll('button, a, [role="button"]')];
                const el = els.find(e => e.textContent.trim().toLowerCase().includes(t.toLowerCase()));
                if (el) { el.click(); return true; }
            }
            return false;
        `);
    }
}

module.exports = { SafariDriver };
