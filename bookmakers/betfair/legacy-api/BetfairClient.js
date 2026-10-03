'use strict';

const http = require('http');
const https = require('https');

const DEFAULT_BETTING_ENDPOINT = 'https://api.betfair.com/exchange/betting/json-rpc/v1';
const DEFAULT_ACCOUNT_ENDPOINT = 'https://api.betfair.com/exchange/account/json-rpc/v1';
const DEFAULT_LOGIN_ENDPOINT = 'https://identitysso.betfair.com/api/login';
const DEFAULT_KEEP_ALIVE_ENDPOINT = 'https://identitysso.betfair.com/api/keepAlive';
const DEFAULT_APP_CONFIG_URL = 'https://www.betfair.com/exchange/plus/football';
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36';

class BetfairClientError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'BetfairClientError';
        Object.assign(this, details);
    }
}

function maskProxyUrl(value) {
    if (!value) return '';
    return String(value).replace(/\/\/([^:@/]+):([^@/]+)@/, '//***:***@');
}

function normalizeProxyUrl(value, defaultProtocol = 'http') {
    if (!value) return '';
    if (typeof value === 'object') {
        const host = value.host || value.hostname;
        const port = value.port;
        if (!host || !port) return '';
        const protocol = String(value.protocol || value.scheme || defaultProtocol).replace(/:$/, '');
        const auth = value.username
            ? `${encodeURIComponent(value.username)}:${encodeURIComponent(value.password || '')}@`
            : '';
        return `${protocol}://${auth}${host}:${port}`;
    }

    const raw = String(value).trim();
    if (!raw) return '';
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;

    const parts = raw.split(':');
    if (parts.length >= 4) {
        const [host, port, username, ...passwordParts] = parts;
        const password = passwordParts.join(':');
        return `${defaultProtocol}://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
    }
    if (parts.length === 2) {
        return `${defaultProtocol}://${parts[0]}:${parts[1]}`;
    }
    return raw;
}

class BetfairClient {
    constructor(config = {}) {
        this.config = config;
        this.logger = config.logger || console;
        this.fetchImpl = config.fetchImpl || globalThis.fetch;
        if (typeof this.fetchImpl !== 'function') {
            throw new Error('BetfairClient requires fetch support or config.fetchImpl');
        }

        this.appKey = config.appKey || process.env.BETFAIR_APP_KEY || '';
        this.sessionToken = config.sessionToken || process.env.BETFAIR_SESSION_TOKEN || '';
        this.bettingEndpoint = config.bettingEndpoint || DEFAULT_BETTING_ENDPOINT;
        this.accountEndpoint = config.accountEndpoint || DEFAULT_ACCOUNT_ENDPOINT;
        this.loginEndpoint = config.loginEndpoint || DEFAULT_LOGIN_ENDPOINT;
        this.keepAliveEndpoint = config.keepAliveEndpoint || DEFAULT_KEEP_ALIVE_ENDPOINT;
        this.appConfigUrl = config.appConfigUrl || process.env.BETFAIR_APP_CONFIG_URL || DEFAULT_APP_CONFIG_URL;
        this.autoDiscoverAppKey = config.autoDiscoverAppKey !== false && process.env.BETFAIR_AUTO_DISCOVER_APP_KEY !== '0';
        this.userAgent = config.userAgent || process.env.BETFAIR_USER_AGENT || DEFAULT_USER_AGENT;
        this.timeoutMs = Number(config.requestTimeoutMs || config.httpTimeoutMs || 15000);
        this.defaultProxyProtocol = config.proxyProtocol || process.env.BETFAIR_PROXY_PROTOCOL || 'socks5';
        this.proxyUrl = normalizeProxyUrl(config.proxyUrl || config.proxy || process.env.BETFAIR_PROXY || '', this.defaultProxyProtocol);
        this.dispatcher = config.dispatcher || null;
        this._jsonRpcId = 1;
        this._createdDispatcher = null;
        this._createdNodeAgent = null;
    }

    async login(credentials = {}) {
        await this._ensureAppKey();
        if (this.sessionToken && credentials.forceRefresh !== true) {
            return { token: this.sessionToken, status: 'SUCCESS', reused: true };
        }
        if (credentials.forceRefresh === true) {
            this.sessionToken = '';
        }

        const username = credentials.username || this.config.credentials?.username || process.env.BETFAIR_USERNAME || '';
        const password = credentials.password || this.config.credentials?.password || process.env.BETFAIR_PASSWORD || '';
        if (!username || !password) {
            throw new BetfairClientError('Betfair credentials missing: set BETFAIR_SESSION_TOKEN or BETFAIR_USERNAME/BETFAIR_PASSWORD');
        }

        const body = new URLSearchParams({ username, password }).toString();
        const response = await this._request(this.loginEndpoint, {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-Application': this.appKey,
            },
            body,
        });

