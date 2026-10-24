'use strict';
/**
 * Integrity Sweep.
 *
 * Verifies the instance's Minecraft version libraries against the checksums
 * declared in the version JSON (~root/versions/<id>/<id>.json) and can
 * redownload any missing or corrupted jar directly from its declared source
 * URL. Pure Node + global fetch - never spawns a shell.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

class IntegrityService {
    constructor(options = {}) {
        this.rootDir = options.rootDir || path.join(os.homedir(), '.devlauncher');
    }

    _versionJsonPath(versionId) {
        // Version ids are platform dir names like "1.21.1" or "1.21.1-fabric0.16.5".
        if (!/^[A-Za-z0-9._+-]+$/.test(versionId)) throw new Error(`Invalid version id: ${versionId}`);
        return path.join(this.rootDir, 'versions', versionId, `${versionId}.json`);
    }

    /**
     * Scan every declared library of the version against disk state.
     * Returns { total, verified, unchecked, missing[], corrupt[], eligible[] }.
     */
    scan(versionId) {
        const jsonPath = this._versionJsonPath(versionId);
        if (!fs.existsSync(jsonPath)) {
            throw new Error(`Version JSON not found: ${jsonPath}`);
        }
        const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        const libraries = Array.isArray(json.libraries) ? json.libraries : [];

        const result = {
            total: 0,
            verified: 0,
            unchecked: 0,
            missing: [],
            corrupt: [],
            eligible: []
        };

        for (const lib of libraries) {
            const artifact = lib && lib.downloads && lib.downloads.artifact;
            if (!artifact || !artifact.path) continue;
            result.total++;

            const abs = path.join(this.rootDir, 'libraries', artifact.path);
            const libPath = artifact.path.replace(/\//g, path.sep);
            const entry = {
                name: lib.name || libPath,
                path: libPath,
                url: artifact.url || null,
                sha1: artifact.sha1 || null,
                size: artifact.size || null
            };

            if (!fs.existsSync(abs)) {
                result.missing.push({ ...entry, reason: 'missing on disk' });
                if (entry.url) result.eligible.push(entry);
                continue;
            }

            // Nothing declared at all -> cannot verify (existence only).
            if (!entry.sha1 && entry.size === null) {
                result.unchecked++;
                continue;
            }

            // Size check first (cheap); sha1 only when explicitly declared.
            let ok = true;
            try {
                const st = fs.statSync(abs);
                if (entry.size && st.size !== entry.size) ok = false;
                if (ok && entry.sha1) {
                    const hash = crypto.createHash('sha1');
                    hash.update(fs.readFileSync(abs));
                    ok = (hash.digest('hex') === entry.sha1);
                }
            } catch (e) {
                ok = false;
            }

            if (ok) {
                result.verified++;
            } else {
                result.corrupt.push({ ...entry, reason: 'checksum or size mismatch' });
                if (entry.url) result.eligible.push(entry);
            }
        }

        return result;
    }

    /**
     * Redownload a set of eligible entries (usually from a scan result).
     * Verify sha1 when the version JSON declares one; write atomically.
     */
    async repair(entries) {
        const fixed = [];
        const failed = [];
        for (const entry of Array.isArray(entries) ? entries : []) {
            try {
                if (!entry.url || !entry.path) throw new Error('incomplete entry (no url/path)');
                const res = await fetch(entry.url);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const buffer = Buffer.from(await res.arrayBuffer());
                if (buffer.length === 0) throw new Error('empty download');
                if (entry.sha1) {
                    const hash = crypto.createHash('sha1').update(buffer).digest('hex');
                    if (hash !== entry.sha1) throw new Error(`sha1 mismatch after download (${hash})`);
                }
                if (entry.size && buffer.length !== entry.size) {
                    throw new Error(`size mismatch after download (${buffer.length})`);
                }
                await new Promise((resolve, reject) => {
                    const dest = path.join(this.rootDir, 'libraries', entry.path.replace(/\//g, path.sep));
                    if (!dest.startsWith(path.resolve(this.rootDir) + path.sep)) throw new Error('unsafe path');
                    fs.mkdirSync(path.dirname(dest), { recursive: true });
                    const tmp = `${dest}.dl-tmp`;
                    fs.writeFileSync(tmp, buffer);
                    fs.rename(tmp, dest, (err) => (err ? reject(err) : resolve()));
                });
                fixed.push(entry.name);
            } catch (e) {
                failed.push({ name: entry.name, error: e.message });
            }
        }
        return { fixed, failed };
    }
}

module.exports = IntegrityService;
