const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Import service ──────────────────────────────────────────────────────────
// Discovers instances from Prism / MultiMC / the vanilla launcher / TLauncher,
// previews them (version, loader, mods, worlds, size) and imports the selected
// ones into devLauncher instances (saves, mods, config, resource/shader packs
// and instance-local version profiles).

// Subdirectories + root files copied from the source game dir into the new
// instance. Anything else (caches, crash reports, launcher metadata) is left.
const COPY_DIRS = [
    'saves', 'mods', 'config', 'screenshots',
    'resourcepacks', 'shaderpacks', 'datapacks', 'journeymap'
];
const COPY_FILES = ['options.txt', 'servers.dat', 'servers.dat_old', 'usercache.json'];

// Prism/MultiMC component uids -> devLauncher loader types
function loaderFromComponents(components) {
    if (!Array.isArray(components)) return { loaderType: 'vanilla', loaderVersion: null };
    let mcVersion = null;
    for (const c of components) {
        const uid = String(c.uid || '');
        if (uid === 'net.minecraft' && c.version) mcVersion = c.version;
    }
    // Loader identification runs after seeing all components; explicit uid match per family
    const isFabric = components.some(c => /fabric.*loader|fabric-loader/i.test(String(c.uid || '')));
    const isQuilt = components.some(c => /quilt/i.test(String(c.uid || '')));
    const isNeo = components.some(c => /neoforged|sinytra/i.test(String(c.uid || '')));
    const isForge = components.some(c => /forge/i.test(String(c.uid || ''))) && !isNeo;

    let loaderType = 'vanilla', loaderVersion = null;
    if (isFabric) { loaderType = 'fabric'; loaderVersion = findVersion(components, /fabric.*loader|fabric-loader/i); }
    else if (isQuilt) { loaderType = 'quilt'; loaderVersion = findVersion(components, /quilt/i); }
    else if (isNeo) { loaderType = 'neoforge'; loaderVersion = findVersion(components, /neoforged|sinytra/i); }
    else if (isForge) { loaderType = 'forge'; loaderVersion = findVersion(components, /forge/i); }
    return { loaderType, loaderVersion, mcVersion };
}

function findVersion(components, re) {
    const c = components.find(c => re.test(String(c.uid || '')));
    return c && c.version ? c.version : null;
}

class ImportService {
    constructor(instanceManager, rootVersionsDir) {
        this.instanceManager = instanceManager;
        this.rootVersionsDir = rootVersionsDir; // ~/.devlauncher/versions
    }

    // Default locations of foreign launchers, per OS
    defaultRoots() {
        const home = os.homedir();
        const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
        const linuxData = path.join(home, '.local', 'share');
        const macSup = path.join(home, 'Library', 'Application Support');
        const flatpakPrism = path.join(home, '.var', 'app', 'org.prismlauncher.PrismLauncher', 'data', 'PrismLauncher', 'instances');
        const flatpakPrism2 = path.join(home, '.var', 'app', 'org.prismlauncher.PrismLauncher', 'data', 'prismlauncher', 'instances');

        if (process.platform === 'win32') {
            return [
                { source: 'prism', root: path.join(appData, 'PrismLauncher', 'instances') },
                { source: 'prism', root: path.join(appData, 'PollyMC', 'instances') },
                { source: 'multimc', root: path.join(appData, 'MultiMC', 'instances') },
                { source: 'official', root: path.join(appData, '.minecraft') }
            ];
        }
        if (process.platform === 'darwin') {
            return [
                { source: 'prism', root: path.join(macSup, 'PrismLauncher', 'instances') },
                { source: 'multimc', root: path.join(macSup, 'MultiMC', 'instances') },
                { source: 'official', root: path.join(macSup, 'minecraft') },
                { source: 'official', root: path.join(home, '.minecraft') }
            ];
        }
        return [
            { source: 'prism', root: path.join(linuxData, 'PrismLauncher', 'instances') },
            { source: 'prism', root: path.join(linuxData, 'prismlauncher', 'instances') },
            { source: 'prism', root: flatpakPrism },
            { source: 'prism', root: flatpakPrism2 },
            { source: 'multimc', root: path.join(linuxData, 'multimc', 'instances') },
            { source: 'multimc', root: path.join(home, 'MultiMC', 'instances') },
            { source: 'official', root: path.join(home, '.minecraft') }
        ];
    }

