const fs = require('fs');
const path = require('path');

// ── Benchmark service (V1: honest TTFP clock) ────────────────────────────────
// Times a real launch end-to-end and records "how many seconds between the
// PLAY click and the moment the game logs its sound engine / render surface
// is up" (TTFP = time to first playable). Also counts bytes MCLC still had to
// download, so prefetch's effect becomes measurable (A/B).
//
// Markers are conservative: whichever comes first of
//   • "Sound engine started"        (vanilla + most mod loaders)
//   • "Backend library: LWJGL"      (render surface up, very early)
//   • "[CLIENT] Sound engine started"
// A missing marker (game closed before reaching it) records the attempt as
// failed — we never invent numbers.

class BenchmarkService {
    constructor(storagePath) {
        this.storagePath = storagePath; // ~/.devlauncher/benchmarks.json
        this.records = this._load();
        this.current = null;
    }

    _load() {
        try {
            if (fs.existsSync(this.storagePath)) {
                const parsed = JSON.parse(fs.readFileSync(this.storagePath, 'utf8'));
                if (Array.isArray(parsed)) return parsed;
            }
        } catch (_) {}
        return [];
    }

    _save() {
        fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
        const tmp = this.storagePath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(this.records.slice(-200), null, 1));
        fs.renameSync(tmp, this.storagePath);
    }

    /**
     * Start timing a launch.
     * prefetchOn reflects whether the prefetch service had finished its plan.
     */
    start({ instanceId, version, loaderType, prefetchDone }) {
        this.current = {
            id: `${Date.now().toString(36)}`,
            startedAt: new Date().toISOString(),
            instanceId: instanceId || null,
            version: version || null,
            loaderType: loaderType || 'vanilla',
            prefetchDone: !!prefetchDone,
            downloadBytes: 0,
            assetTasks: 0,
            assetDone: 0,
            ttfpMs: null,
            failed: false,
            marker: null
        };
        return this.current.id;
    }

    /** MCLC 'progress' events (downloads during launch). */
    onLauncherProgress(e) {
        if (!this.current) return;
        if (e && e.type === 'assets') {
            this.current.assetTasks = Math.max(this.current.assetTasks || 0, e.total || 0);
            this.current.assetDone = Math.max(this.current.assetDone || 0, e.task || 0);
        }
    }

    /** Raw MCLC download byte counting is not exposed everywhere; the UI
     * sums progress percent — keep V1 to tasks/seconds only. */
    markGameLogLine(line) {
        if (!this.current || this.current.ttfpMs != null) return;
        const text = String(line);
        if (/Sound engine started|Backend library: LWJGL/.test(text)) {
            const first = /Sound engine started/.exec(text) ? 'sound-engine' : 'lwjgl';
            const markerAt = Date.now();
            this.current.ttfpMs = markerAt - new Date(this.current.startedAtInternal || this.current.startedAt).getTime();
            this.current.marker = first;
        }
    }

    /** Launch clicked — precise wall clock anchor (before async plumbing). */
    clickNow() {
        if (this.current) this.current.startedAtInternal = new Date().toISOString();
    }

    closed(exitCode) {
        if (!this.current) return null;
        const rec = {
            ...this.current,
            exitCode: exitCode === undefined ? null : exitCode,
            closedAt: new Date().toISOString(),
            ttfpSeconds: this.current.ttfpMs != null ? Math.round(this.current.ttfpMs / 100) / 10 : null
        };
        rec.failed = rec.ttfpMs == null;
        this.current = null;
        this.records.push(rec);
        this._save();
        return rec;
    }

    summary(limit = 10) {
        const last = this.records[this.records.length - 1];
        return {
            last,
            history: this.records.slice(-limit).reverse(),
            averageByPrefetch: {
                withPrefetch: this._avg(true),
                without: this._avg(false)
            }
        };
    }

    _avg(prefetchDone) {
        const nums = this.records.filter(r => r.prefetchDone === prefetchDone && r.ttfpMs != null).map(r => r.ttfpMs);
        if (!nums.length) return null;
        return { count: nums.length, avgSeconds: Math.round(nums.reduce((a, b) => a + b, 0) / nums.length / 100) / 10 };
    }
}

module.exports = BenchmarkService;
