'use strict';
/**
 * netClient - the ONE network layer of the launcher.
 *
 * Why this exists: school / managed networks (e.g. MEB-filtered Windows PCs)
 * enforce a system proxy for web traffic. Plain Node https/fetch ignores the
 * system proxy, so any download made through it silently dies while browsers
 * work fine. Everything that downloads routes through here:
 *
 *   - In the Electron main process it uses Chromium's network stack
 *     (net.request) which honours the configured session proxy.
 *   - In plain Node (tests, tooling) it falls back to global fetch.
 *
 * Response shape mimics web fetch: { ok, status, text(), json(),
 * arrayBuffer() } with an optional onProgress(total, received) callback for
 * size reporting. POST/PUT supported via { method, body }.
 */

let electronNet = null; // set by main via setElectronNet (keeps tests Node-only safe)
let electronSession = null;

function setElectronNet(net, session) {
    electronNet = net || null;
    electronSession = session || null;
}

function getElectronNet() {
    if (electronNet) return electronNet;
    try {
        const electron = require('electron');
        if (electron && electron.net && typeof electron.net.request === 'function') {
            electronNet = electron.net;
        }
        if (electron && electron.session) electronSession = electron.session || electronSession;
    } catch (_) { /* not in an electron context */ }
    return electronNet;
}

/**
 * Apply a proxy configuration to the Electron networking session.
 * config: { proxyMode: 'system'|'off'|'custom', proxyUrl: 'http://host:port' }
 * Returns true when applied, false when running outside Electron.
 */
function applyProxy(config) {
    const electron = (() => { try { return require('electron'); } catch (_) { return null; } })();
    if (!electron || !electron.session || !electron.session.defaultSession) return false;
    const mode = (config && config.proxyMode) || 'system';
    const url = String((config && config.proxyUrl) || '').trim();
    try {
        if (mode === 'off') {
            electron.session.defaultSession.setProxy({ mode: 'direct' });
        } else if (mode === 'custom' && url) {
            electron.session.defaultSession.setProxy({ mode: 'fixed_servers', proxyServer: url });
        } else {
            electron.session.defaultSession.setProxy({ mode: 'system' });
        }
        return true;
    } catch (e) {
        console.error('[netClient] applyProxy failed:', e.message);
        return false;
    }
}

/** Promise-based single request through Electron's network stack. */
function electronRequest(url, options = {}) {
    const net = electronNet;
    const session = electronSession;
    return new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;
        const request = net.request({
            method: options.method || 'GET',
            url: String(url),
            session: session || undefined,
            useSessionCookies: true
        });

        if (options.redirects !== false) request.setRedirects && request.setRedirects(10);
        try {
            const headers = options.headers || {};
            for (const [k, v] of Object.entries(headers)) {
                request.setHeader(k, String(v));
            }
        } catch (_) {}

        const timeoutMs = options.timeoutMs || 60000;
        timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                try { request.abort(); } catch (_) {}
                reject(new Error(`Request timed out after ${timeoutMs}ms: ${url}`));
            }
        }, timeoutMs);

        request.on('response', (response) => {
            const chunks = [];
            let received = 0;
            const declaredTotal = Number(response.headers && (response.headers['content-length'] || response.headers['Content-Length']) || 0) || 0;
            response.on('data', (chunk) => {
                chunks.push(Buffer.from(chunk));
                received += chunk.length;
                try { options.onProgress && options.onProgress(declaredTotal, received); } catch (_) {}
            });
            response.on('end', () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                const status = response.statusCode || 0;
                const body = Buffer.concat(chunks);
                resolve({
                    ok: status >= 200 && status < 300,
                    status,
                    headers: response.headers || {},
                    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
                    text: async () => body.toString('utf8'),
                    json: async () => JSON.parse(body.toString('utf8'))
                });
            });
            response.on('error', (e) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(e);
            });
        });

        request.on('error', (e) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(e);
        });

        if (options.body != null) request.write(String(options.body), 'utf8');
        request.end();
    });
}

/** Unified fetch: Electron net when available, global fetch otherwise. */
async function fetch(url, options = {}) {
    const net = getElectronNet();
    if (net) return electronRequest(url, options);
    // Node fallback (tests / tooling): wrap global fetch and add progress.
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutMs = options.timeoutMs || 60000;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
        const res = await globalThis.fetch(url, {
            method: options.method || 'GET',
            headers: options.headers,
            body: options.body,
            signal: controller ? controller.signal : undefined
        });
        if (options.onProgress) {
            const declared = Number(res.headers.get('content-length') || 0) || 0;
            const clone = res.clone();
            let received = 0;
            try {
                const reader = clone.body && clone.body.getReader();
                if (reader) {
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        received += value.byteLength;
                        options.onProgress(declared, received);
                    }
                }
            } catch (_) {}
        }
        return {
            ok: res.ok,
            status: res.status,
            headers: Object.fromEntries(res.headers.entries ? [...res.headers.entries()] : []),
            arrayBuffer: () => res.arrayBuffer(),
            text: () => res.text(),
            json: () => res.json()
        };
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/** Convenience GET returning parsed JSON, with a clear error on failure. */
async function fetchJson(url, options = {}) {
    const res = await fetch(url, { ...options, headers: { Accept: 'application/json', ...(options.headers || {}) } });
    if (!res.ok) throw new Error(`HTTP ${res.status} while fetching ${url}`);
    return res.json();
}