    // ── Scanning ────────────────────────────────────────────────────────────
    // Returns a flat list of importable items — never mutates anything.
    listSources(extraRoots) {
        const items = [];
        for (const { source, root } of this.defaultRoots()) {
            try {
                if (source === 'official') {
                    const found = this.scanVanillaRoot(source, root);
                    if (found) items.push(found);
                    continue;
                }
                // Prism / MultiMC: one directory per instance
                if (!fs.existsSync(root)) continue;
                let entries;
                try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { continue; }
                for (const entry of entries) {
                    if (!entry.isDirectory()) continue;
                    const instDir = path.join(root, entry.name);
                    if (['instances', 'libraries', 'cache', 'icons', 'logs', 'tests'].includes(entry.name)) continue;
                    const found = this.scanPrismInstance(source, instDir);
                    if (found) items.push(found);
                }
            } catch (err) {
                console.error(`[Import] scan failed for ${root}:`, err.message);
            }
        }
        for (const { source, root } of (extraRoots || [])) {
            try {
                if (!fs.existsSync(root)) continue;
                const stat = fs.statSync(root);
                if (!stat.isDirectory()) continue;
                if (source === 'official') {
                    // user picked a .minecraft root directly
                    const found = this.scanVanillaRoot('official', root);
                    if (found) items.push(found);
                } else {
                    const entries = fs.readdirSync(root, { withFileTypes: true });
                    for (const entry of entries) {
                        if (!entry.isDirectory()) continue;
                        const found = this.scanPrismInstance(source, path.join(root, entry.name));
                        if (found) items.push(found);
                    }
                }
            } catch (err) {
                console.error(`[Import] custom scan failed for ${root}:`, err.message);
            }
        }
        return items;
    }

    gameDirOf(instDir) {
        for (const name of ['.minecraft', 'minecraft']) {
            const p = path.join(instDir, name);
            if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
        }
        return null;
    }

    scanPrismInstance(source, instDir) {
        try {
            const md = this.readInstanceMeta(instDir);
            if (!md) return null;
            return this.buildItem(source, md.name || path.basename(instDir), instDir, md);
        } catch (err) {
            return null;
        }
    }

    readInstanceMeta(instDir) {
        const cfgPath = path.join(instDir, 'instance.cfg');
        const packPath = path.join(instDir, 'mmc-pack.json');
        const minstPath = path.join(instDir, 'minecraftinstance.json');

        let name = null;
        if (fs.existsSync(cfgPath)) {
            try {
                const raw = fs.readFileSync(cfgPath, 'utf8');
                const m = raw.match(/^\s*name\s*=(.*)$/mi);
                if (m) name = m[1].trim();
            } catch (_) {}
        }

        let parsed = null;
        if (fs.existsSync(packPath)) {
            try { parsed = JSON.parse(fs.readFileSync(packPath, 'utf8')); } catch (_) {}
        } else if (fs.existsSync(minstPath)) {
            try { parsed = JSON.parse(fs.readFileSync(minstPath, 'utf8')); } catch (_) {}
        }
        if (!parsed) return name ? { name, loaderType: 'vanilla', loaderVersion: null, mcVersion: null } : null;

        const { loaderType, loaderVersion, mcVersion } = loaderFromComponents(parsed.components || []);
        return { name, loaderType, loaderVersion, mcVersion };
    }

    scanVanillaRoot(source, root) {
        try {
            if (!fs.existsSync(root)) return null;
            const stat = fs.statSync(root);
            if (!stat.isDirectory()) return null;
            // A vanilla root must look like a game dir (either root itself, or root/minecraft)
            const gameDir = this.gameDirOf(root) || root;
            const hasSome = COPY_DIRS.some(d => fs.existsSync(path.join(gameDir, d)));
            const hasVersionProfile = fs.existsSync(path.join(root, 'launcher_profiles.json'));
            if (!hasSome && !hasVersionProfile && !fs.existsSync(path.join(gameDir, 'options.txt'))) return null;

            const md = { name: 'Imported Minecraft', ...this.detectVanillaVersion(root, gameDir) };
            return this.buildItem(source, md.name, root, md, gameDir);
        } catch (err) {
            return null;
        }
    }

