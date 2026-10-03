'use strict';

const WebSocket = require('ws');

const DEFAULT_SWARM_URL = 'wss://eu-swarm-newm.vbet.ua/';
const DEFAULT_SITE_ID = 18746530;
const DEFAULT_SOURCE = 42;
const DEFAULT_RELEASE_DATE = '06/04/2026-14:19';

function buildProxyUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;

    const parts = raw.split(':');
    if (parts.length === 4) {
        const [host, port, username, password] = parts;
        return `socks5://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
    }
    if (parts.length === 2) {
        return `socks5://${raw}`;
    }
    return raw;
}

class SwarmClient {
    constructor(options = {}) {
        this.swarmUrl = options.swarmUrl || DEFAULT_SWARM_URL;
        this.language = options.language || 'ukr';
        this.siteId = Number(options.siteId || DEFAULT_SITE_ID);
        this.source = Number(options.source || DEFAULT_SOURCE);
        this.releaseDate = options.releaseDate || DEFAULT_RELEASE_DATE;
        this.requestTimeoutMs = options.requestTimeoutMs || 15000;
        this.logger = options.logger || console;
        this.proxyUrl = buildProxyUrl(options.proxyUrl || options.proxy);
        this.WebSocketClass = options.WebSocketClass || WebSocket;

        this.ws = null;
        this.connected = false;
        this.sessionStarted = false;
        this.loggedIn = false;
        this.sessionData = null;
        this.loginData = null;
        this._rid = 0;
        this._pending = new Map();
    }

    async connect() {
        if (this.connected && this.ws && this.ws.readyState === this.WebSocketClass.OPEN) {
            return true;
        }

        const wsOptions = {};
        if (this.proxyUrl) {
            wsOptions.agent = await this._createSocksProxyAgent(this.proxyUrl);
        }

        await new Promise((resolve, reject) => {
            const ws = new this.WebSocketClass(this.swarmUrl, wsOptions);
            this.ws = ws;

            const timer = setTimeout(() => {
                reject(new Error(`VBet Swarm connect timeout after ${this.requestTimeoutMs}ms`));
                try { ws.terminate(); } catch (_) {}
            }, this.requestTimeoutMs);

            ws.on('open', () => {
                clearTimeout(timer);
                this.connected = true;
                try { ws._socket?.unref?.(); } catch (_) {}
                resolve();
            });

            ws.on('message', (payload) => this._handleMessage(payload));

            ws.on('close', () => {
                this.connected = false;
                this.sessionStarted = false;
                this.loggedIn = false;
                this._rejectPending(new Error('VBet Swarm connection closed'));
            });

            ws.on('error', (error) => {
                clearTimeout(timer);
                if (!this.connected) {
                    reject(error);
                    return;
                }
                this.logger?.log?.(`VBet Swarm error: ${error.message}`);
            });
        });

        return true;
    }

    async requestSession() {
        await this.connect();
        if (this.sessionStarted) {
            return this.sessionData;
        }

        const response = await this.request('request_session', {
            language: this.language,
            site_id: this.siteId,
            source: this.source,
            release_date: this.releaseDate,
        });

        this._assertOk(response, 'request_session');
        this.sessionStarted = true;
        this.sessionData = response.data || null;
        return this.sessionData;
    }

    async login({ username, password } = {}) {
        await this.requestSession();
        if (this.loggedIn) {
            return this.loginData;
        }
        if (!username || !password) {
            throw new Error('VBet credentials are missing');
        }

        const response = await this.request('login', {
            username,
            password,
            login_type: 2,
        });

        this._assertOk(response, 'login');
        this.loggedIn = true;
        this.loginData = response.data || null;
        return this.loginData;
    }

    async get(params) {
        await this.requestSession();
        const response = await this.request('get', {
            subscribe: false,
            ...params,
        });
        this._assertOk(response, 'get');
        return response.data || null;
    }

    async command(command, params = {}) {
        await this.requestSession();
        const response = await this.request(command, params);
        this._assertOk(response, command);
        return response;
    }

    request(command, params = {}) {
        if (!this.ws || this.ws.readyState !== this.WebSocketClass.OPEN) {
            return Promise.reject(new Error('VBet Swarm is not connected'));
        }

        const rid = String(++this._rid);
        const payload = JSON.stringify({ command, params, rid });

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._pending.delete(rid);
                reject(new Error(`VBet Swarm request timeout: ${command}`));
            }, this.requestTimeoutMs);

            this._pending.set(rid, { resolve, reject, timer, command });
            this.ws.send(payload, (error) => {
                if (!error) return;
                clearTimeout(timer);
                this._pending.delete(rid);
                reject(error);
            });
        });
    }

    close() {
        this._rejectPending(new Error('VBet Swarm client closed'));
        if (this.ws) {
            try { this.ws.close(); } catch (_) {}
            try { this.ws.terminate(); } catch (_) {}
            try { this.ws._socket?.unref?.(); } catch (_) {}
            try { this.ws._socket?.destroy(); } catch (_) {}
            this.ws = null;
        }
        this.connected = false;
        this.sessionStarted = false;
        this.loggedIn = false;
    }

    _handleMessage(payload) {
        let message;
        try {
            message = JSON.parse(payload);
        } catch (error) {
            this.logger?.log?.(`VBet Swarm non-JSON message ignored: ${error.message}`);
            return;
        }

        const rid = message && message.rid !== undefined ? String(message.rid) : null;
        if (!rid || !this._pending.has(rid)) {
            return;
        }

        const pending = this._pending.get(rid);
        this._pending.delete(rid);
        clearTimeout(pending.timer);
        pending.resolve(message);
    }

    _rejectPending(error) {
        for (const pending of this._pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this._pending.clear();
    }

    _assertOk(response, command) {
        if (!response || response.code !== 0) {
            const code = response?.code ?? 'unknown';
            const message = response?.msg || response?.message || response?.error || JSON.stringify(response || {});
            throw new Error(`VBet Swarm ${command} failed: code=${code} ${message}`);
        }
    }

    async _createSocksProxyAgent(proxyUrl) {
        const mod = await import('socks-proxy-agent');
        const SocksProxyAgent = mod.SocksProxyAgent || mod.default;
        return new SocksProxyAgent(proxyUrl);
    }
}

module.exports = {
    SwarmClient,
    buildProxyUrl,
    DEFAULT_SWARM_URL,
    DEFAULT_SITE_ID,
    DEFAULT_SOURCE,
    DEFAULT_RELEASE_DATE,
};
