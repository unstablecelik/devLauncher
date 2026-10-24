const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const UpdateChecker = require('./updateChecker');

// ── Share Code ──────────────────────────────────────────────────────────────
// A Share Code is a portable, dependency-free description of one instance:
// version/loader metadata + the Modrinth project ids of every installed mod.
// Format: DL13-<base64url json>.<6 hex checksum>
// mods: [{ p: projectId, v: versionId (optional), f: filename }]
// Jars that are not Modrinth files are skipped (reported as unknown).

const PREFIX = 'DL13-';

class ShareCode {
    static encode(payload) {
        const json = JSON.stringify(payload);
        const b64 = Buffer.from(json, 'utf8').toString('base64url');
        const checksum = crypto.createHash('sha1').update(b64).digest('hex').slice(0, 6);
        return `${PREFIX}${b64}.${checksum}`;
    }

    static decode(code) {
        const raw = String(code || '').trim();
        if (!raw.startsWith(PREFIX)) return { ok: false, error: 'Invalid share code (missing DL13- prefix)' };
        const body = raw.slice(PREFIX.length).split('.'); // [b64, checksum]
        if (body.length !== 2) return { ok: false, error: 'Malformed share code' };
        const [b64, checksum] = body;
        const expected = crypto.createHash('sha1').update(b64).digest('hex').slice(0, 6);
        if (checksum !== expected) return { ok: false, error: 'Share code checksum failed (corrupted or truncated)' };
        try {
            const data = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
            if (!data || data.v !== 1 || !data.mv || !Array.isArray(data.mods)) {
                return { ok: false, error: 'Share code payload missing required fields' };
            }
            return { ok: true, data };
        } catch (_) {
            return { ok: false, error: 'Share code payload is not valid JSON' };
        }
    }

    /** Scan a mods dir and resolve every jar to its Modrinth project/version. */
    static async collect(modsDir, mcVersion, loader) {
        const mods = [];
        const unknown = [];
        if (!fs.existsSync(modsDir)) return { mods, unknown };
        const jars = fs.readdirSync(modsDir).filter(f =>
            f.endsWith('.jar') && fs.statSync(path.join(modsDir, f)).isFile()
        );
        for (const filename of jars) {
            const sha1 = UpdateChecker.sha1File(path.join(modsDir, filename));
            const currentVersion = sha1 ? await UpdateChecker.fetchJson(`https://api.modrinth.com/v2/version_file/${sha1}?algorithm=sha1`) : null;
            if (currentVersion && currentVersion.project_id) {
                mods.push({ p: currentVersion.project_id, v: currentVersion.id, f: filename });
            } else {
                unknown.push(filename);
            }
        }
        return { mods, unknown };
    }

    /** Resolve an imported mod entry to a concrete, downloadable file. */
    static async resolveDownload(entry, mcVersion, loader) {
        const list = await UpdateChecker.fetchJson(
            `https://api.modrinth.com/v2/project/${encodeURIComponent(entry.p)}/version?game_versions=${encodeURIComponent(JSON.stringify([mcVersion]))}&loaders=${encodeURIComponent(JSON.stringify([loader]))}`
        );
        if (!Array.isArray(list) || list.length === 0) return { ok: false, error: `No compatible build for ${entry.f || entry.p}` };
        const chosen = (entry.v && list.find(v => v.id === entry.v)) || list[0];
        const file = Array.isArray(chosen.files) ? (chosen.files.find(f => f.primary) || chosen.files[0]) : null;
        if (!file) return { ok: false, error: `No downloadable file for ${entry.f || entry.p}` };
        return { ok: true, filename: file.filename, url: file.url, sha1: file.hashes ? file.hashes.sha1 : null, versionNumber: chosen.version_number };
    }

    /** Simple https text fetch (kept injectable for tests via override). */
    static fetchText(url, timeoutMs = 8000) {
        return new Promise((resolve) => {
            const req = https.get(url, { headers: { 'User-Agent': `devLauncher/${require('../../package.json').version}` }, timeout: timeoutMs }, (res) => {
                let data = '';
                res.on('data', c => { data += c; });
                res.on('end', () => resolve({ status: res.statusCode, data }));
            });
            req.on('error', () => resolve({ status: 0, data: '' }));
            req.on('timeout', () => { req.destroy(); resolve({ status: 0, data: '' }); });
        });
    }
}

module.exports = ShareCode;
