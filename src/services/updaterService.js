const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { app } = require('electron');
const {
    compareVersions, stripTag, zipArtifactName, setupArtifactName,
    pickAsset, assetUrl, parseSha256Sums, resolveUpdateMode,
    buildInnoUpdateArgs
} = require('../utils/appUpdate');
const { runPortableSwap } = require('../utils/portableSwap');
const { spawn } = require('child_process');

// ── Self-Update service ─────────────────────────────────────────────────────
// The classic Electron auto-update stack only covers NSIS/MSI-style targets
// and cannot run an Inno Setup installer, so the pipeline is self-hosted:
//
//   check  → GitHub "releases/latest" (tag_name vs package.json version)
//   fetch  → the matching artifact for THIS install shape, with an optional
//            SHA256SUMS-asset verification and download progress events
//   apply  → installed  : run Setup with /VERYSILENT … and let the Restart
//                        Manager swap the files and relaunch the launcher
//            portable  : extract the new zip into `<appdir>/.update-staging`,
//                        spawn a detached second copy with --apply-update and
//                        quit; that helper (pure fs swap, no batch/cmd) waits
//                        for the exe unlock, replaces the app folder entry by
//                        entry with rollback safety and relaunches
//
// Plain https is used intentionally: netClient monkey-patches Node's stack,
// so this service automatically honours the school/lab proxy settings.

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours
const REPO_API = 'https://api.github.com/repos/unstablecelik/devLauncher/releases/latest';
const EXE_NAME = 'devLauncher.exe';
const PRODUCT = 'devLauncher';
const STAGING_DIR = '.update-staging';

class UpdaterService {
    constructor() {
        this.broadcast = null;
        this.checkTimer = null;
        this.availableVersion = null;
        this.downloaded = false;
        this.busy = false;
        this.pending = null;   // { variant: 'setup'|'portable', path, stagingDir? }
        this.mode = 'installed';
    }

    appDir() {
        try {
            return path.dirname(app.getPath('exe'));
        } catch (_) {
            return path.dirname(process.execPath);
        }
    }

    detectMode() {
        this.mode = resolveUpdateMode({
            exeDir: this.appDir(),
            envFlag: process.env.DEVLAUNCHER_PORTABLE,
            fileExists: fs.existsSync
        });
        return this.mode;
    }

    init(broadcast) {
        this.broadcast = broadcast || (() => {});
        this.detectMode();
        this.emit({ status: 'up-to-date' });
    }

    emit(payload) {
        try {
            if (this.broadcast) this.broadcast('update-status', Object.assign({ mode: this.mode }, payload));
        } catch (_) {}
    }

    // Kick off first check after the UI has settled (avoids competing with
    // launcher startup downloads), then re-check periodically.
    startChecking(isDev) {
        if (isDev) {
            console.log('[Updater] disabled in dev');
            this.emit({ status: 'dev-disabled' });
            return;
        }
        const run = () => this.checkNow();
        setTimeout(run, 15 * 1000);
        this.checkTimer = setInterval(run, CHECK_INTERVAL_MS);
    }

    dispose() {
        if (this.checkTimer) clearInterval(this.checkTimer);
        this.checkTimer = null;
    }

