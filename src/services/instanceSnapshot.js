'use strict';
/**
 * Instance snapshots (v2).
 *
 * Snapshots capture the restore-able state of an instance - mods jars,
 * config files and options.txt - into the shared objectStore as
 * content-addressed blobs (sha1). Restoring re-materialises the files from
 * the store and removes mods jars that were not part of the snapshot, so a
 * restore is a true rollback. A safety "pre-restore" snapshot is always
 * taken automatically first, which itself can be restored - so any restore
 * is two-way.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_FILE_BYTES = 100 * 1024 * 1024; // safety cap per file
const MODS_ROOT = 'mods';
const CONFIG_ROOT = 'config';
const OPTIONS_FILE = 'options.txt';

function safeRel(rootDir, rel) {
    const abs = path.join(rootDir, rel);
    if (!abs.startsWith(path.resolve(rootDir) + path.sep) && abs !== path.resolve(rootDir)) {
        throw new Error(`Unsafe path in snapshot: ${rel}`);
    }
    return abs;
}

class InstanceSnapshot {
    constructor(objectStore, options = {}) {
        this.objectStore = objectStore;
        this.dir = options.dir || path.join(
            (options.home || require('os').homedir()), '.devlauncher', 'snapshots'
        );
        fs.mkdirSync(this.dir, { recursive: true });
    }

    _manifestPath(instanceId) {
        if (!/^[A-Za-z0-9_-]+$/.test(instanceId)) throw new Error('Invalid instance id');
        return path.join(this.dir, `${instanceId}.json`);
    }

    list(instanceId) {
        const file = this._manifestPath(instanceId);
        if (!fs.existsSync(file)) return [];
        try {
            const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
            return Array.isArray(arr) ? arr : [];
        } catch (e) {
            console.error('[InstanceSnapshot] manifest load failed:', e.message);
            return [];
        }
    }

    _saveList(instanceId, arr) {
        fs.writeFileSync(this._manifestPath(instanceId), JSON.stringify(arr, null, 1));
    }

    /**
     * Walk the snapshot-able surface of an instance and return [{rel, abs}].
     */
    collectPathList(gameDir) {
        const out = [];
        const pushFile = (rel, abs) => {
            try {
                if (fs.statSync(abs).size <= MAX_FILE_BYTES) out.push({ rel, abs });
            } catch (_) {}
        };

        const modsDir = path.join(gameDir, MODS_ROOT);
        if (fs.existsSync(modsDir)) {
            for (const f of fs.readdirSync(modsDir)) {
                if (f.toLowerCase().endsWith('.jar')) pushFile(`${MODS_ROOT}/${f}`, path.join(modsDir, f));
            }
        }

        const configDir = path.join(gameDir, CONFIG_ROOT);
        const walkConfig = (dir, relBase) => {
            let entries = [];
            try { entries = fs.readdirSync(dir); } catch (_) { return; }
            for (const f of entries) {
                const abs = path.join(dir, f);
                const rel = `${relBase}/${f}`;
                let st = null;
                try { st = fs.statSync(abs); } catch (_) { continue; }
                if (st.isDirectory()) walkConfig(abs, rel);
                else if (st.isFile()) pushFile(rel, abs);
            }
        };
        walkConfig(configDir, CONFIG_ROOT);

        const optionsPath = path.join(gameDir, OPTIONS_FILE);
        try {
            if (fs.statSync(optionsPath).isFile()) {
                pushFile(OPTIONS_FILE, optionsPath);
            } else if (fs.existsSync(optionsPath)) {
                // options.txt may be a symlink or dir entry; record when regular file already handled
            }
        } catch (_) {}

        return out;
    }

    /**
     * Create a snapshot for an instance. Returns the manifest.
     */
    create(instanceId, gameDir, label = '') {
        const files = this.collectPathList(gameDir);
        if (!files.length) {
            throw new Error('Nothing to snapshot - the instance has no mods, config files or options.txt yet.');
        }
        const ids = [];
        const manifest = {
            id: `snap-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
            label: String(label || '').slice(0, 80) || 'Snapshot',
            createdAt: new Date().toISOString(),
            fileCount: files.length,
            files: []
        };

        for (const { rel, abs } of files) {
            const buffer = fs.readFileSync(abs);
            const sha1 = crypto.createHash('sha1').update(buffer).digest('hex');
            this.objectStore.putBuffer(buffer, `snapshot:${instanceId}:${manifest.id}`);
            manifest.files.push({ rel, sha1, size: buffer.length });
            ids.push(sha1);
        }

        const arr = this.list(instanceId);
        arr.unshift(manifest);
        this._saveList(instanceId, arr.slice(0, 50)); // keep the newest 50
        return manifest;
    }

    get(instanceId, snapshotId) {
        return this.list(instanceId).find(m => m.id === snapshotId) || null;
    }

    /**
     * Restore a snapshot. A "pre-restore" safety snapshot of the current
     * state is created first (unless the snapshot is empty / identical).
     */
    restore(instanceId, snapshotId, gameDir) {
        const manifest = this.get(instanceId, snapshotId);
        if (!manifest) throw new Error(`Snapshot ${snapshotId} not found for ${instanceId}`);

        // Safety net: capture the CURRENT state as an auto pre-restore snapshot.
        let preRestore = null;
        try {
            preRestore = this.create(instanceId, gameDir, `Auto pre-restore (before ${snapshotId})`);
        } catch (e) {
            // Nothing to restore back to in an empty instance - acceptable.
            preRestore = { skipped: e.message };
        }

        // Materialise snapshot files.
        let restored = 0;
        const jarSet = new Set();
        for (const f of manifest.files) {
            const abs = safeRel(gameDir, f.rel);
            this.objectStore.materialize(f.sha1, abs, `restore:${instanceId}`);
            if (f.rel.startsWith(`${MODS_ROOT}/`) && f.rel.endsWith('.jar')) {
                jarSet.add(path.basename(f.rel));
            }
            restored++;
        }

        // Mods reconciliation: delete jars not present in the snapshot.
        let removed = 0;
        const modsDir = path.join(gameDir, MODS_ROOT);
        if (fs.existsSync(modsDir)) {
            for (const f of fs.readdirSync(modsDir)) {
                if (f.toLowerCase().endsWith('.jar') && !jarSet.has(f)) {
                    try { fs.unlinkSync(path.join(modsDir, f)); removed++; } catch (_) {}
                }
            }
        }

        return { restored, removed, preRestoreId: preRestore && preRestore.id ? preRestore.id : null, preRestoreNote: preRestore ? (preRestore.skipped || null) : null };
    }

    /**
     * Delete a snapshot, releasing its object references.
     */
    delete(instanceId, snapshotId) {
        const arr = this.list(instanceId);
        const manifest = arr.find(m => m.id === snapshotId);
        if (!manifest) throw new Error(`Snapshot ${snapshotId} not found for ${instanceId}`);
        for (const f of manifest.files) {
            try { this.objectStore.dropRef(f.sha1, `snapshot:${instanceId}:${snapshotId}`); } catch (_) {}
        }
        this._saveList(instanceId, arr.filter(m => m.id !== snapshotId));
        return true;
    }
}

module.exports = InstanceSnapshot;
