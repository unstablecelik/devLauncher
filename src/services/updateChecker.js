const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

// ── Modrinth Update Checker ─────────────────────────────────────────────────
// Detects newer Modrinth builds for installed jars by file hash: sha1 →
// /v2/version_file/{sha1} tells us the project + exact version the jar came
// from; /v2/project/{id}/version then lists the newest compatible build.
// Downloads are sha1-verified before replacing the jar. Works offline-free:
// every step degrades gracefully to "unknown" instead of throwing.

const API = 'https://api.modrinth.com/v2';
const UA = `devLauncher/${require('../../package.json').version} (Minecraft launcher)`;

class UpdateChecker {
    static fetchJson(url, timeoutMs = 8000) {
        return new Promise((resolve) => {
            try {
                const req = https.get(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, timeout: timeoutMs }, (res) => {
                    let data = '';
                    res.on('data', c => { data += c; });
                    res.on('end', () => {
                        if (res.statusCode >= 400) return resolve(null); // 404 = not a Modrinth file
                        try { resolve(JSON.parse(data)); } catch (_) { resolve(null); }
                    });
                });
                req.on('error', () => resolve(null));
                req.on('timeout', () => { req.destroy(); resolve(null); });
            } catch (_) { resolve(null); }
        });
    }

    static sha1File(filePath) {
        try {
            return crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex');
        } catch (_) {
            return null;
        }
    }

    /** Newest compatible Modrinth version for a project, or null. */
    static async latestForProject(projectId, mcVersion, loader) {
        const gv = encodeURIComponent(JSON.stringify([mcVersion]));
        const ls = encodeURIComponent(JSON.stringify([loader]));
        const list = await UpdateChecker.fetchJson(`${API}/project/${projectId}/version?game_versions=${gv}&loaders=${ls}`);
        return Array.isArray(list) && list.length > 0 ? list[0] : null;
    }

    /**
     * Check every jar in modsDir. Returns rows:
     * { filename, sha1, project, currentVersion, latestVersion, updateAvailable,
     *   projectId, latestFilename, downloadUrl }
     */
    static async checkInstance({ modsDir, mcVersion, loader }) {
        const rows = [];
        if (!fs.existsSync(modsDir)) return rows;
        const jars = fs.readdirSync(modsDir).filter(f =>
            (f.endsWith('.jar') || f.endsWith('.jar.disabled')) && fs.statSync(path.join(modsDir, f)).isFile()
        );
        for (const filename of jars) {
            const filePath = path.join(modsDir, filename);
            const sha1 = UpdateChecker.sha1File(filePath);
            if (!sha1) { rows.push({ filename, status: 'unreadable' }); continue; }
            const currentVersion = await UpdateChecker.fetchJson(`${API}/version_file/${sha1}?algorithm=sha1`);
            if (!currentVersion || !currentVersion.project_id) {
                rows.push({ filename, sha1, status: 'not-modrinth' });
                continue;
            }
            const latest = await UpdateChecker.latestForProject(currentVersion.project_id, mcVersion, loader);
            const latestFile = latest && Array.isArray(latest.files) ? latest.files.find(f => f.primary) || latest.files[0] : null;
            rows.push({
                filename,
                sha1,
                status: 'ok',
                projectId: currentVersion.project_id,
                project: currentVersion.name || currentVersion.project_id,
                currentVersion: currentVersion.version_number,
                latestVersion: latest ? latest.version_number : null,
                latestFilename: latestFile ? latestFile.filename : null,
                downloadUrl: latestFile ? latestFile.url : null,
                latestSha1: latestFile && latestFile.hashes ? latestFile.hashes.sha1 : null,
                updateAvailable: !!(latest && latestFile && latest.id !== currentVersion.id)
            });
        }
        return rows;
    }

    /** Download one file with sha1 verification. Returns { ok, filePath|error }. */
    static downloadVerified(url, destPath, expectedSha1) {
        return new Promise((resolve) => {
            const tmp = destPath + '.part';
            const done = (ok, info) => { try { if (!ok) fs.rmSync(tmp, { force: true }); } catch (_) {} resolve(ok ? { ok, filePath: destPath } : { ok, error: info }); };
            const request = (target, redirects) => {
                if (redirects > 4) return done(false, 'too many redirects');
                try {
                    https.get(target, { headers: { 'User-Agent': UA } }, (res) => {
                        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                            res.resume();
                            return request(res.headers.location, redirects + 1);
                        }
                        if (res.statusCode !== 200) { res.resume(); return done(false, `HTTP ${res.statusCode}`); }
                        const out = fs.createWriteStream(tmp);
                        const hash = crypto.createHash('sha1');
                        res.on('data', c => { hash.update(c); });
                        res.pipe(out);
                        out.on('finish', () => {
                            out.close(() => {
                                if (expectedSha1 && hash.digest('hex') !== expectedSha1) return done(false, 'sha1 mismatch after download');
                                try {
                                    fs.copyFileSync(tmp, destPath); // overwrite old jar
                                    fs.rmSync(tmp, { force: true });
                                    done(true);
                                } catch (err) { done(false, err.message); }
                            });
                        });
                        out.on('error', (e) => done(false, e.message));
                    }).on('error', (e) => done(false, e.message));
                } catch (err) { done(false, err.message); }
            };
            request(url, 0);
        });
    }
}

module.exports = UpdateChecker;
