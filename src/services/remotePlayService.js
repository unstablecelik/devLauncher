const fs = require('fs');
const path = require('path');
const https = require('https');

// ── Remote Play service ─────────────────────────────────────────────────────
// The launcher never streams video itself. Scope (Phase 3 v1):
//   • detect a Sunshine host install (config dir + apps.json + web UI port)
//   • add/refresh a "devLauncher" app entry in Sunshine's apps.json so the
//     streamer can open devLauncher with --launch-instance=<id>
//   • pair a Moonlight PIN through Sunshine's local HTTPS API (port 47990),
//     using credentials from sunshine_state.json when readable
//   • open the Sunshine web UI in a browser as the graceful fallback
//
// Moonlight itself lives on the CLIENT device, so nothing is configured here;
// the UI only shows instructions + links.

class RemotePlayService {
    constructor(homeDir) {
        this.home = homeDir || require('os').homedir();
        this.port = 47990; // Sunshine default
    }

    // ── Detection ───────────────────────────────────────────────────────────
    static configCandidates(home, platform) {
        const c = [];
        if (platform === 'win32') {
            const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
            c.push(path.join(localAppData, 'Sunshine'));
            c.push(path.join(home, 'AppData', 'Local', 'Sunshine'));
            c.push('C:\\Program Files\\Sunshine\\config');
        } else if (platform === 'darwin') {
            c.push(path.join(home, 'Library', 'Application Support', 'Sunshine'));
            c.push(path.join(home, '.config', 'sunshine'));
        } else {
            c.push(path.join(home, '.config', 'sunshine'));
            const xdg = process.env.XDG_CONFIG_HOME;
            if (xdg && xdg !== home) c.push(path.join(xdg, 'sunshine'));
        }
        return c;
    }

    detect() {
        const opts = this.configCandidatesOf(this.home);
        for (const dir of opts) {
            const conf = path.join(dir, 'sunshine.conf');
            const apps = path.join(dir, 'apps.json');
            if (fs.existsSync(conf) || fs.existsSync(apps)) {
                return {
                    found: true,
                    platform: this.platform(),
                    configDir: dir,
                    appsJsonPath: fs.existsSync(apps) ? apps : null,
                    webUrl: `https://127.0.0.1:${this.port}`,
                    binaryPath: this.locateBinary()
                };
            }
        }
        return {
            found: false,
            platform: this.platform(),
            configDir: null,
            appsJsonPath: null,
            webUrl: `https://127.0.0.1:${this.port}`,
            binaryPath: this.locateBinary()
        };
    }

    // instance-agnostic helpers kept pure for tests
    configCandidatesOf(home) {
        return RemotePlayService.configCandidates(home, this.platform());
    }

    platform() {
        return process.platform;
    }

