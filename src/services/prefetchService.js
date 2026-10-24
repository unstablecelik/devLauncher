const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');
const FetchPool = require('./fetchPool');

// ── Prefetch service ────────────────────────────────────────────────────────
// Zero-cold-start: pre-downloads everything a launch will need (vanilla
// libraries + natives, client jar, asset index objects) into the SAME layout
// minecraft-launcher-core (MCLC) uses under the launcher root. At play time
// MCLC verifies each file (size/sha1) and skips anything already present, so
// prefetching removes most of the "download wait" between PLAY and spawn.
//
// Layout assumptions (matching MCLC defaults):
//   <root>/versions/<id>/<id>.json   version profiles
//   <root>/versions/<id>/<id>.jar    client jar
//   <root>/libraries/<mojang path>   library artifacts + natives jars
//   <root>/assets/objects/<h2>/<sha1>  modern asset objects ("1.8+" assets indexes)
//
// Deliberately quiet: never blocks or fails a launch — server errors simply
// surface as status entries for the UI.

function manifestUrl() {
    return 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
}

class PrefetchService {
    constructor(root, poolOptions) {
        this.root = root; // e.g. ~/.devlauncher (MCLC root)
        this.pool = new FetchPool({ concurrency: 6, ...poolOptions });
        this.status = {
            running: false,
            version: null,
            done: 0,
            total: 0,
            downloaded: 0,
            skipped: 0,
            failed: 0,
            note: null,
            startedAt: null,
            finishedAt: null
        };
        this._manifestCache = null;
    }

    summary() {
        return { ...this.status };
    }

    setStatus(patch) {
        Object.assign(this.status, patch);
        this._emit('prefetch-status', this.summary());
    }

    onEvent = null;
    _emit(channel, payload) {
        if (this.onEvent) {
            try { this.onEvent(channel, payload); } catch (_) {}
        }
    }

