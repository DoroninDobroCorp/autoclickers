/**
 * HealthServer - HTTP endpoint for health checks
 * 
 * Extracted from BaseBettor for better separation of concerns.
 * Provides /health endpoint for monitoring dashboards.
 */

const http = require('http');
const { URL } = require('url');

class HealthServer {
    constructor(options = {}) {
        this.port = options.port || 9999;
        this.logger = options.logger || console;
        this.getStatus = options.getStatus || (() => ({ status: 'ok' }));
        this.handlers = options.handlers || {};
        this.server = null;
    }

    /**
     * Start the health server
     */
    start() {
        if (this.server) {
            this.logger.log(`⚠️ Health server already running on port ${this.port}`);
            return Promise.resolve();
        }

        const server = http.createServer(async (req, res) => {
            try {
                const requestUrl = new URL(req.url, `http://127.0.0.1:${this.port}`);
                const routeKey = `${req.method.toUpperCase()} ${requestUrl.pathname}`;

                if (routeKey === 'GET /health') {
                    const status = this.getStatus();
                    const isHealthy = status.status === 'ok' && !status.loginError;
                    const httpStatus = isHealthy ? 200 : 503;

                    res.writeHead(httpStatus, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(status));
                    return;
                }

                const handler = this.handlers[routeKey];
                if (!handler) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'error', error: 'Not found' }));
                    return;
                }

                const body = await this._readBody(req);
                const result = await handler({
                    method: req.method.toUpperCase(),
                    path: requestUrl.pathname,
                    query: Object.fromEntries(requestUrl.searchParams.entries()),
                    headers: req.headers,
                    body,
                    rawRequest: req
                });

                const httpStatus = result?.status || 200;
                const headers = result?.headers || { 'Content-Type': 'application/json' };
                const payload = result?.body !== undefined ? result.body : result;

                res.writeHead(httpStatus, headers);
                res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'error', error: e.message }));
            }
        });

        this.server = server;

        return new Promise((resolve, reject) => {
            const logError = (e) => {
                if (e.code === 'EADDRINUSE') {
                    this.logger.error(`❌ Port ${this.port} already in use`);
                } else {
                    this.logger.error(`Health server error: ${e.message}`);
                }
            };

            const onStartupError = (e) => {
                logError(e);
                server.removeListener('listening', onListening);
                if (this.server === server) {
                    this.server = null;
                }
                try { server.close(); } catch (_closeError) {}
                reject(e);
            };

            const onListening = () => {
                server.removeListener('error', onStartupError);
                server.on('error', logError);
                this.logger.log(`🏥 Health check on port ${this.port}`);
                resolve();
            };

            server.once('error', onStartupError);
            server.once('listening', onListening);
            server.listen(this.port);
        });
    }

    /**
     * Stop the health server
     */
    stop() {
        if (this.server) {
            const server = this.server;
            this.server = null;
            return new Promise((resolve) => {
                server.close(() => {
                    this.logger.log('🏥 Health server stopped');
                    resolve();
                });
            });
        }
        return Promise.resolve();
    }

    /**
     * Check if server is running
     */
    isRunning() {
        return this.server !== null;
    }

    _readBody(req) {
        return new Promise((resolve, reject) => {
            if (req.method === 'GET' || req.method === 'HEAD') {
                resolve(null);
                return;
            }

            let raw = '';
            req.on('data', (chunk) => {
                raw += chunk;
            });
            req.on('end', () => {
                if (!raw) {
                    resolve(null);
                    return;
                }

                const contentType = req.headers['content-type'] || '';
                if (contentType.includes('application/json')) {
                    try {
                        resolve(JSON.parse(raw));
                    } catch (e) {
                        reject(new Error(`Invalid JSON body: ${e.message}`));
                    }
                    return;
                }

                resolve(raw);
            });
            req.on('error', reject);
        });
    }
}

module.exports = { HealthServer };