    locateBinary() {
        // Pure filesystem probe - no shell/PATH-spawning (the project keeps a
        // no-shell-command posture). Known install locations + PATH listing.
        if (process.platform !== 'win32') {
            for (const cmd of ['/usr/bin/sunshine', '/usr/local/bin/sunshine', '/opt/Sunshine/sunshine']) {
                try {
                    if (fs.existsSync(cmd)) return cmd;
                } catch (_) {}
            }
            for (const dir of String(process.env.PATH || '').split(':')) {
                try {
                    const candidate = path.join(dir, 'sunshine');
                    if (dir && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
                } catch (_) {}
            }
            return null;
        }
        for (const p of [
            'C:\\Program Files\\Sunshine\\sunshine.exe',
            'C:\\Program Files (x86)\\Sunshine\\sunshine.exe'
        ]) {
            try { if (fs.existsSync(p)) return p; } catch (_) {}
        }
        return null;
    }

    // ── apps.json merge (pure) ──────────────────────────────────────────────
    /**
     * Merge a devLauncher app entry into a parsed apps.json. Sunshine tolerates
     * extra keys; we keep every other app untouched and replace any prior
     * entry with the same name.
     */
    static mergeAppEntry(existing, appEntry) {
        const json = {
            name: (existing && existing.name) || 'Sunshine Config',
            ...(existing || {}),
            apps: existing && Array.isArray(existing.apps) ? [...existing.apps] : []
        };
        const idx = json.apps.findIndex(a => a && a.name === appEntry.name);
        if (idx >= 0) json.apps[idx] = appEntry;
        else json.apps.push(appEntry);
        return json;
    }

    /**
     * Build the app entry for one instance. The cmd re-opens devLauncher with
     * an auto-launch flag (main.js handles --launch-instance after ready).
     */
    static buildAppEntry(binaryPath, instanceId, instanceName) {
        const cmd = instanceId
            ? `${binaryPath} --launch-instance=${String(instanceId)}`
            : binaryPath;
        return {
            name: instanceName ? `devLauncher — ${instanceName}` : 'devLauncher',
            cmd,
            'image-path': '',
            output: '',
            'exclude-global-prep-cmd': true,
            env: {},
            detached: [],
            'prep-cmd': []
        };
    }

    writeAppsJson(appsJsonPath, appEntry) {
        if (!appsJsonPath || !fs.existsSync(appsJsonPath)) {
            return { ok: false, error: 'apps.json not found (Sunshine may need a config init)' };
        }
        try {
            const backup = appsJsonPath + '.devlauncher-backup';
            if (!fs.existsSync(backup)) fs.copyFileSync(appsJsonPath, backup);
            const existing = JSON.parse(fs.readFileSync(appsJsonPath, 'utf8'));
            const merged = RemotePlayService.mergeAppEntry(existing, appEntry);
            fs.writeFileSync(appsJsonPath, JSON.stringify(merged, null, 2));
            // Sunshine reloads apps.json automatically on change
            return { ok: true, path: appsJsonPath, backup };
        } catch (err) {
            return { ok: false, error: `apps.json merge failed: ${err.message}` };
        }
    }

    // ── PIN pairing ─────────────────────────────────────────────────────────
    /**
     * Credentials live in sunshine_state.json on recent Sunshine versions.
     * Key names changed over time — try the known variants.
     */
    static credsFromState(stateJson) {
        if (!stateJson || typeof stateJson !== 'object') return null;
        const keys = [
            ['api_user', 'api_pass'],
            ['api_username', 'api_password'],
            ['username', 'password'],
            ['user', 'pass'],
            ['auth_user', 'auth_pass']
        ];
        for (const [u, p] of keys) {
            if (stateJson[u] && stateJson[p]) return { user: String(stateJson[u]), pass: String(stateJson[p]) };
        }
        return null;
    }

    readStateCreds() {
        const detected = this.detect();
        if (!detected.configDir) return null;
        for (const name of ['sunshine_state.json', 'state.json']) {
            const p = path.join(detected.configDir, name);
            if (fs.existsSync(p)) {
                try {
                    const creds = RemotePlayService.credsFromState(JSON.parse(fs.readFileSync(p, 'utf8')));
                    if (creds) return creds;
                } catch (_) {}
            }
        }
        return null;
    }

    /**
     * POST the Moonlight PIN to Sunshine's local API. Self-signed cert is
     * accepted (localhost only). Returns { ok, status, body }.
     */
    async pairPin(pinRaw, credsOverride) {
        const pin = String(pinRaw || '').trim();
        if (!/^\d{4,10}$/.test(pin)) {
            return { ok: false, error: 'PIN must be 4-10 digits (Moonlight shows it on screen)' };
        }
        const creds = credsOverride || this.readStateCreds();
        if (!creds) {
            return { ok: false, manual: true, error: 'Sunshine API credentials unreadable — pair it in the web UI (Open Sunshine UI button).' };
        }
        const payload = JSON.stringify({ pin });
        const result = await new Promise((resolve) => {
            const req = https.request({
                host: '127.0.0.1',
                port: this.port,
                path: '/api/pin',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                    Authorization: 'Basic ' + Buffer.from(`${creds.user}:${creds.pass}`).toString('base64')
                },
                rejectUnauthorized: false,
                timeout: 8000
            }, (res) => {
                let data = '';
                res.on('data', c => { data += c; });
                res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: data.slice(0, 300) }));
            });
            req.on('error', err => resolve({ ok: false, error: `Sunshine unreachable: ${err.message}` }));
            req.on('timeout', () => req.destroy(new Error('timeout')));
            req.end(payload);
        });
        return result;
    }
}

module.exports = RemotePlayService;
