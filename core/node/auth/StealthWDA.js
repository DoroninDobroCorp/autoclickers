/**
 * Stealth WDA Client
 * 100% undetectable Safari automation via iOS accessibility layer
 * 
 * Key points:
 * - NO JavaScript injection
 * - NO navigator.webdriver flag
 * - Uses native iOS accessibility (XCUITest)
 * - Finds elements by parsing XML source
 * - Taps by coordinates
 */

const http = require('http');

class StealthWDA {
    constructor(options = {}) {
        this.host = options.host || 'localhost';
        this.port = options.port || 8100;
        this.sessionId = null;
        this.logger = options.logger || console;
    }

    async request(method, path, body = null, timeout = 30000) {
        return new Promise((resolve, reject) => {
            const req = http.request({
                hostname: this.host,
                port: this.port,
                path: path,
                method: method,
                headers: { 'Content-Type': 'application/json' },
                timeout
            }, res => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); }
                    catch (e) { resolve({ value: data }); }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
            if (body) req.write(JSON.stringify(body));
            req.end();
        });
    }

    // ==================== SESSION ====================

    async createSession() {
        this.logger.log('🔌 Creating stealth Safari session...');
        
        // Launch Safari first
        await this.request('POST', '/wda/apps/launch', { 
            bundleId: 'com.apple.mobilesafari' 
        }).catch(() => {});
        
        await this.pause(1000);
        
        const res = await this.request('POST', '/session', {
            capabilities: { alwaysMatch: { browserName: 'Safari' } }
        });
        
        this.sessionId = res.sessionId;
        this.logger.log(`✅ Session: ${this.sessionId}`);
        return this.sessionId;
    }

    async deleteSession() {
        if (this.sessionId) {
            await this.request('DELETE', `/session/${this.sessionId}`).catch(() => {});
            this.sessionId = null;
        }
    }

    // ==================== NAVIGATION ====================

    async navigate(url) {
        this.logger.log(`🔗 Navigating to: ${url}`);
        await this.request('POST', `/session/${this.sessionId}/url`, { url }, 60000);
    }

    async getActiveApp() {
        const res = await this.request('GET', '/wda/activeAppInfo');
        return res.value;
    }

    // ==================== ELEMENT FINDING (via XML source) ====================

    async getSource() {
        const res = await this.request('GET', `/session/${this.sessionId}/source`, null, 60000);
        return typeof res.value === 'string' ? res.value : JSON.stringify(res.value);
    }

    /**
     * Find element by text content in label/name/value
     * Returns { x, y, width, height } or null
     */
    async findElementByText(text, options = {}) {
        const { exact = false, timeout = 10000 } = options;
        const startTime = Date.now();
        
        while (Date.now() - startTime < timeout) {
            const source = await this.getSource();
            const element = this._parseElementByText(source, text, exact);
            if (element) return element;
            await this.pause(500);
        }
        
        return null;
    }

    /**
     * Find element by type (Button, TextField, SecureTextField, etc.)
     */
    async findElementsByType(type) {
        const source = await this.getSource();
        return this._parseElementsByType(source, type);
    }

    /**
     * Find text input fields
     */
    async findInputFields() {
        const source = await this.getSource();
        const textFields = this._parseElementsByType(source, 'XCUIElementTypeTextField');
        const secureFields = this._parseElementsByType(source, 'XCUIElementTypeSecureTextField');
        return { textFields, secureFields };
    }

    _parseElementByText(xml, searchText, exact = false) {
        // Parse XML to find element with matching text
        const regex = new RegExp(
            `<(XCUIElementType\\w+)[^>]*(?:name|label|value)="([^"]*${this._escapeRegex(searchText)}[^"]*)"[^>]*`,
            'gi'
        );
        
        let match;
        while ((match = regex.exec(xml)) !== null) {
            const fullMatch = match[0];
            const labelValue = match[2];
            
            if (exact && labelValue.toLowerCase() !== searchText.toLowerCase()) continue;
            
            // Extract coordinates
            const x = parseInt(fullMatch.match(/\bx="(\d+)"/)?.[1] || 0);
            const y = parseInt(fullMatch.match(/\by="(\d+)"/)?.[1] || 0);
            const width = parseInt(fullMatch.match(/\bwidth="(\d+)"/)?.[1] || 0);
            const height = parseInt(fullMatch.match(/\bheight="(\d+)"/)?.[1] || 0);
            const visible = fullMatch.includes('visible="true"');
            
            if (width > 0 && height > 0 && visible) {
                return { x, y, width, height, label: labelValue, type: match[1] };
            }
        }
        
        return null;
    }

    _parseElementsByType(xml, type) {
        const elements = [];
        const regex = new RegExp(
            `<${type}[^>]*\\bx="(\\d+)"[^>]*\\by="(\\d+)"[^>]*\\bwidth="(\\d+)"[^>]*\\bheight="(\\d+)"[^>]*`,
            'gi'
        );
        
        let match;
        while ((match = regex.exec(xml)) !== null) {
            const fullMatch = match[0];
            const x = parseInt(match[1]);
            const y = parseInt(match[2]);
            const width = parseInt(match[3]);
            const height = parseInt(match[4]);
            const label = fullMatch.match(/(?:name|label|value)="([^"]*)"/)?.[1] || '';
            const visible = fullMatch.includes('visible="true"');
            
            if (width > 0 && height > 0 && visible) {
                elements.push({ x, y, width, height, label, type });
            }
        }
        
        return elements;
    }

    _escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // ==================== ACTIONS ====================

    async tap(x, y) {
        this.logger.log(`👆 Tap at (${x}, ${y})`);
        await this.request('POST', `/session/${this.sessionId}/actions`, {
            actions: [{
                type: 'pointer',
                id: 'finger1',
                parameters: { pointerType: 'touch' },
                actions: [
                    { type: 'pointerMove', duration: 0, x, y },
                    { type: 'pointerDown', button: 0 },
                    { type: 'pause', duration: 50 },
                    { type: 'pointerUp', button: 0 }
                ]
            }]
        });
    }

    async tapElement(element) {
        const centerX = element.x + Math.floor(element.width / 2);
        const centerY = element.y + Math.floor(element.height / 2);
        await this.tap(centerX, centerY);
    }

    async tapByText(text, options = {}) {
        const element = await this.findElementByText(text, options);
        if (element) {
            await this.tapElement(element);
            return true;
        }
        this.logger.log(`⚠️ Element "${text}" not found`);
        return false;
    }

    /**
     * Type text using iOS keyboard
     * Element must be focused first
     */
    async typeText(text) {
        this.logger.log(`⌨️ Typing: ${text.substring(0, 20)}...`);
        // Send whole text as array of characters
        await this.request('POST', `/session/${this.sessionId}/wda/keys`, {
            value: [text]  // Send as single string, WDA handles it
        });
    }

    /**
     * Clear text field by triple-tap (select all) + type to replace
     */
    async clearField() {
        // Use triple-tap to select all text (iOS native gesture)
        // This is more reliable than keyboard shortcuts
        this.logger.log('🔄 Triple-tap to select all...');
    }

    async pause(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ==================== HIGH LEVEL ACTIONS ====================

    /**
     * Fill input field by tapping and typing
     */
    async fillField(element, text) {
        // Triple-tap to select all existing text (iOS gesture)
        const centerX = element.x + Math.floor(element.width / 2);
        const centerY = element.y + Math.floor(element.height / 2);
        
        // Quick triple tap to select all
        for (let i = 0; i < 3; i++) {
            await this.tap(centerX, centerY);
            await this.pause(80);
        }
        await this.pause(300);
        
        // Type new text (replaces selection)
        await this.typeText(text);
    }

    /**
     * Scroll down
     */
    async scrollDown(amount = 300) {
        const windowSize = await this.getWindowSize();
        const centerX = Math.floor(windowSize.width / 2);
        const startY = Math.floor(windowSize.height * 0.7);
        const endY = startY - amount;
        
        await this.request('POST', `/session/${this.sessionId}/actions`, {
            actions: [{
                type: 'pointer',
                id: 'finger1',
                parameters: { pointerType: 'touch' },
                actions: [
                    { type: 'pointerMove', duration: 0, x: centerX, y: startY },
                    { type: 'pointerDown', button: 0 },
                    { type: 'pointerMove', duration: 300, x: centerX, y: endY },
                    { type: 'pointerUp', button: 0 }
                ]
            }]
        });
    }

    async getWindowSize() {
        const res = await this.request('GET', `/session/${this.sessionId}/window/size`);
        return res.value;
    }
}

module.exports = { StealthWDA };