        const status = String(response.json?.status || '').toUpperCase();
        const token = response.json?.token || response.json?.sessionToken || '';
        if (status !== 'SUCCESS' || !token) {
            const message = response.json?.error || response.json?.loginStatus || response.text || 'Betfair login failed';
            throw new BetfairClientError(message, { response: response.json || response.text, status });
        }

        this.sessionToken = token;
        return { token, status };
    }

    async keepAlive() {
        await this._ensureAuthenticated();
        const response = await this._request(this.keepAliveEndpoint, {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'X-Application': this.appKey,
                'X-Authentication': this.sessionToken,
            },
        });
        const status = String(response.json?.status || '').toUpperCase();
        if (status && status !== 'SUCCESS') {
            throw new BetfairClientError(response.json?.error || response.text || 'Betfair keepAlive failed', {
                response: response.json || response.text,
            });
        }
        return response.json || {};
    }

    async getAccountFunds(params = {}) {
        return this.jsonRpc('account', 'getAccountFunds', params);
    }

    async listMarketCatalogue(params = {}) {
        return this.jsonRpc('betting', 'listMarketCatalogue', params);
    }

    async listMarketBook(params = {}) {
        return this.jsonRpc('betting', 'listMarketBook', params);
    }

    async placeOrders(params = {}) {
        return this.jsonRpc('betting', 'placeOrders', params);
    }

    async jsonRpc(service, method, params = {}) {
        await this._ensureAuthenticated();
        const endpoint = service === 'account' ? this.accountEndpoint : this.bettingEndpoint;
        const namespace = service === 'account' ? 'AccountAPING' : 'SportsAPING';
        const payload = {
            jsonrpc: '2.0',
            method: `${namespace}/v1.0/${method}`,
            params,
            id: this._jsonRpcId++,
        };
        const response = await this._request(endpoint, {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'X-Application': this.appKey,
                'X-Authentication': this.sessionToken,
            },
            body: JSON.stringify(payload),
        });
        const json = response.json;
        if (json?.error) {
            throw new BetfairClientError(this._formatJsonRpcError(json.error), {
                code: json.error.code,
                data: json.error.data,
                response: json,
            });
        }
        if (!json || !Object.prototype.hasOwnProperty.call(json, 'result')) {
            throw new BetfairClientError('Betfair JSON-RPC response did not include result', {
                response: json || response.text,
            });
        }
        return json.result;
    }

    async discoverAppKey() {
        const response = await this._request(this.appConfigUrl, {
            method: 'GET',
            headers: {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'User-Agent': this.userAgent,
            },
        });
        const appKey = this._extractAppKeyFromHtml(response.text);
        if (!appKey) {
            throw new BetfairClientError('Betfair web app key was not found in exchange HTML');
        }
        this.appKey = appKey;
        return appKey;
    }

    async close() {
        const dispatcher = this._createdDispatcher || this.dispatcher;
        if (dispatcher && typeof dispatcher.close === 'function') {
            await dispatcher.close();
        } else if (dispatcher && typeof dispatcher.destroy === 'function') {
            dispatcher.destroy();
        }
        this._createdDispatcher = null;
        if (this._createdNodeAgent && typeof this._createdNodeAgent.destroy === 'function') {
            this._createdNodeAgent.destroy();
        }
        this._createdNodeAgent = null;
    }

    async _request(url, options = {}) {
        if (this.proxyUrl && /^socks/i.test(this.proxyUrl)) {
            return this._requestWithNodeAgent(url, options, await this._getNodeAgent());
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const fetchOptions = {
                ...options,
                signal: controller.signal,
            };
            const dispatcher = await this._getDispatcher();
            if (dispatcher) {
                fetchOptions.dispatcher = dispatcher;
            }

            const response = await this.fetchImpl(url, fetchOptions);
            const text = await response.text();
            let json = null;
            try { json = text ? JSON.parse(text) : null; } catch (_) {}

            if (!response.ok) {
                throw new BetfairClientError(`Betfair HTTP ${response.status}: ${text || response.statusText}`, {
                    status: response.status,
                    response: json || text,
                });
            }
            return { status: response.status, ok: response.ok, text, json, headers: response.headers };
        } catch (error) {
            if (error.name === 'AbortError') {
                throw new BetfairClientError(`Betfair request timeout after ${this.timeoutMs}ms`, { timeout: true });
            }
            if (error instanceof BetfairClientError) throw error;
            const suffix = this.proxyUrl ? ` via proxy ${maskProxyUrl(this.proxyUrl)}` : '';
            throw new BetfairClientError(`Betfair request failed${suffix}: ${error.message || error}`, { cause: error });
        } finally {
            clearTimeout(timeout);
        }
    }

    async _getDispatcher() {
        if (this.dispatcher) return this.dispatcher;
        if (!this.proxyUrl) return null;
        if (this._createdDispatcher) return this._createdDispatcher;
        if (/^socks/i.test(this.proxyUrl)) {
            return null;
        }

        let undici;
        try {
            undici = await import('undici');
        } catch (error) {
            throw new BetfairClientError('Betfair proxy support requires the undici package', { cause: error });
        }
        const ProxyAgent = undici.ProxyAgent || undici.default?.ProxyAgent;
        if (!ProxyAgent) {
            throw new BetfairClientError('Betfair proxy support requires undici.ProxyAgent');
        }
        this._createdDispatcher = new ProxyAgent(this.proxyUrl);
        return this._createdDispatcher;
    }

    async _getNodeAgent() {
        if (this._createdNodeAgent) return this._createdNodeAgent;
        let mod;
        try {
            mod = await import('socks-proxy-agent');
        } catch (error) {
            throw new BetfairClientError('Betfair SOCKS proxy support requires the socks-proxy-agent package', { cause: error });
        }
        const SocksProxyAgent = mod.SocksProxyAgent || mod.default;
        if (!SocksProxyAgent) {
            throw new BetfairClientError('Betfair SOCKS proxy support requires socks-proxy-agent.SocksProxyAgent');
        }
        this._createdNodeAgent = new SocksProxyAgent(this.proxyUrl);
        return this._createdNodeAgent;
    }

    _requestWithNodeAgent(url, options = {}, agent) {
        return new Promise((resolve, reject) => {
            const target = new URL(url);
            const body = options.body;
            const headers = { ...(options.headers || {}) };
            if (body !== undefined && body !== null && !headers['content-length'] && !headers['Content-Length']) {
                headers['Content-Length'] = Buffer.byteLength(String(body));
            }
            const requestOptions = {
                protocol: target.protocol,
                hostname: target.hostname,
                port: target.port || (target.protocol === 'https:' ? 443 : 80),
                path: `${target.pathname}${target.search}`,
                method: options.method || 'GET',
                headers,
                agent,
            };
            const lib = target.protocol === 'https:' ? https : http;
            const req = lib.request(requestOptions, (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    let json = null;
                    try { json = text ? JSON.parse(text) : null; } catch (_) {}
                    const status = res.statusCode || 0;
                    if (status < 200 || status >= 300) {
                        reject(new BetfairClientError(`Betfair HTTP ${status}: ${text || res.statusMessage}`, {
                            status,
                            response: json || text,
                        }));
                        return;
                    }
                    resolve({ status, ok: true, text, json, headers: res.headers });
                });
            });
            req.setTimeout(this.timeoutMs, () => {
                req.destroy(new BetfairClientError(`Betfair request timeout after ${this.timeoutMs}ms`, { timeout: true }));
            });
            req.on('error', (error) => {
                if (error instanceof BetfairClientError) {
                    reject(error);
                    return;
                }
                const suffix = this.proxyUrl ? ` via proxy ${maskProxyUrl(this.proxyUrl)}` : '';
                reject(new BetfairClientError(`Betfair request failed${suffix}: ${error.message || error}`, { cause: error }));
            });
            if (body !== undefined && body !== null) req.write(String(body));
            req.end();
        });
    }

    async _ensureAppKey() {
        if (this.appKey) return;
        if (this.autoDiscoverAppKey) {
            await this.discoverAppKey();
        }
        if (!this.appKey) {
            throw new BetfairClientError('Betfair app key missing: set BETFAIR_APP_KEY');
        }
    }

    async _ensureAuthenticated() {
        await this._ensureAppKey();
        if (!this.sessionToken) {
            throw new BetfairClientError('Betfair session token missing: call login() or set BETFAIR_SESSION_TOKEN');
        }
    }

    _extractAppKeyFromHtml(html) {
        const text = String(html || '');
        const appKeyIndex = text.indexOf('"appKey"');
        const appKeyBlock = appKeyIndex >= 0 ? text.slice(appKeyIndex, appKeyIndex + 1200) : text;
        const platformOrder = process.platform === 'linux'
            ? ['Linux', 'EDSKey']
            : process.platform === 'darwin'
                ? ['Macintosh', 'EDSKey']
                : ['Windows NT', 'EDSKey'];
        for (const label of platformOrder) {
            const pattern = new RegExp(`"${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:\\s*"([^"]+)"`);
            const match = appKeyBlock.match(pattern);
            if (match) return match[1];
        }
        const generic = appKeyBlock.match(/"EDSKey"\s*:\s*"([^"]+)"/);
        return generic ? generic[1] : '';
    }

    _formatJsonRpcError(error = {}) {
        const data = error.data || {};
        const details = [
            data.exceptionname,
            data.APINGException?.errorCode,
            data.APINGException?.errorDetails,
            error.message,
        ].filter(Boolean);
        return details.join(': ') || 'Betfair JSON-RPC error';
    }
}

module.exports = {
    BetfairClient,
    BetfairClientError,
    normalizeProxyUrl,
    maskProxyUrl,
};