    /** Fetch JSON or text with redirects + timeout, resolving null on failure. */
    httpGet(url, { asText = false, timeoutMs = 12000, onProgress = null } = {}) {
        return new Promise((resolve) => {
            const attempt = (target, redirects) => {
                if (redirects > 5) return resolve(null);
                try {
                    const req = https.get(target, {
                        headers: {
                            'User-Agent': `devLauncher/${require('../../package.json').version} (self-update)`,
                            'Accept': asText ? '*/*' : 'application/vnd.github+json'
                        },
                        timeout: timeoutMs
                    }, (res) => {
                        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                            res.resume();
                            const next = res.headers.location.startsWith('http')
                                ? res.headers.location : new URL(res.headers.location, target).href;
                            return attempt(next, redirects + 1);
                        }
                        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
                        const total = parseInt(res.headers['content-length'], 10) || 0;
                        const chunks = [];
                        let size = 0;
                        res.on('data', (c) => {
                            chunks.push(c);
                            size += c.length;
                            if (onProgress) onProgress(size, total);
                        });
                        res.on('end', () => {
                            const buf = Buffer.concat(chunks);
                            resolve(asText ? buf.toString('utf8') : buf);
                        });
                    });
                    req.on('error', () => resolve(null));
                    req.on('timeout', () => { req.destroy(); resolve(null); });
                } catch (_) { resolve(null); }
            };
            attempt(url, 0);
        });
    }

    isUpdateDownloaded() {
        return this.downloaded;
    }

    async checkNow() {
        if (this.busy) return;
        this.busy = true;
        this.emit({ status: 'checking' });
        try {
            const release = await this.httpGet(REPO_API, { asText: true }).then(t => {
                if (!t) return null;
                try { return JSON.parse(t); } catch (_) { return null; }
            });
            if (!release || !release.tag_name) {
                this.emit({ status: 'up-to-date' });
                return;
            }
            const current = require('../../package.json').version;
            const latest = stripTag(release.tag_name);
            if (compareVersions(current, latest) >= 0) {
                this.availableVersion = null;
                this.emit({ status: 'up-to-date' });
                return;
            }
            this.availableVersion = latest;
            await this.downloadUpdate(release, latest);
        } finally {
            this.busy = false;
        }
    }

    /** Locate, verify and store the artifact for the current install shape. */
    async downloadUpdate(release, version) {
        const assets = release.assets || [];
        const sumAsset = pickAsset(assets, 'SHA256SUMS');
        const sums = sumAsset
            ? parseSha256Sums((await this.httpGet(assetUrl(sumAsset), { asText: true })) || '')
            : {};

        let name, wantedSum, progressBase = {};
        if (this.mode === 'portable') {
            name = zipArtifactName(PRODUCT, version, process.arch);
            this.pending = { variant: 'portable', stagingDir: path.join(this.appDir(), STAGING_DIR) };
        } else {
            name = setupArtifactName(PRODUCT, version);
            this.pending = { variant: 'setup', path: path.join(os.tmpdir(), name) };
        }
        const remoteAsset = pickAsset(assets, name);
        if (!remoteAsset || !assetUrl(remoteAsset)) {
            console.error(`[Updater] asset ${name} missing in release ${version}`);
            this.emit({ status: 'error', message: `update artifact not found: ${name}` });
            this.pending = null;
            return;
        }
        wantedSum = sums[name] || null;
        progressBase = { version };

        const url = assetUrl(remoteAsset);
        const started = Date.now();
        const buf = await this.httpGet(url, {
            onProgress: (bytes, total) => {
                const percent = total ? Math.min(100, Math.round((bytes / total) * 100)) : null;
                const secs = Math.max(0.001, (Date.now() - started) / 1000);
                const mbps = (bytes / 1024 / 1024 / secs).toFixed(1);
                this.emit(Object.assign({}, progressBase, { status: 'downloading', percent, mbps }));
            }
        });
        if (!buf || buf.length < 1024) {
            console.error('[Updater] download failed or empty');
            this.emit({ status: 'error', message: 'download failed' });
            this.pending = null;
            return;
        }
        if (wantedSum) {
            const sha = require('crypto').createHash('sha256').update(buf).digest('hex');
            if (sha !== wantedSum) {
                console.error('[Updater] sha256 mismatch, aborting update');
                this.emit({ status: 'error', message: 'sha256 mismatch' });
                this.pending = null;
                return;
            }
        }

        if (this.pending.variant === 'setup') {
            fs.writeFileSync(this.pending.path, buf);
        } else {
            this.preparePortableStaging(buf);
        }
        this.downloaded = true;
        this.emit({ status: 'ready', version });
    }

    /** Extract the downloaded zip into the staging dir next to the launcher. */
    preparePortableStaging(buf) {
        const stage = this.pending.stagingDir;
        try {
            fs.rmSync(stage, { recursive: true, force: true });
            fs.mkdirSync(stage, { recursive: true });
            const AdmZip = require('adm-zip');
            const zip = new AdmZip(buf);
            const entries = zip.getEntries();
            // electron-builder ships the app contents directly OR inside one
            // top folder; detect a single root dir and flatten it if present.
            const names = entries.filter(e => !e.isDirectory)
                .map(e => e.entryName.replace(/\\/g, '/'));
            let rootDir = '';
            if (names.length > 0) {
                const first = names[0].split('/')[0];
                if (first && names.every(n => n.startsWith(first + '/'))) rootDir = first + '/';
            }
            for (const entry of entries) {
                if (entry.isDirectory) continue;
                let rel = entry.entryName.replace(/\\/g, '/');
                if (rootDir && rel.startsWith(rootDir)) rel = rel.slice(rootDir.length);
                if (!rel) continue;
                const dest = path.join(stage, rel);
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.writeFileSync(dest, entry.getData());
            }
        } catch (err) {
            console.error('[Updater] staging failed:', err.message);
            this.emit({ status: 'error', message: `staging failed: ${err.message}` });
            this.pending = null;
        }
    }

    installUpdate() {
        if (!this.downloaded || !this.pending) return;
        try {
            if (this.pending.variant === 'setup') {
                // Setup runs detached; Restart Manager closes us and relaunches.
                spawn(this.pending.path, buildInnoUpdateArgs(), {
                    detached: true, stdio: 'ignore', windowsHide: true
                }).unref();
                setTimeout(() => {
                    try { app.quit(); } catch (_) {}
                }, 2500);
            } else {
                // Portable: a detached second copy (no lock, no window) takes
                // over the swap after this process exits.
                spawn(app.getPath('exe'), ['--apply-update'], {
                    detached: true, stdio: 'ignore', windowsHide: true
                }).unref();
                setTimeout(() => {
                    try { app.quit(); } catch (_) {}
                }, 800);
            }
            this.emit({ status: 'downloading', version: this.availableVersion || undefined });
        } catch (err) {
            console.error('[Updater] install failed:', err.message);
            this.emit({ status: 'error', message: err.message });
        }
    }

    /** Detached --apply-update helper: swap staged files in, relaunch. */
    async applyPortableSwap() {
        const result = await runPortableSwap({
            appDir: this.appDir(),
            exeName: 'devLauncher.exe',
            relaunch: (exePath) => {
                spawn(exePath, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
            }
        });
        if (result && result.ok) {
            console.log('[Updater] portable swap complete; launcher relaunched');
        } else {
            console.error('[Updater] portable swap skipped:', result && result.reason);
        }
        return result;
    }
}

module.exports = UpdaterService;
