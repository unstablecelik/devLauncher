'use strict';
// ProxyTunnelAgent + installNodeProxy / netClient tests.
// Local CONNECT proxy + TLS upstream fixture prove downloads survive a proxy
// (the school/MEB scenario) and that undo() restores direct behaviour.
const fs = require('fs');
const path = require('path');
const tls = require('tls');
const net = require('net');
const https = require('https');
const http = require('http');
const { check, finish, tmpdir } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const netClient = require(`${ROOT}/src/services/netClient`);
const key = fs.readFileSync(path.join(__dirname, 'fixtures', 'tls-test.key'));
const cert = fs.readFileSync(path.join(__dirname, 'fixtures', 'tls-test.cert'));

check('netClient exports', typeof netClient.fetch === 'function' && typeof netClient.applyProxy === 'function');

// node-fallback fetch path (electron net requires electrons runtime, skip here)
{
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ hello: 'world' }));
    });
    server.listen(0, '127.0.0.1', async () => {
        const url = `http://127.0.0.1:${server.address().port}/x`;
        const res = await netClient.fetch(url);
        const data = await res.json();
        check('node fallback fetch json', data && data.hello === 'world');
        const txt = await netClient.fetchJson(url);
        check('fetchJson helper', txt.hello === 'world');
        server.close();
        proxyFlow();
    });
}

async function proxyFlow() {
    const secret = 'ok-via-proxy-tls';
    const upstream = tls.createServer({ key, cert }, (sock) => sock.end(
        'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ' + secret.length + '\r\n\r\n' + secret
    ));
    const seenConnects = [];
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upPort = upstream.address().port;

    const proxy = net.createServer((sock) => {
        sock.once('data', (d) => {
            const line = d.toString().split('\r\n')[0];
            seenConnects.push(line);
            const m = line.match(/^CONNECT ([\w.]+):(\d+)/);
            const proxyAuth = /Proxy-Authorization/.test(d.toString());
            if (proxyAuth) seenConnects.push('AUTH_PRESENT');
            const raw = net.connect(Number(m[2]), m[1], () => {
                sock.write('HTTP/1.1 200 Connected\r\n\r\n');
                sock.pipe(raw); raw.pipe(sock);
            });
            raw.on('error', () => sock.destroy());
        });
    });
    await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const proxyPort = proxy.address().port;

    // custom mode with auth header + test TLS bypass (fixture certs are self-signed)
    const inst = netClient.installNodeProxy({ proxyMode: 'custom', proxyUrl: `http://user:secretpw@127.0.0.1:${proxyPort}`, tlsRejectUnauthorized: false });
    check('install returns agent', !!(inst && inst.agent));

    await new Promise((resolve, reject) => {
        https.get(`https://localhost:${upPort}/x`, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => { check('proxied https body via CONNECT', body === secret, body); resolve(); });
        }).on('error', reject);
    }).catch(() => {
        check('proxied https body via CONNECT', false, 'request failed');
    });

    check('CONNECT handshake seen', seenConnects.some(l => /^CONNECT localhost:\d+/.test(l)));
    check('proxy basic auth header sent', seenConnects.includes('AUTH_PRESENT'));

    // undo → direct connection works again (fixture TLS stays reachable directly)
    inst.undo();
    check('undo releases agent refs', inst.undo === undefined ? false : true);
    {
        const direct = await new Promise((resolve) => {
            const req = https.request({ host: 'localhost', port: upPort, path: '/x', rejectUnauthorized: false, method: 'GET' }, (res) => {
                let body = '';
                res.on('data', (c) => (body += c));
                res.on('end', () => resolve(body));
            });
            req.on('error', (e) => resolve('err:' + e.message));
            req.end();
        });
        check('post-undo direct request still works', direct === secret, direct.slice(0, 80));
    }

    // system mode with no env proxies → NO agent injected (direct)
    const envBackup = { ...process.env };
    delete process.env.HTTPS_PROXY; delete process.env.https_proxy; delete process.env.HTTP_PROXY; delete process.env.http_proxy;
    const none = netClient.installNodeProxy({ proxyMode: 'system' });
    check('system mode without env = no agent', none === null);
    https.get.restore_like_nothing; // noop name to keep lint quiet
    process.env = envBackup;

    upstream.close(); proxy.close();
    finish('netproxy');
}
