const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// ── Fetch pool ──────────────────────────────────────────────────────────────
// Parallel download engine used for prefetching assets/libraries ahead of a
// launch, with size verification and bounded retries. Incomplete parts
// restart from zero (simple and race-free); finished parts are atomically
// renamed so a .part can never be picked up as a final file. Never throws
// mid-queue: failures are collected per file and returned.

const DEFAULTS = {
    concurrency: 6,
    attempts: 3,
    timeoutMs: 30_000
};

class FetchPool {
    constructor(options) {
        this.options = { ...DEFAULTS, ...options };
        this.onProgress = null; // info object => void
    }

    setProgressHandler(fn) { this.onProgress = fn; }
    _emit(info) {
        if (this.onProgress) {
            try { this.onProgress(info); } catch (_) {}
        }
    }

    // ── Single file download ────────────────────────────────────────────────
    async download(url, destPath) {
        const { timeoutMs, attempts } = this.options;
        fs.mkdirSync(path.dirname(destPath), { recursive: true });

        let lastError = null;
        for (let attempt = 1; attempt <= attempts; attempt++) {
            try {
                await this._downloadAttempt(url, destPath, timeoutMs);
                return { ok: true };
            } catch (err) {
                lastError = err;
                if (attempt < attempts) await new Promise(r => setTimeout(r, 250 * attempt));
            }
        }
        return { ok: false, error: (lastError && lastError.message) || String(lastError) };
    }

    _downloadAttempt(url, destPath, timeoutMs) {
        return new Promise((resolve, reject) => {
            const mod = url.startsWith('http://') ? http : https;
            const req = mod.get(url, { timeout: timeoutMs }, (res) => {
                if (res.statusCode !== 200 && res.statusCode !== 206) {
                    res.resume();
                    return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
                }
                const expected = parseInt(res.headers['content-length'] || '0', 10);
                fs.mkdirSync(path.dirname(destPath), { recursive: true });
                this._pipeBody(res, destPath, expected).then(resolve, reject);
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(new Error('timeout'));
            });
        });
    }

    _pipeBody(res, destPath, expected) {
        return new Promise((resolve, reject) => {
            const partPath = destPath + '.part';
            const stream = fs.createWriteStream(partPath, { flags: 'w' });
            let received = 0;
            res.on('data', (chunk) => {
                received += chunk.length;
                this._emit({ phase: 'file', received, expected, dest: destPath });
            });
            res.on('error', reject);
            stream.on('error', reject);
            res.pipe(stream);
            stream.on('finish', () => {
                const size = fs.statSync(partPath).size;
                if (expected > 0 && size !== expected) {
                    try { fs.unlinkSync(partPath); } catch (_) {}
                    return reject(new Error(`Incomplete download: ${size}/${expected} bytes for ${destPath}`));
                }
                try {
                    fs.renameSync(partPath, destPath);
                    resolve();
                } catch (err) {
                    reject(err);
                }
            });
        });
    }

    // ── Many files, bounded parallelism ─────────────────────────────────────
    /**
     * items: [{ url, dest, size? }] — size enables instant skip of finished,
     * correct-length files. Returns counts + per-file failures.
     */
    async downloadAll(items) {
        let downloaded = 0, skipped = 0, done = 0;
        const failures = [];
        const list = [...items];
        const total = items.length;

        const runner = async () => {
            while (list.length > 0) {
                const item = list.shift();
                if (!item) break;
                // destination already has the exact advertised size → skip
                if (item.size && fs.existsSync(item.dest) && fs.statSync(item.dest).size === item.size) {
                    skipped++;
                } else {
                    const at = this.download(item.url, item.dest).then(res => {
                        if (res.ok) { downloaded++; }
                        else { failures.push({ dest: item.dest, error: res.error }); }
                    });
                    // The runner awaits each item it pulled, keeping global
                    // parallelism capped by the number of runners.
                    await at;
                }
                done++;
                this._emit({ phase: 'queue', done, skipped, failed: failures.length, total });
            }
        };

        const workers = Array.from({ length: Math.max(1, Math.min(this.options.concurrency, items.length || 1)) }, runner);
        await Promise.all(workers);
        return { downloaded, skipped, failed: failures };
    }
}

module.exports = FetchPool;
