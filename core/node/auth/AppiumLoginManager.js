/**
 * Управляет Safari на iPhone через Appium.
 * Используется для логина в БК и получения токенов.
 * 
 * Архитектура вдохновлена AppiumWebDriver (C#) прототипом:
 * - Actions паттерн (tap, fillForm, navigate, switchContext)
 * - Context switching (NATIVE_APP <-> WEBVIEW)
 * - Login state detection через pageSource
 */

const { remote } = require('webdriverio');

class AppiumLoginManager {
    constructor(options = {}) {
        this.appiumUrl = options.appiumUrl || 'http://localhost:4723';
        this.udid = options.udid;
        this.driver = null;
        this.logger = options.logger || console;
    }

    async connect() {
        this.logger.log('🔌 Connecting to Appium...');
        this.driver = await remote({
            hostname: 'localhost',
            port: 4723,
            path: '/',
            capabilities: {
                platformName: 'iOS',
                'appium:platformVersion': '18.5',
                'appium:automationName': 'XCUITest',
                'appium:browserName': 'Safari',
                'appium:udid': this.udid,
                'appium:noReset': true,
                'appium:newCommandTimeout': 300,
                'appium:useNewWDA': false,
                'appium:wdaLaunchTimeout': 180000,
                'appium:wdaConnectionTimeout': 60000,
                'appium:safariAllowPopups': true,
                'appium:safariIgnoreFraudWarning': true
            },
            connectionRetryTimeout: 300000,
            connectionRetryCount: 1
        });
        this.logger.log('✅ Connected to Appium');
        return this.driver;
    }

    async disconnect() {
        if (this.driver) {
            await this.driver.deleteSession();
            this.driver = null;
            this.logger.log('🔌 Disconnected from Appium');
        }
    }

    // ==================== CONTEXT MANAGEMENT ====================

    async switchToWebContext() {
        const contexts = await this.driver.getContexts();
        const webContext = contexts.find(c => c.includes('WEBVIEW'));
        if (webContext) {
            await this.driver.switchContext(webContext);
            this.logger.log(`📱 Switched to context: ${webContext}`);
            return true;
        }
        return false;
    }

    async switchToNativeContext() {
        await this.driver.switchContext('NATIVE_APP');
        this.logger.log('📱 Switched to NATIVE_APP context');
    }

    // ==================== ACTIONS ====================

    async navigate(url) {
        this.logger.log(`🔗 Navigating to: ${url}`);
        await this.driver.url(url);
        await this.driver.pause(2000);
    }

    async tap(selector, options = {}) {
        const { timeout = 10000, delayAfter = 500 } = options;
        const element = await this.driver.$(selector);
        await element.waitForDisplayed({ timeout });
        await element.click();
        if (delayAfter) await this.driver.pause(delayAfter);
    }

    async tapByText(text, options = {}) {
        const { timeout = 10000, delayAfter = 500 } = options;
        const texts = text.split('|');
        for (const t of texts) {
            try {
                const element = await this.driver.$(`//*[contains(text(), "${t}")]`);
                if (await element.isDisplayed()) {
                    await element.click();
                    if (delayAfter) await this.driver.pause(delayAfter);
                    return true;
                }
            } catch (e) {}
        }
        throw new Error(`Element with text "${text}" not found`);
    }

    async fillForm(fields) {
        for (const [selector, value] of Object.entries(fields)) {
            const element = await this.driver.$(selector);
            await element.waitForDisplayed({ timeout: 10000 });
            await element.clearValue();
            await element.setValue(value);
            await this.driver.pause(300);
        }
    }

    // ==================== LOGIN STATE ====================

    async isLoggedIn(indicators = {}) {
        const {
            loginIndicators = ['login', 'sign in', 'войти', 'вход'],
            loggedInIndicators = ['logout', 'sign out', 'выйти', 'profile', 'баланс', 'balance']
        } = indicators;

        try {
            const pageSource = await this.driver.getPageSource();
            const sourceLower = pageSource.toLowerCase();
            
            const hasLoginForm = loginIndicators.some(i => sourceLower.includes(i));
            const hasLoggedIn = loggedInIndicators.some(i => sourceLower.includes(i));
            
            return !hasLoginForm || hasLoggedIn;
        } catch (e) {
            return false;
        }
    }

    // ==================== BOOKMAKER LOGINS ====================