// ── Proxy for the classic Node https stack ────────────────────────────────
// The launcher's downloaders (fetchPool, modrinth, java installer, …) use
// https.get directly. Instead of rewriting every call site, this agent
// tunnels them through the configured HTTP CONNECT proxy transparently.
//
// `installNodeProxy(config)` monkeypatches https.get/https.request in the
// current process so every request carries the tunneling agent. With
// proxyMode 'system' we consult environment/system variables, falling back
// to 'direct' when nothing is configured (identical behaviour to today).
//
// Returns an undo() function for tests / settings changes.

const http = require('http');
const tls = require('tls');
const https = require('https');
const net = require('net');
const { URL } = globalThis;

class ProxyTunnelAgent extends https.Agent {
    constructor(proxyOptions = {}) {
        super({ rejectUnauthorized: proxyOptions.rejectUnauthorized !== false });
        this.proxyHost = proxyOptions.proxyHost || '127.0.0.1';
        this.proxyPort = proxyOptions.proxyPort || 8080;
        this.proxyAuth = proxyOptions.proxyAuth || null; // "user:pass"
        this.rejectUnauthorized = proxyOptions.rejectUnauthorized !== false;
    }

    createConnection(options, callback) {
        const host = options.host || options.hostname;
        const port = Number(options.port || 443);
        const lines = [`CONNECT ${host}:${port} HTTP/1.1`, `Host: ${host}:${port}`];
        if (typeof this.proxyAuth === 'string' && this.proxyAuth.length > 0 && this.proxyAuth.length < 200 && !/[\r\n]/.test(this.proxyAuth)) {
            lines.push(`Proxy-Authorization: Basic ${Buffer.from(this.proxyAuth).toString('base64')}`);
        }
        lines.push(`User-Agent: devLauncher-net/${require('../../package.json').version}`);
        lines.push('', '');
        const socket = net.connect({ host: this.proxyHost, port: this.proxyPort })
            .once('error', (e) => { try { callback(e); } catch (_) {} });
        socket.write(lines.join('\r\n'));
        let buffer = Buffer.alloc(0);
        const onData = (chunk) => {
            buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
            const idx = buffer.indexOf('\r\n\r\n');
            if (idx === -1 && buffer.length < 65536) return;
            socket.removeListener('data', onData);
            const nl = buffer.indexOf('\r\n');
            const line = buffer.slice(0, nl === -1 ? idx : nl).toString('utf8');
            if (!/HTTP\/1\.[01] 200/.test(line)) {
                socket.destroy();
                callback(new Error(`Proxy connection refused: ${line}`));
                return;
            }
            const servername = net.isIP(host) ? undefined : host;
            const tlsSocket = tls.connect({ socket, servername, rejectUnauthorized: this.rejectUnauthorized && true });
            callback(null, tlsSocket);
        };
        socket.on('data', onData);
    }
}

function deriveSystemProxyUrl() {
    // Windows: registry-driven proxies surface to Node only via env; respect env chain.
    return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '';
}

function parseProxyUrl(raw) {
    if (!raw) return null;
    try {
        const u = new URL(raw.includes('://') ? raw : `http://${raw}`);
        const auth = u.username || u.password ? `${u.username}:${u.password || ''}` : null;
        return { proxyHost: u.hostname, proxyPort: u.port ? Number(u.port) : 80, proxyAuth: auth, rawUrl: raw };
    } catch (_) {
        return null;
    }
}

let undoInstall = null;

/**
 * Wire the Node https stack through the configured proxy.
 * config.proxyMode: 'system' (default, uses HTTPS_PROXY env), 'off', 'custom'.
 * config.proxyUrl for custom, proxyUser/proxyPass for basic auth.
 */
function installNodeProxy(config = {}) {
    if (undoInstall) { undoInstall(); undoInstall = null; }
    const mode = (config && config.proxyMode) || 'system';
    let agent = null;

    if (mode === 'custom' && config.proxyUrl) {
        const parsed = parseProxyUrl(config.proxyUrl);
        if (parsed && config.proxyUser && config.proxyPass) {
            parsed.proxyAuth = `${String(config.proxyUser).replace(/:/g, '')}:${String(config.proxyPass).replace(/:/g, '')}`;
        }
        if (parsed) agent = new ProxyTunnelAgent({ ...parsed, rejectUnauthorized: config.tlsRejectUnauthorized !== false });
    } else if (mode === 'system') {
        const sys = deriveSystemProxyUrl();
        if (sys) agent = new ProxyTunnelAgent(parseProxyUrl(sys) || {});
    }

    if (!agent) return null;

    const origGet = https.get;
    const origRequest = https.request;
    const wrapRequest = (orig) => function patched(...args) {
        const last = args[args.length - 1];
        const isUrlFirst = typeof args[0] === 'string' || args[0] instanceof URL;
        if (isUrlFirst || typeof last === 'function') {
            // normalize into (urlOrOpts, opts, cb)
            let urlOrOpts = args[0];
            let opts = args[1];
            if (typeof opts !== 'object' || opts === null) {
                opts = {};
                args.splice(1, 0, opts);
                args[0] = urlOrOpts; args[1] = opts; // may have grown
            }
            if (!opts.agent) opts.agent = agent;
        } else if (last && typeof last === 'object') {
            if (!last.agent) last.agent = agent;
        } else if (args[0] && typeof args[0] === 'object' && !args[0].agent) {
            args[0].agent = agent;
        }
        return orig.apply(https, args);
    };
    https.get = wrapRequest(origGet);
    https.request = wrapRequest(origRequest);
    undoInstall = () => {
        https.get = origGet;
        https.request = origRequest;
    };
    return { agent, undo: () => { if (undoInstall) { undoInstall(); undoInstall = null; } } };
}

module.exports = { setElectronNet, applyProxy, fetch, fetchJson, electronRequest, ProxyTunnelAgent, installNodeProxy }