    _fetchJson(url) {
        return new Promise((resolve, reject) => {
            https.get(url, { timeout: 20000 }, (res) => {
                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
                }
                let data = '';
                res.on('data', (c) => { data += c; });
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
                });
            }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
        });
    }

    _localPath(...segments) {
        return path.join(this.root, ...segments);
    }

    async resolveVersionJson(versionString) {
        // 1) local custom profiles (fabric/forge/neoforge merged) win
        const localJson = this._localPath('versions', versionString, `${versionString}.json`);
        if (fs.existsSync(localJson)) {
            try { return JSON.parse(fs.readFileSync(localJson, 'utf8')); } catch (_) {}
        }
        // 2) mojang manifest
        if (!this._manifestCache) {
            this._manifestCache = await this._fetchJson(manifestUrl());
        }
        const entry = this._manifestCache.versions.find(v => v.id === versionString);
        if (!entry) throw new Error(`Version "${versionString}" not in Mojang manifest`);
        return await this._fetchJson(entry.url);
    }

    _osName() {
        return { linux: 'linux', win32: 'windows', darwin: 'osx', aix: 'linux', freebsd: 'linux', openbsd: 'linux' }[process.platform] || 'linux';
    }

    _archName() {
        return (process.arch === 'x32' || process.arch === 'ia32') ? 'x86' : 'x64';
    }

    // Mojang rule handling mirrored 1:1 from MCLC's Handler.parseRule
    // (node_modules/minecraft-launcher-core/components/handler.js:237).
    // Whatever MCLC includes, we prefetch; whatever it excludes, we skip —
    // otherwise pre-fetched files would be wasted bandwidth or missing files.
    // MCLC is idiosyncratic here on purpose: single 'disallow <os>' rules are
    // ignored (included everywhere), other multi-rule lists are excluded.
    _mclcExcludes(lib) {
        const rules = lib.rules;
        if (!rules) return false;
        const os = this._osName();
        if (rules.length > 1) {
            if (rules[0].action === 'allow' && rules[1].action === 'disallow' && rules[1].os && rules[1].os.name === 'osx') {
                return os === 'osx';
            }
            return true;
        }
        if (rules[0].action === 'allow' && rules[0].os) {
            return rules[0].os.name !== os;
        }
        return false;
    }

    /**
     * Produce prefetch items for a parsed version json (libraries+natives+client).
     * Assets come separately via prefetchAssets().
     */
    buildPlan(versionJson) {
        const items = [];
        const notes = [];

        // libraries + natives (same rule decision MCLC applies at launch)
        for (const lib of versionJson.libraries || []) {
            if (this._mclcExcludes(lib)) continue;
            const artifact = lib.downloads && lib.downloads.artifact;
            if (artifact && artifact.url) {
                items.push({ url: artifact.url, dest: this._localPath('libraries', artifact.path), size: artifact.size });
            }
            const nativesKey = `natives-${this._osName()}`;
            if (lib.downloads && lib.downloads[nativesKey] && lib.downloads[nativesKey].url) {
                const native = lib.downloads[nativesKey];
                items.push({ url: native.url, dest: this._localPath('libraries', native.path), size: native.size });
            }
        }

        // client jar
        const client = versionJson.downloads && versionJson.downloads.client;
        if (client && client.url) {
            items.push({ url: client.url, dest: this._localPath('versions', versionJson.id, `${versionJson.id}.jar`), size: client.size });
        }
        return { items, notes };
    }

    async prefetchAssets(versionJson, assetByteCap) {
        const indexJson = await this._fetchJson(versionJson.assetIndex.url);
        const objects = indexJson.objects || {};
        const items = [];
        let bytes = 0;
        for (const [, meta] of Object.entries(objects)) {
            const h = meta.hash;
            const url = `https://resources.download.minecraft.net/${h.slice(0, 2)}/${h}`;
            items.push({ url, dest: this._localPath('assets', 'objects', h.slice(0, 2), h), size: meta.size });
            bytes += meta.size;
        }
        // Cap for metered connections: trim largest files first? No — trim the
        // plan to stay under the cap, keeping every asset under cap semantics
        // (partial coverage) when over. Sorted by size, keep small ones (they
        // cost little and most are bound to be needed).
        if (bytes > assetByteCap && assetByteCap > 0) {
            items.sort((a, b) => a.size - b.size);
            let acc = 0, keep = 0;
            while (keep < items.length && acc + items[keep].size <= assetByteCap) { acc += items[keep].size; keep++; }
            this.setStatus({ note: `Asset set is ${Math.round(bytes / 1048576)} MB — pre-fetching the smallest ${keep}/${items.length} objects (${Math.round(acc / 1048576)} MB) (cap).` });
            return items.slice(0, keep);
        }
        return items;
    }

    /**
     * Run a full prefetch for a version. Resolves to a summary; updates this.status.
     */
    async prefetchVersion(versionString, options) {
        const { includeAssets = true, assetByteCap = 400 * 1024 * 1024 } = options || {};
        const startedAt = new Date().toISOString();
        this.setStatus({ running: true, version: versionString, done: 0, total: 0, downloaded: 0, skipped: 0, failed: 0, startedAt, finishedAt: null, note: null });
        try {
            const versionJson = await this.resolveVersionJson(versionString);
            const { items, notes } = this.buildPlan(versionJson);
            if (includeAssets) {
                if (versionJson.assetIndex && (versionJson.assetIndex.id === 'legacy' || versionJson.assetIndex.id === 'pre-1.6')) {
                    notes.push(`Assets index "${versionJson.assetIndex.id}" uses a virtual layout — skipped.`);
                    this.setStatus({ note: `Assets index "${versionJson.assetIndex.id}" uses a virtual layout — asset prefetch skipped.` });
                } else {
                    const assetItems = await this.prefetchAssets(versionJson, assetByteCap);
                    items.push(...assetItems);
                }
            }
            this.setStatus({ total: items.length, note: (this.status.note || '') + (notes.length ? ' ' + notes.join(' ') : '') });

            const summary = await this.pool.downloadAll(items);
            this.setStatus({
                running: false,
                downloaded: summary.downloaded,
                skipped: summary.skipped,
                failed: summary.failed.length,
                finishedAt: new Date().toISOString()
            });
            return summary;
        } catch (err) {
            this.setStatus({ running: false, note: `Prefetch error: ${err.message}`, finishedAt: new Date().toISOString() });
            return { downloaded: 0, skipped: 0, failed: [{ dest: '(plan)', error: err.message }] };
        }
    }
}

module.exports = PrefetchService;

// Static helper: convert a user-facing MB setting into byte cap for prefetchAssets.
// 0 (or unset→null) means unlimited; values are clamped to [0, 2048] MB with default 400.
PrefetchService.assetByteCapFromMB = function (mbSetting) {
    if (mbSetting === null || mbSetting === undefined || mbSetting === '') return 400 * 1024 * 1024; // default when setting is missing
    const mb = Number(mbSetting);
    if (!Number.isFinite(mb)) return 400 * 1024 * 1024;
    if (!Number.isFinite(mb)) return 400 * 1024 * 1024;
    const clamped = Math.max(0, Math.min(2048, Math.floor(mb)));
    if (clamped === 0) return 0; // explicit unlimited
    return clamped * 1024 * 1024;
};