    async loginVolcano(credentials) {
        const driver = await this.connect();
        
        try {
            this.logger.log('🎰 Starting Volcano login via real iPhone Safari...');
            
            // 1. Navigate to mobile site
            await this.navigate('https://m.volcanobet.me');
            await driver.pause(3000);
            
            // 2. Close all popups (Volcano has many)
            this.logger.log('🚫 Closing popups...');
            const closeTexts = ['Sljedeće', 'Zatvori', 'Close', 'Skip'];
            for (let attempt = 0; attempt < 10; attempt++) {
                let closed = false;
                for (const text of closeTexts) {
                    try {
                        await driver.execute((t) => {
                            document.querySelectorAll('button, a').forEach(el => {
                                if (el.textContent.trim() === t) { el.click(); }
                            });
                        }, text);
                        await driver.pause(500);
                        closed = true;
                    } catch (e) {}
                }
                if (!closed) break;
            }
            
            // 3. Accept cookies
            this.logger.log('🍪 Accepting cookies...');
            await driver.execute(() => {
                document.querySelectorAll('button').forEach(btn => {
                    if (btn.textContent.trim() === 'Prihvati') btn.click();
                });
            });
            await driver.pause(500);
            
            // 4. Check if already logged in
            let token = await driver.execute(() => {
                const auth = localStorage.getItem('x-auth');
                if (auth) {
                    try { return JSON.parse(auth).accessToken; } catch (e) {}
                }
                return null;
            });
            
            if (token) {
                this.logger.log('✅ Already logged in!');
                return { success: true, token };
            }
            
            // 5. Click Prijava (login button)
            this.logger.log('👆 Opening login form...');
            await driver.execute(() => {
                document.querySelectorAll('button, a, span').forEach(el => {
                    if (el.textContent.trim() === 'Prijava') el.click();
                });
            });
            await driver.pause(2000);
            
            // 6. Fill credentials
            this.logger.log('✏️ Filling credentials...');
            await driver.execute((username, password) => {
                const userInput = document.querySelector('input[formcontrolname="username"], input[type="text"]:not([type="hidden"])');
                const passInput = document.querySelector('input[type="password"]');
                
                if (userInput) {
                    userInput.value = username;
                    userInput.dispatchEvent(new Event('input', { bubbles: true }));
                }
                if (passInput) {
                    passInput.value = password;
                    passInput.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }, credentials.username || credentials.email, credentials.password);
            await driver.pause(500);
            
            // 7. Submit
            this.logger.log('🔐 Submitting...');
            await driver.execute(() => {
                const btn = document.querySelector('form button.btn-primary, button[type="submit"]');
                if (btn) btn.click();
            });
            
            // 8. Wait for login and extract token
            this.logger.log('⏳ Waiting for authentication...');
            for (let i = 0; i < 20; i++) {
                await driver.pause(1000);
                token = await driver.execute(() => {
                    const auth = localStorage.getItem('x-auth');
                    if (auth) {
                        try { return JSON.parse(auth).accessToken; } catch (e) {}
                    }
                    return null;
                });
                if (token) {
                    this.logger.log('✅ Volcano login successful!');
                    return { success: true, token };
                }
            }
            
            this.logger.log('❌ Volcano login failed - no token after 20s');
            return { success: false, token: null };
        } finally {
            await this.disconnect();
        }
    }

    async _closePopups() {
        try {
            await this.driver.execute(() => {
                // Close modals
                document.querySelectorAll('.modal .close, .cdk-overlay-pane button.close').forEach(el => el.click());
                // Remove overlays
                document.querySelectorAll('.cdk-overlay-backdrop, .modal-backdrop').forEach(el => el.remove());
                // Clear CDK container
                const cdk = document.querySelector('.cdk-overlay-container');
                if (cdk) cdk.innerHTML = '';
            });
            await this.driver.pause(500);
        } catch (e) {}
    }

    async loginSansabet(credentials) {
        const driver = await this.connect();
        
        try {
            await driver.url('https://sansabet.com');
            await driver.pause(2000);

            // TODO: Реализовать логику логина для Sansabet
            const token = await driver.execute(() => {
                return localStorage.getItem('token') || sessionStorage.getItem('token');
            });

            return { success: !!token, token };
        } finally {
            await this.disconnect();
        }
    }

    async loginBookmaker(bookmaker, credentials) {
        const loginMethods = {
            volcano: () => this.loginVolcano(credentials),
            sansabet: () => this.loginSansabet(credentials),
        };

        if (!loginMethods[bookmaker]) {
            throw new Error(`Unknown bookmaker: ${bookmaker}`);
        }

        return loginMethods[bookmaker]();
    }

    async extractCookies(driver) {
        const cookies = await driver.getCookies();
        return cookies.reduce((acc, c) => {
            acc[c.name] = c.value;
            return acc;
        }, {});
    }

    async extractLocalStorage(driver, keys) {
        return driver.execute((keys) => {
            const result = {};
            keys.forEach(key => {
                result[key] = localStorage.getItem(key);
            });
            return result;
        }, keys);
    }
}

module.exports = { AppiumLoginManager };
