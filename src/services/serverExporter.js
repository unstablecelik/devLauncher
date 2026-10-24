const fs = require('fs');
const path = require('path');
const https = require('https');

// ── 1-Click Server ──────────────────────────────────────────────────────────
// Turns an instance into a runnable dedicated server folder:
//   servers/<name>/  ├─ server jar (vanilla piston or Fabric launcher jar)
//                    ├─ mods/            (copied when the instance has mods)
//                    ├─ eula.txt         (eula=true, Minecraft ToS accepted by user)
//                    ├─ server.properties (minimal, user-editable)
//                    ├─ start.sh / start.bat
// Forge / NeoForge / Quilt are unsupported on purpose: their server setups need
// the official installer. The user gets an honest pointer instead of a fake run.

class ServerExporter {
    constructor(serversRoot, homeDevLauncherRoot) {
        this.serversRoot = serversRoot;
        this.root = homeDevLauncherRoot;
    }

    static sanitizeName(name) {
        const slug = String(name || 'server').toLowerCase().replace(/[^a-z0-9\-_]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
        return slug || 'server';
    }

    static fetchText(url, timeoutMs = 15000) {
        return new Promise((resolve) => {
            const req = https.get(url, { headers: { 'User-Agent': 'devLauncher/0.13.0' }, timeout: timeoutMs }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    return ServerExporter.fetchText(res.headers.location, timeoutMs).then(resolve);
                }
                let data = '';
                res.on('data', c => { data += c; });
                res.on('end', () => resolve({ status: res.statusCode, data }));
            });
            req.on('error', () => resolve({ status: 0, data: '' }));
            req.on('timeout', () => { req.destroy(); resolve({ status: 0, data: '' }); });
        });
    }

    /** Download a binary to disk, following redirects. */
    static downloadFile(url, destPath, timeoutMs = 120000) {
        return new Promise((resolve) => {
            const done = (ok, info) => { if (!ok) { try { fs.rmSync(destPath, { force: true }); } catch (_) {} } resolve(ok ? { ok, filePath: destPath } : { ok, error: info }); };
            const request = (target, redirects) => {
                if (redirects > 5) return done(false, 'too many redirects');
                const req = https.get(target, { headers: { 'User-Agent': 'devLauncher/0.13.0' }, timeout: timeoutMs }, (res) => {
                    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        res.resume();
                        return request(res.headers.location, redirects + 1);
                    }
                    if (res.statusCode !== 200) { res.resume(); return done(false, `HTTP ${res.statusCode} for server jar`); }
                    const out = fs.createWriteStream(destPath);
                    res.pipe(out);
                    out.on('finish', () => out.close(() => {
                        try {
                            if (fs.statSync(destPath).size < 1000) return done(false, 'server jar download is suspiciously small');
                            done(true);
                        } catch (err) { done(false, err.message); }
                    }));
                    out.on('error', (e) => done(false, e.message));
                });
                req.on('error', (e) => done(false, e.message));
                req.on('timeout', () => { req.destroy(); done(false, 'download timeout'); });
            };
            request(url, 0);
        });
    }

    static serverProperties() {
        return [
            'motd=devLauncher Server',
            'level-name=world',
            'gamemode=survival',
            'max-players=10',
            'online-mode=true',
            'enable-command-block=false',
            'view-distance=8',
            'simulation-distance=6'
        ].join('\n') + '\n';
    }

    static startScripts(jarName, maxRam) {
        const jvmArgs = `-Xms1G -Xmx${maxRam || '4G'}`;
        return {
            'start.sh': `#!/usr/bin/env bash\ncd "$(dirname "$0")"\njava ${jvmArgs} -jar ${jarName} nogui\n`,
            'start.bat': `@echo off\ncd /d "%~dp0"\njava ${jvmArgs} -jar ${jarName} nogui\npause\n`
        };
    }

    async resolveServerUrl(mcVersion, loaderType, loaderVersion) {
        if (loaderType === 'vanilla') {
            const manifest = await ServerExporter.fetchText('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
            if (manifest.status !== 200) return { ok: false, error: 'Could not reach Mojang version manifest' };
            let entry;
            try { entry = JSON.parse(manifest.data).versions.find(v => v.id === mcVersion); } catch (_) { entry = null; }
            if (!entry) return { ok: false, error: `Version ${mcVersion} not found in Mojang manifest` };
            const detail = await ServerExporter.fetchText(entry.url);
            if (detail.status !== 200) return { ok: false, error: 'Could not read version details' };
            let url;
            try { url = JSON.parse(detail.data).downloads.server.url; } catch (_) { url = null; }
            return url ? { ok: true, url, jarName: 'server.jar' } : { ok: false, error: 'No vanilla server download for this version' };
        }
        if (loaderType === 'fabric') {
            let lv = loaderVersion;
            if (!lv) {
                const loaders = await ServerExporter.fetchText('https://meta.fabricmc.net/v2/versions/loader');
                if (loaders.status !== 200) return { ok: false, error: 'Could not reach Fabric meta' };
                try { lv = JSON.parse(loaders.data)[0].version; } catch (_) { lv = null; }
                if (!lv) return { ok: false, error: 'No Fabric loader version detected' };
            }
            return {
                ok: true,
                jarName: 'fabric-server.jar',
                url: `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/${lv}/1.0.0/server/jar`,
                note: 'Fabric server launcher jar (self-contained).'
            };
        }
        if (loaderType === 'quilt') return { ok: false, error: 'Quilt servers need the official installer - run it inside servers/<name> once, then use the generated start scripts.' };
        return { ok: false, error: `${loaderType} servers need the official installer - run it once in the server folder, then use the generated start scripts.` };
    }

    /**
     * Build a runnable server folder from an instance.
     * @param {{name, version, loaderType, loaderVersion, instanceDir, maxRam}} spec
     * @param {(msg: string) => void} onProgress
     */
    async createServer({ name, version, loaderType, loaderVersion, instanceDir, maxRam }, onProgress) {
        const onMsg = onProgress || (() => {});
        const notes = [];
        const serverName = ServerExporter.sanitizeName(name);
        const serverDir = path.join(this.serversRoot, `${serverName}-${version || 'mc'}`);
        if (fs.existsSync(serverDir)) return { ok: false, error: `Server folder already exists: ${serverDir}` };

        onMsg('Resolving server download...');
        const resolved = await this.resolveServerUrl(version, loaderType, loaderVersion);
        if (!resolved.ok) return { ok: false, error: resolved.error };
        if (resolved.note) notes.push(resolved.note);

        fs.mkdirSync(serverDir, { recursive: true });
        try {
            fs.writeFileSync(path.join(serverDir, 'eula.txt'), 'eula=true\n');
            fs.writeFileSync(path.join(serverDir, 'server.properties'), ServerExporter.serverProperties());

            const modsDir = path.join(instanceDir, 'mods');
            if (fs.existsSync(modsDir)) {
                const jars = fs.readdirSync(modsDir).filter(f => f.endsWith('.jar'));
                if (jars.length > 0) {
                    fs.mkdirSync(path.join(serverDir, 'mods'), { recursive: true });
                    for (const f of jars) fs.copyFileSync(path.join(modsDir, f), path.join(serverDir, 'mods', f));
                    onMsg(`Copied ${jars.length} mods from the instance.`);
                    notes.push(`Copied ${jars.length} mods - server and client loader must match!`);
                }
            }

            onMsg(`Downloading ${loaderType} server jar...`);
            const jarDest = path.join(serverDir, resolved.jarName);
            const dl = await ServerExporter.downloadFile(resolved.url, jarDest);
            if (!dl.ok) return { ok: false, error: dl.error, serverDir };

            for (const [fname, content] of Object.entries(ServerExporter.startScripts(resolved.jarName, maxRam))) {
                fs.writeFileSync(path.join(serverDir, fname), content);
                if (fname === 'start.sh') fs.chmodSync(path.join(serverDir, fname), 0o755);
            }
            notes.push('This folder still needs RAM/CPU tuned per machine; edit server.properties to your taste.');

            return { ok: true, serverDir, jarPath: jarDest, notes };
        } catch (err) {
            return { ok: false, error: err.message, serverDir };
        }
    }
}

module.exports = ServerExporter;