    detectVanillaVersion(root, gameDir) {
        // best-effort: launcher_profiles.json selected profile -> versions dir
        let version = null;
        try {
            const prof = JSON.parse(fs.readFileSync(path.join(root, 'launcher_profiles.json'), 'utf8'));
            const selectedName = prof.selectedProfile && prof.profiles[prof.selectedProfile];
            version = selectedName && selectedName.lastVersionId;
        } catch (_) {}
        if (!version) {
            try {
                const versDir = path.join(root, 'versions');
                if (fs.existsSync(versDir)) {
                    const ids = fs.readdirSync(versDir)
                        .filter(v => /\d+\.\d+(\.\d+)?$/.test(v))
                        .sort((a, b) => {
                            const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
                            for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0); }
                            return 0;
                        });
                    if (ids.length) version = ids[0];
                }
            } catch (_) {}
        }
        return { loaderType: 'vanilla', loaderVersion: null, mcVersion: version };
    }

    // ── Item metadata (mods/worlds counts, rough size) ──────────────────────
    buildItem(source, name, instDir, md, gameDirOverride) {
        const gameDir = gameDirOverride || this.gameDirOf(instDir);
        if (!gameDir) return null;

        let modsCount = 0, worldsCount = 0, sizeMB = 0;
        const modsDir = path.join(gameDir, 'mods');
        if (fs.existsSync(modsDir)) {
            try {
                const jarList = fs.readdirSync(modsDir).filter(f => f.endsWith('.jar'));
                modsCount = jarList.length;
                for (const f of jarList) {
                    try { sizeMB += fs.statSync(path.join(modsDir, f)).size; } catch (_) {}
                }
            } catch (_) {}
        }
        const savesDir = path.join(gameDir, 'saves');
        if (fs.existsSync(savesDir)) {
            try {
                const worlds = fs.readdirSync(savesDir, { withFileTypes: true }).filter(d => d.isDirectory());
                worldsCount = worlds.length;
                for (const w of worlds) {
                    sizeMB += this.dirSize(path.join(savesDir, w.name), 2);
                }
            } catch (_) {}
        }
        sizeMB = Math.round(sizeMB / 1024 / 1024);

        const idCandidate = md.mcVersion || null;
        return {
            source,
            name: name || path.basename(instDir),
            instanceDir: instDir,
            gameDir,
            loaderType: md.loaderType || 'vanilla',
            loaderVersion: md.loaderVersion || null,
            version: idCandidate || '1.21.1',
            versionsKnown: !!idCandidate,
            customVersionsDir: this.findLocalVersionsDir(instDir),
            modsCount, worldsCount, sizeMB
        };
    }

    findLocalVersionsDir(instDir) {
        // Instance-local custom profiles (fab/forge jsons) that must be merged
        // into the shared .devlauncher/versions root for MCLC to find them.
        const candidates = [
            path.join(instDir, 'minecraft', 'versions'),
            path.join(instDir, '.minecraft', 'versions'),
            path.join(instDir, 'versions')
        ];
        for (const c of candidates) {
            try {
                if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c;
            } catch (_) {}
        }
        return null;
    }

    dirSize(dir, depth) {
        let total = 0;
        try {
            if (depth < 0) return 0;
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                try {
                    if (e.isDirectory()) total += this.dirSize(p, depth - 1);
                    else total += fs.statSync(p).size;
                } catch (_) {}
            }
        } catch (_) {}
        return total;
    }

    // ── Import execution ────────────────────────────────────────────────────
    importItems(items) {
        const results = [];
        for (const item of items) {
            try {
                results.push(this.importOne(item));
            } catch (err) {
                results.push({ name: item.name, success: false, error: err.message });
            }
        }
        return results;
    }

    importOne(item) {
        if (!item || !item.gameDir || !fs.existsSync(item.gameDir)) {
            throw new Error('Source game directory not found');
        }
        const version = item.version || '1.21.1';
        const loaderType = item.loaderType || 'vanilla';
        const loaderVersion = item.loaderVersion || null;

        const id = this.uniqueInstanceId(item.name);
        // createInstance builds the skeleton (mods/, saves/, instance.json)
        this.instanceManager.createInstance(id, item.name, version, loaderType, loaderVersion);
        const destGameDir = path.join(this.instanceManager.baseDir, id);

        // Copy game-dir content
        this.copyContent(item.gameDir, destGameDir);

        // Merge instance-local version profiles into shared versions root
        let mergedProfiles = 0;
        if (item.customVersionsDir && this.rootVersionsDir) {
            mergedProfiles = this.mergeLocalVersions(item.customVersionsDir);
        }

        const gam = this.dirSize(destGameDir, 3);
        return {
            name: item.name,
            success: true,
            instanceId: id,
            version, loaderType, loaderVersion: loaderVersion || undefined,
            mergedProfiles,
            sizeMB: Math.round(gam / 1024 / 1024)
        };
    }

    uniqueInstanceId(name) {
        let base = String(name || 'imported').toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
        if (!base) base = 'imported';
        let candidate = base, n = 1;
        while (fs.existsSync(path.join(this.instanceManager.baseDir, candidate))) {
            n = (n >= 9 ? n * 10 : n + 1);
            candidate = `${base}-${n}`;
        }
        return candidate;
    }

    copyContent(srcGameDir, destGameDir) {
        if (!fs.existsSync(destGameDir)) fs.mkdirSync(destGameDir, { recursive: true });
        const notes = [];
        for (const dir of COPY_DIRS) {
            const src = path.join(srcGameDir, dir);
            if (!fs.existsSync(src)) continue;
            try {
                fs.cpSync(src, path.join(destGameDir, dir), { recursive: true, force: false, errorOnExist: false });
            } catch (err) {
                notes.push(`${dir}: ${err.message}`);
            }
        }
        for (const file of COPY_FILES) {
            const src = path.join(srcGameDir, file);
            if (!fs.existsSync(src)) continue;
            try { fs.cpSync(src, path.join(destGameDir, file), { force: false }); } catch (_) {}
        }
        if (notes.length) console.warn('[Import] copy notes:', notes);
    }

    mergeLocalVersions(srcVersionsDir) {
        let merged = 0;
        try {
            fs.mkdirSync(this.rootVersionsDir, { recursive: true });
            for (const e of fs.readdirSync(srcVersionsDir, { withFileTypes: true })) {
                if (!e.isDirectory()) continue;
                const srcProfile = path.join(srcVersionsDir, e.name);
                const destProfile = path.join(this.rootVersionsDir, e.name);
                if (fs.existsSync(destProfile)) continue; // never clobber
                fs.cpSync(srcProfile, destProfile, { recursive: true });
                merged++;
            }
        } catch (err) {
            console.error('[Import] versions merge failed:', err.message);
        }
        return merged;
    }
}

module.exports = ImportService;
