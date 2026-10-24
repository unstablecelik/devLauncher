const { app, BrowserWindow, ipcMain, shell, dialog, clipboard, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { Client, Authenticator } = require('minecraft-launcher-core');
const { Auth } = require('msmc');

const ConfigStore = require('./src/services/configStore');
const InstanceManager = require('./src/services/instanceManager');
const ThemeStore = require('./src/services/themeStore');
const ScreenshotManager = require('./src/services/screenshotManager');
const ModpackService = require('./src/services/modpackService');
const P2PService = require('./src/services/p2pService');
const discordRpc = require('./src/services/discordRpc');
const CrashAnalyzer = require('./src/services/crashAnalyzer');
const CleanerService = require('./src/services/cleanerService');
const WorldService = require('./src/services/worldService');
const OptimizerService = require('./src/services/optimizerService');
const UpdaterService = require('./src/services/updaterService');
const ImportService = require('./src/services/importService');
const AccountService = require('./src/services/accountService');
const SkinService = require('./src/services/skinService');
const ObjectStore = require('./src/services/objectStore');
const InstanceLedger = require('./src/services/instanceLedger');
const InstanceSnapshot = require('./src/services/instanceSnapshot');
const IntegrityService = require('./src/services/integrityService');
const ModDoctor = require('./src/services/modDoctor');
const ModrinthService = require('./src/services/modrinthService');
const PrefetchService = require('./src/services/prefetchService');
const BenchmarkService = require('./src/services/benchmarkService');

/**
 * Single source of truth for the launcher version. Build tooling, User-Agent
 * headers and Discord presence all derive from this so no code ever hardcodes
 * a different number.
 */
const { version: APP_VERSION } = require('./package.json');
const RemotePlayService = require('./src/services/remotePlayService');
const crypto = require('crypto');
const netClient = require('./src/services/netClient');

// Wire the launcher's entire networking through netClient: split between
// Electron's session (Chromium paths) and the Node https stack (tunneling
// agent). Honoured at startup and whenever the proxy settings change.
function applyNetworkProxy() {
    const cfg = configStore.getAll();
    netClient.applyProxy({ proxyMode: cfg.proxyMode, proxyUrl: cfg.proxyUrl });
    netClient.installNodeProxy({
        proxyMode: cfg.proxyMode,
        proxyUrl: cfg.proxyUrl,
        proxyUser: cfg.proxyUser,
        proxyPass: cfg.proxyPass
    });
}

// Proxy credentials for HTTP CONNECT 407 challenges on the session side.
app.on('login', (event, webContents, request, authInfo, callback) => {
    event.preventDefault();
    const cfg = configStore.getAll();
    if (cfg.proxyMode === 'custom' && cfg.proxyUser) {
        callback(cfg.proxyUser, cfg.proxyPass || '');
    } else {
        // otherwise leave the request to fall through / fail as unauthenticated
        callback();
    }
});

// ── Single instance lock (Windows: two launcher windows cause save conflicts) ──
const gotTheLock = app.requestSingleInstanceLock();
app.on('second-instance', () => {
    if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        else mainWindow.show();
        mainWindow.focus();
    }
});

// ── Safe Mode: park mods aside for one launch, restore afterwards ────────────
// When a mod breaks the game, the user can still boot the vanilla-equivalent
// environment. Mods are moved to <gameDir>/mods.safe-mode and restored:
//   right before the next NORMAL launch, or on app quit — whichever first.
function restoreModsAfterSafeMode(instanceId) {
    try {
        const gameDir = instanceManager.getInstanceGameDir(instanceId);
        const modsDir = path.join(gameDir, 'mods');
        const backupDir = path.join(gameDir, 'mods.safe-mode');
        if (fs.existsSync(backupDir) && !fs.existsSync(modsDir)) {
            fs.renameSync(backupDir, modsDir);
            console.log(`[SafeMode] restored mods for ${instanceId}`);
        }
    } catch (err) {
        console.error('[SafeMode] restore failed:', err.message);
    }
}

function disableModsForSafeMode(instanceId) {
    const gameDir = instanceManager.getInstanceGameDir(instanceId);
    const modsDir = path.join(gameDir, 'mods');
    const backupDir = path.join(gameDir, 'mods.safe-mode');
    if (fs.existsSync(modsDir) && !fs.existsSync(backupDir)) {
        fs.renameSync(modsDir, backupDir);
        console.log(`[SafeMode] parked mods of ${instanceId} (they come back after the run)`);
    }
}

ipcMain.on('launch-game-safe', async (event, config) => {
    try {
        const id = sanitizeInstanceId(config && config.instanceId);
        disableModsForSafeMode(id);
        // Reuse the full launch pipeline; the shim routes its progress events
        // back to the same window that asked for the safe launch.
        ipcMain.emit('launch-game', { reply: (ch, p) => { try { event.reply(ch, p); } catch (_) {} } }, config);
    } catch (err) {
        console.error('[SafeMode] launch failed:', err.message);
        event.reply('instance-operation-failed', err.message);
    }
});

app.on('before-quit', () => {
    // Safety net: nothing may keep mods hidden once the launcher exits.
    try {
        for (const ins of instanceManager.listInstances()) restoreModsAfterSafeMode(ins.id);
    } catch (_) {}
});
const { getInstalledJavaRuntimes, downloadAndInstallJava, detectJavaMajor } = require('./src/utils/javaDetector');

const p2pService = new P2PService();

function sanitizeInstanceId(value) {
    const v = (typeof value === 'string') ? value : null;
    if (!v || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(v) || v === '.' || v === '..') {
        throw new Error('Missing or invalid instance id');
    }
    if (!instanceManager.exists(v)) {
        throw new Error(`Instance "${v}" does not exist`);
    }
    return v;
}

function sanitizeModFilename(value) {
    if (typeof value !== 'string') return null;
    const base = path.basename(value);
    if (!base || base !== value || base.includes('/') || base.includes('\\') || base.includes('..')) return null;
    return base;
}

function resolveSafePath(basePath, ...parts) {
    const resolvedBase = path.resolve(basePath);
    const resolvedTarget = path.resolve(resolvedBase, ...parts);
    if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(resolvedBase + path.sep)) {
        throw new Error('Unsafe path detected');
    }
    return resolvedTarget;
}


app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-gpu-rasterization');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('disable-features', 'Vulkan,HardwareAcceleratedVideoDecode,VaapiVideoDecoder,MediaFoundationVideoEncoding');

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

const configStore = new ConfigStore();
const instanceManager = new InstanceManager();
// Time Machine backing store + per-instance change ledger
const objectStore = new ObjectStore(path.join(os.homedir(), '.devlauncher', 'objects'));
const ledger = new InstanceLedger(objectStore);
// Zero-cold-start prefetch + honest TTFP benchmark storage
const prefetch = new PrefetchService(path.join(os.homedir(), '.devlauncher'));
prefetch.onEvent = (channel, payload) => broadcastToMainWindow(channel, payload);
const benchmark = new BenchmarkService(path.join(os.homedir(), '.devlauncher', 'benchmarks.json'));
const remotePlay = new RemotePlayService();

// Time Machine helper: record any jars a bulk-installer dropped into mods/
function recordInstalledJars(safeInstanceId, instanceDir, newFilenames, txnId, note) {
    try {
        const modsDir = path.join(instanceDir, 'mods');
        for (const fn of newFilenames || []) {
            const safe = sanitizeModFilename(fn);
            if (safe && fs.existsSync(path.join(modsDir, safe))) {
                ledger.recordInstall(safeInstanceId, instanceDir, modsDir, safe, { txnId, note });
            }
        }
    } catch (err) {
        console.error('[Ledger] bulk record failed:', err.message);
    }
}
let mainWindow;

// Honor the user's Discord RPC toggle (config) at startup
discordRpc.setEnabled(configStore.get('enableDiscordRpc') !== false);
discordRpc.init();

// Surface tunnel lifecycle changes to the renderer so the P2P UI never lies
function broadcastToMainWindow(channel, payload) {
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : BrowserWindow.getAllWindows()[0];
    if (win) win.webContents.send(channel, payload);
}

p2pService.on('host-stopped', () => broadcastToMainWindow('p2p-host-stopped'));
p2pService.on('tunnel-error', (message) => broadcastToMainWindow('p2p-tunnel-error', message));

// ── Self-update ──────────────────────────────────────────────────────────────
const updater = new UpdaterService();
updater.init(broadcastToMainWindow);

function startUpdaterChecks() {
    updater.startChecking(!app.isPackaged);
}

ipcMain.on('install-update', () => updater.installUpdate());
ipcMain.on('check-for-update-manual', () => updater.checkNow());

// ── Prefetch (zero-cold-start) ───────────────────────────────────────────────
ipcMain.handle('prefetch-status', () => prefetch.summary());

ipcMain.handle('prefetch-now', async (event, versionArg) => {
    try {
        const version = (versionArg && String(versionArg)) || inferPrefetchVersion();
        return await prefetch.prefetchVersion(version, {
            includeAssets: true,
            assetByteCap: PrefetchService.assetByteCapFromMB(configStore.get('assetByteCapMB'))
        });
    } catch (err) {
        return { error: err.message };
    }
});

function inferPrefetchVersion() {
    const instanceId = configStore.get('selectedInstanceId');
    const cfg = instanceId ? (instanceManager.getInstance(instanceId) || {}) : {};
    return cfg.version || configStore.get('selectedVersion') || '1.21.1';
}

function startPrefetch() {
    try {
        const version = inferPrefetchVersion();
        if (!version) return;
        prefetch.prefetchVersion(version, {
            includeAssets: true,
            assetByteCap: PrefetchService.assetByteCapFromMB(configStore.get('assetByteCapMB'))
        }).catch(() => { /* status surfaced via events */ });
    } catch (_) {}
}

// ── Account hub + skin service (constructed after app is ready so that
// safeStorage and userData are fully available) ─────────────────────────────
let accountService = null;
let skinService = null;

function initAccountAndSkinServices() {
    const { safeStorage } = require('electron');
    accountService = new AccountService(configStore, safeStorage);
    skinService = new SkinService();
}

function parseVersionConfig(versionString) {
    if (!versionString) return { number: '1.21.1', custom: null, loaderVersion: null, loader: 'vanilla' };

    if (versionString.startsWith('fabric')) {
        const clean = versionString.replace(/^fabric-loader-|^fabric-/, '');
        const parts = clean.split('-');

        let loaderVersion = '0.19.5';
        let mcVersion = '';

        if (parts.length >= 2) {
            loaderVersion = parts[0];
            mcVersion = parts[1];
        } else {
            mcVersion = parts[0];
        }

        const customProfile = `fabric-loader-${loaderVersion}-${mcVersion}`;
        return {
            number: mcVersion,
            custom: customProfile,
            loaderVersion: loaderVersion,
            loader: 'fabric'
        };
    }

    if (versionString.startsWith('quilt')) {
        const clean = versionString.replace(/^quilt-loader-|^quilt-/, '');
        const parts = clean.split('-');

        let loaderVersion = '0.26.0';
        let mcVersion = '';

        if (parts.length >= 2) {
            loaderVersion = parts[0];
            mcVersion = parts[1];
        } else {
            mcVersion = parts[0];
        }

        const customProfile = `quilt-loader-${loaderVersion}-${mcVersion}`;
        return {
            number: mcVersion,
            custom: customProfile,
            loaderVersion: loaderVersion,
            loader: 'quilt'
        };
    }

    if (versionString.startsWith('neoforge')) {
        const mcVersion = versionString.replace(/^neoforge-/, '');
        return {
            number: mcVersion,
            custom: `neoforge-${mcVersion}`,
            loaderVersion: mcVersion,
            loader: 'neoforge'
        };
    }

    if (versionString.startsWith('forge')) {
        const clean = versionString.replace(/^forge-loader-|^forge-/, '');
        const parts = clean.split('-');

        let forgeVersion = '';
        let mcVersion = '';

        if (parts.length >= 2) {
            forgeVersion = parts[0];
            mcVersion = parts[1];
        } else {
            mcVersion = parts[0];
        }

        const customProfile = `${mcVersion}-forge-${forgeVersion}`;
        return {
            number: mcVersion,
            custom: customProfile,
            loaderVersion: forgeVersion,
            loader: 'forge'
        };
    }

    if (versionString.startsWith('optifine-forge')) {
        const mcVersion = versionString.replace(/^optifine-forge-/, '');
        return {
            number: mcVersion,
            custom: `OptiFine-Forge-${mcVersion}`,
            loaderVersion: 'optifine-forge',
            loader: 'optifine-forge'
        };
    }

    if (versionString.startsWith('optifine')) {
        const mcVersion = versionString.replace(/^optifine-/, '');
        return {
            number: mcVersion,
            custom: `OptiFine-${mcVersion}`,
            loaderVersion: 'optifine',
            loader: 'optifine'
        };
    }

    return {
        number: versionString,
        custom: null,
        loaderVersion: null,
        loader: 'vanilla'
    };
}

async function ensureLoaderProfileJson(parsed, minecraftDir) {
    if (!parsed || !parsed.custom) return;

    const customDir = path.join(minecraftDir, 'versions', parsed.custom);
    const customJson = path.join(customDir, `${parsed.custom}.json`);
    if (fs.existsSync(customJson)) return;

    if (parsed.custom.startsWith('fabric')) {
        const mcVersion = parsed.number;
        const loaderVersion = parsed.loaderVersion || '0.19.5';
        const url = `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`;
        const response = await fetch(url, { headers: { 'User-Agent': `devLauncher/${APP_VERSION}` } });
        if (!response.ok) {
            throw new Error(`Unable to fetch Fabric profile JSON (HTTP ${response.status})`);
        }
        const profile = await response.json();
        fs.mkdirSync(customDir, { recursive: true });
        fs.writeFileSync(customJson, JSON.stringify(profile, null, 2));
        console.log(`[devLauncher] Fabric profile generated: ${parsed.custom}`);
        return;
    }

    if (parsed.custom.startsWith('quilt')) {
        const mcVersion = parsed.number;
        const loaderVersion = parsed.loaderVersion || '0.26.0';
        const url = `https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`;
        const response = await fetch(url, { headers: { 'User-Agent': `devLauncher/${APP_VERSION}` } });
        if (response.ok) {
            const profile = await response.json();
            fs.mkdirSync(customDir, { recursive: true });
            fs.writeFileSync(customJson, JSON.stringify(profile, null, 2));
            console.log(`[devLauncher] Quilt profile generated: ${parsed.custom}`);
            return;
        }
    }

    throw new Error(`Loader profile is not installed and could not be generated automatically: ${parsed.custom}`);
}

// ── Forge / NeoForge installer handling ────────────────────────────────────
// MCLC launches modern Forge (1.13+) through ForgeWrapper by pointing `options.forge`
// at the installer jar. NeoForge installers share the same zip layout (version.json +
// install_profile.json) and every library in their version.json carries a direct
// downloads.artifact.url (verified against maven.neoforged.net), so the extracted
// version.json can be used as a plain MCLC custom profile.
const FORGE_CACHE_DIR = path.join(app.getPath('home'), '.devlauncher', 'forge', 'installers');

function ensureForgeCacheDir() {
    if (!fs.existsSync(FORGE_CACHE_DIR)) {
        fs.mkdirSync(FORGE_CACHE_DIR, { recursive: true });
    }
}

function downloadFileTo(url, targetPath) {
    return new Promise((resolve, reject) => {
        const get = (currentUrl, redirectCount) => {
            https.get(currentUrl, { headers: { 'User-Agent': `devLauncher/${APP_VERSION}` } }, (res) => {
                const status = res.statusCode || 0;
                if (status >= 300 && status < 400 && res.headers.location && redirectCount < 5) {
                    res.resume();
                    return get(new URL(res.headers.location, currentUrl).toString(), redirectCount + 1);
                }
                if (status !== 200) {
                    res.resume();
                    return reject(new Error(`Download failed (HTTP ${status}): ${currentUrl}`));
                }
                const fileStream = fs.createWriteStream(targetPath);
                res.pipe(fileStream);
                fileStream.on('finish', () => fileStream.close(resolve));
                fileStream.on('error', reject);
            }).on('error', (err) => reject(new Error(`Download error: ${err.message} (${currentUrl})`)));
        };
        get(url, 0);
    });
}

function extractInstallerProfileId(installerPath) {
    // Lightweight zip awareness without pulling adm-zip into the main process metro:
    // read central directory entries via adm-zip (already bundled by MCLC and now a direct dependency).
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(installerPath);
    const entry = zip.getEntry('version.json');
    if (!entry) throw new Error('Downloaded loader installer is invalid (no version.json inside).');
    const versionJson = JSON.parse(zip.readAsText(entry));
    if (!versionJson.id || !versionJson.inheritsFrom) {
        throw new Error('Loader installer version.json is missing id/inheritsFrom.');
    }
    return versionJson.id;
}

async function ensureForgeInstaller(parsed) {
    ensureForgeCacheDir();
    const installerPath = path.join(FORGE_CACHE_DIR, `${parsed.custom}`, `${parsed.custom}-installer.jar`);

    if (!fs.existsSync(installerPath) || fs.statSync(installerPath).size === 0) {
        const { forgeVersion, number: mcVersion } = parsed;
        if (!forgeVersion) {
            throw new Error(`No Forge build selected for Minecraft ${mcVersion}.`);
        }
        const url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${mcVersion}-${forgeVersion}/forge-${mcVersion}-${forgeVersion}-installer.jar`;
        fs.mkdirSync(path.dirname(installerPath), { recursive: true });
        console.log(`[devLauncher] Downloading Forge installer: ${url}`);
        await downloadFileTo(url, installerPath);
        try {
            extractInstallerProfileId(installerPath);
        } catch (err) {
            fs.unlinkSync(installerPath);
            throw err;
        }
        console.log(`[devLauncher] Forge installer cached: ${installerPath}`);
    }
    return installerPath;
}

// Minecraft 1.21.1 -> NeoForge 21.1.x, 1.20.4 -> 20.4.x etc.
function neoForgeBuildPrefix(mcVersion) {
    const parts = String(mcVersion).split('.');
    const minor = parts[1] || '0';
    const patch = parts[2] !== undefined && parts[2] !== '' ? parts[2] : '0';
    return `${minor}.${patch}`;
}

async function resolveLatestNeoForgeBuild(mcVersion) {
    const prefix = neoForgeBuildPrefix(mcVersion);
    const url = 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml';
    const response = await fetch(url, { headers: { 'User-Agent': `devLauncher/${APP_VERSION}` } });
    if (!response.ok) {
        throw new Error(`Unable to query NeoForge builds (HTTP ${response.status})`);
    }
    const xml = await response.text();
    const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map(m => m[1])
        .filter(v => v.startsWith(`${prefix}.`));
    versions.sort((a, b) => {
        const pa = a.split('.').map(Number);
        const pb = b.split('.').map(Number);
        for (let i = 0; i < 3; i++) {
            if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
        }
        return 0;
    });
    if (versions.length === 0) {
        throw new Error(`No NeoForge build found for Minecraft ${mcVersion} (prefix ${prefix}.x).`);
    }
    return versions[versions.length - 1];
}

async function ensureNeoForgeProfile(parsed) {
    ensureForgeCacheDir();
    const profileDirName = `${parsed.number}-neoforge`;
    const installerPath = path.join(FORGE_CACHE_DIR, profileDirName, 'installer.jar');

    if (!fs.existsSync(installerPath) || fs.statSync(installerPath).size === 0) {
        const build = await resolveLatestNeoForgeBuild(parsed.number);
        const url = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${build}/neoforge-${build}-installer.jar`;
        fs.mkdirSync(path.dirname(installerPath), { recursive: true });
        console.log(`[devLauncher] Downloading NeoForge ${build} installer: ${url}`);
        await downloadFileTo(url, installerPath);
        console.log(`[devLauncher] NeoForge installer cached: ${installerPath}`);
    }

    // Extract version.json into a regular MCLC custom profile
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(installerPath);
    const entry = zip.getEntry('version.json');
    if (!entry) {
        fs.unlinkSync(installerPath);
        throw new Error('NeoForge installer is invalid (no version.json inside).');
    }
    const profile = JSON.parse(zip.readAsText(entry));
    if (!profile.id || !profile.inheritsFrom) {
        fs.unlinkSync(installerPath);
        throw new Error('NeoForge installer version.json is missing id/inheritsFrom.');
    }

    const profileDir = path.join(app.getPath('home'), '.devlauncher', 'versions', profile.id);
    const profileJson = path.join(profileDir, `${profile.id}.json`);
    if (!fs.existsSync(profileJson)) {
        fs.mkdirSync(profileDir, { recursive: true });
        fs.writeFileSync(profileJson, JSON.stringify(profile, null, 2));
        console.log(`[devLauncher] NeoForge profile generated: ${profile.id} (Minecraft ${profile.inheritsFrom})`);
    }
    return { profileId: profile.id, installerPath };
}

// ── OptiFine ────────────────────────────────────────────────────────────────
// OptiFine serves their installer behind one-time session tokens which cannot be
// downloaded reliably from a launcher process (verified empirically). The profile
// must already exist locally (e.g. produced by the official OptiFine installer).
function ensureOptiFineProfileAvailable(parsed) {
    const profileDir = path.join(app.getPath('home'), '.devlauncher', 'versions', parsed.custom);
    const profileJson = path.join(profileDir, `${parsed.custom}.json`);
    if (fs.existsSync(profileJson)) return;
    throw new Error(
        `OptiFine profile "${parsed.custom}" is not installed. OptiFine cannot be downloaded reliably in-build; ` +
        'run the official OptiFine installer against this instance once, or install Sodium/Iris from the Mod Manager instead.'
    );
}

function checkVersionIsDownloaded(versionString) {
    if (!versionString) return false;
    const minecraftDir = path.join(app.getPath('home'), '.devlauncher');

    const parsed = parseVersionConfig(versionString);
    const gameVersion = parsed.number;

    const vanillaJson = path.join(minecraftDir, 'versions', gameVersion, `${gameVersion}.json`);
    const vanillaJar = path.join(minecraftDir, 'versions', gameVersion, `${gameVersion}.jar`);

    const vanillaDownloaded = fs.existsSync(vanillaJson) && fs.existsSync(vanillaJar);

    if (parsed.loader === 'forge') {
        // MCLC (ForgeWrapper) writes the generated profile to root/forge/{profileId}/version.json
        const forgeJson = path.join(minecraftDir, 'forge', parsed.custom, 'version.json');
        return (fs.existsSync(forgeJson) || fs.existsSync(path.join(FORGE_CACHE_DIR, parsed.custom, `${parsed.custom}-installer.jar`))) && vanillaDownloaded;
    }

    if (parsed.loader === 'neoforge') {
        const neoforgeInstaller = path.join(FORGE_CACHE_DIR, `${gameVersion}-neoforge`, 'installer.jar');
        return fs.existsSync(neoforgeInstaller) && vanillaDownloaded;
    }

    if (parsed.custom) {
        const customJson = path.join(minecraftDir, 'versions', parsed.custom, `${parsed.custom}.json`);
        return fs.existsSync(customJson) && vanillaDownloaded;
    }

    return vanillaDownloaded;
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1080,
        height: 680,
        minWidth: 860,
        minHeight: 560,
        resizable: true,
        frame: true,
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    mainWindow.setMenu(null);

    const indexPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(indexPath)) {
        mainWindow.loadFile(indexPath);
    } else {
        console.error('Could not find index.html');
    }

    discordRpc.updateActivity('devLauncher', 'Browsing Dashboard');
}

app.whenReady().then(() => {
    if (!gotTheLock) { app.quit(); return; } // a second launcher copy is already running
    // v2: align the saved selection with a REAL instance after legacy
    // migration (the old 'default' id no longer exists as a concept).
    (function syncSelection() {
        try {
            const sel = configStore.get('selectedInstanceId');
            if (!sel || sel === 'default' || !instanceManager.exists(sel)) {
                const first = instanceManager.listInstances()[0] || null;
                configStore.set('selectedInstanceId', first ? first.id : null);
            }
        } catch (e) {
            console.error('[Instances] selection sync failed:', e.message);
        }
    })();
    applyNetworkProxy(); // honour system/custom proxy before any network traffic
    // Safe Mode crash recovery: if the launcher previously died while mods
    // were parked, bring them back before anything else touches the disk.
    try {
        for (const ins of instanceManager.listInstances()) restoreModsAfterSafeMode(ins.id);
    } catch (_) {}
    createWindow();
    startUpdaterChecks();
    initAccountAndSkinServices();
    // Gentle delay: let the UI + update check go first, then pre-download
    // libraries/assets for the likely-next version in the background.
    setTimeout(() => startPrefetch(), 9000);

    // Remote Play: Sunshine app entry can ask devLauncher to boot an instance
    const launchFlag = process.argv.find(a => a.startsWith('--launch-instance='));
    if (launchFlag) {
        let instanceId = null;
        try {
            instanceId = sanitizeInstanceId(launchFlag.split('=')[1]);
        } catch (err) {
            console.error('[Startup] --launch-instance skipped:', err.message);
        }
        if (instanceId) {
            setTimeout(() => {
                try {
                    const cfg = configStore.getAll();
                    ipcMain.emit('launch-game', { reply: (ch, p) => broadcastToMainWindow(ch, p) }, {
                        instanceId,
                        username: cfg.username,
                        version: cfg.selectedVersion,
                        minRam: cfg.minRam,
                        maxRam: cfg.maxRam,
                        javaPath: cfg.javaPath,
                        enableJVMBoost: cfg.enableJVMBoost,
                        gcMode: cfg.gcMode
                    });
                } catch (err) {
                    console.error('[RemotePlay] auto-launch failed:', err);
                }
            }, 4000);
        }
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// Settings & Config IPC
ipcMain.on('get-config', (event) => {
    event.reply('config-data', configStore.getAll());
});

ipcMain.on('save-config', (event, data) => {
    configStore.update(data);
    if (data.proxyMode !== undefined || data.proxyUrl !== undefined || data.proxyUser !== undefined || data.proxyPass !== undefined) {
        applyNetworkProxy();
    }
    if (typeof data.enableDiscordRpc === 'boolean') {
        discordRpc.setEnabled(data.enableDiscordRpc);
    }
    if (data.discordClientId) {
        discordRpc.setClientId(data.discordClientId);
    }
    event.reply('config-saved', configStore.getAll());
});

// Dynamic Discord Presence IPC for Menu Sections
ipcMain.on('update-discord-presence', (event, { details, state }) => {
    discordRpc.updateActivity(details || 'devLauncher', state || 'In Menu');
});

// Theme IPC
const savedCustomTheme = configStore.get('customThemeData');
if (savedCustomTheme) {
    ThemeStore.setCustomTheme(savedCustomTheme);
}

ipcMain.on('get-themes', (event) => {
    event.reply('themes-list', {
        themes: ThemeStore.getAllThemes(),
        currentTheme: configStore.get('theme') || 'dark',
        customThemeData: configStore.get('customThemeData') || null
    });
});

ipcMain.on('set-theme', (event, themeKey) => {
    configStore.set('theme', themeKey);
    event.reply('theme-changed', {
        themeKey,
        themeData: ThemeStore.getTheme(themeKey)
    });
});

ipcMain.on('save-custom-theme', (event, customData) => {
    ThemeStore.setCustomTheme(customData);
    configStore.update({
        theme: 'custom',
        customThemeData: customData
    });
    event.reply('theme-changed', {
        themeKey: 'custom',
        themeData: ThemeStore.getTheme('custom')
    });
    event.reply('themes-list', {
        themes: ThemeStore.getAllThemes(),
        currentTheme: 'custom',
        customThemeData: customData
    });
});

// Java Runtimes (Linux OpenJDK / System Java / Auto-Installer)
ipcMain.on('detect-java-runtimes', (event) => {
    const runtimes = getInstalledJavaRuntimes();
    event.reply('java-runtimes-detected', runtimes);
});

ipcMain.on('auto-install-java', async (event, majorVersion) => {
    try {
        const javaPath = await downloadAndInstallJava(majorVersion || 21);
        configStore.set('javaPath', javaPath);
        const runtimes = getInstalledJavaRuntimes();
        event.reply('java-installed-success', { javaPath, runtimes });
    } catch (err) {
        console.error('[Java Auto-Installer Error]:', err);
        event.reply('java-installed-failed', err.message);
    }
});

// Open Instance folder
ipcMain.on('open-mods-folder', (event, instanceId) => {
    let safeInstanceId;
    try {
        safeInstanceId = sanitizeInstanceId(instanceId);
    } catch (err) {
        console.error('[Mods] open folder failed:', err.message);
        event.reply('instance-operation-failed', err.message);
        return;
    }
    const instanceDir = instanceManager.getInstanceGameDir(safeInstanceId);
    const modsDir = resolveSafePath(instanceDir, 'mods');

    if (!fs.existsSync(modsDir)) {
        fs.mkdirSync(modsDir, { recursive: true });
    }
    shell.openPath(modsDir);
});

// ── Import Wizard (Prism / MultiMC / vanilla) ────────────────────────────────
const importService = new ImportService(instanceManager, path.join(app.getPath('home'), '.devlauncher', 'versions'));

ipcMain.handle('import-scan', async () => {
    try {
        return importService.listSources();
    } catch (err) {
        console.error('[Import] scan error:', err);
        return [];
    }
});

ipcMain.handle('import-run', async (event, items) => {
    try {
        return importService.importItems(Array.isArray(items) ? items : []);
    } catch (err) {
        return [{ name: '?', success: false, error: err.message }];
    }
});

// Installed Mods Management IPC
ipcMain.on('get-installed-mods', (event, instanceId) => {
    let safeInstanceId;
    try {
        safeInstanceId = sanitizeInstanceId(instanceId);
    } catch (err) {
        event.reply('installed-mods-list', []);
        return;
    }
    const instanceDir = instanceManager.getInstanceGameDir(safeInstanceId);
    const modsDir = resolveSafePath(instanceDir, 'mods');

    if (!fs.existsSync(modsDir)) {
        fs.mkdirSync(modsDir, { recursive: true });
    }

    try {
        const files = fs.readdirSync(modsDir);
        const mods = files
            .filter(f => f.endsWith('.jar') || f.endsWith('.jar.disabled'))
            .map(filename => ({
                filename,
                name: filename.replace(/\.jar(\.disabled)?$/, ''),
                enabled: filename.endsWith('.jar')
            }));
        event.reply('installed-mods-list', mods);
    } catch (err) {
        event.reply('installed-mods-list', []);
    }
});

ipcMain.on('toggle-mod', (event, { instanceId, filename }) => {
    let safeInstanceId;
    try {
        safeInstanceId = sanitizeInstanceId(instanceId);
    } catch (err) {
        console.error('[Mods] toggle failed:', err.message);
        event.reply('installed-mods-list', []);
        return;
    }
    const safeFilename = sanitizeModFilename(filename);
    const instanceDir = instanceManager.getInstanceGameDir(safeInstanceId);
    const modsDir = resolveSafePath(instanceDir, 'mods');

    if (!safeFilename) return;

    // Transactional toggle (rename + Time Machine record in one step)
    try {
        ledger.recordToggle(safeInstanceId, instanceDir, modsDir, safeFilename);
    } catch (err) {
        console.error('[Ledger] toggle failed:', err.message);
    }

    const files = fs.readdirSync(modsDir);
    const mods = files
        .filter(f => f.endsWith('.jar') || f.endsWith('.jar.disabled'))
        .map(fn => ({
            filename: fn,
            name: fn.replace(/\.jar(\.disabled)?$/, ''),
            enabled: fn.endsWith('.jar')
        }));
    event.reply('installed-mods-list', mods);
});

ipcMain.on('delete-mod', (event, { instanceId, filename }) => {
    let safeInstanceId;
    try {
        safeInstanceId = sanitizeInstanceId(instanceId);
    } catch (err) {
        console.error('[Mods] delete failed:', err.message);
        event.reply('installed-mods-list', []);
        return;
    }
    const safeFilename = sanitizeModFilename(filename);
    const instanceDir = instanceManager.getInstanceGameDir(safeInstanceId);
    const modsDir = resolveSafePath(instanceDir, 'mods');

    if (!safeFilename) return;

    // Transactional delete: content is stashed in the Time Machine store first
    try {
        ledger.recordRemove(safeInstanceId, instanceDir, modsDir, safeFilename);
    } catch (err) {
        console.error('[Ledger] remove failed:', err.message);
    }

    const files = fs.readdirSync(modsDir);
    const mods = files
        .filter(f => f.endsWith('.jar') || f.endsWith('.jar.disabled'))
        .map(fn => ({
            filename: fn,
            name: fn.replace(/\.jar(\.disabled)?$/, ''),
            enabled: fn.endsWith('.jar')
        }));
    event.reply('installed-mods-list', mods);
});

// ── Time Machine (mod history & rollback) ────────────────────────────────────
ipcMain.handle('mod-history', (event, instanceId) => {
    try {
        const safeInstanceId = sanitizeInstanceId(instanceId);
        const instanceDir = instanceManager.getInstanceGameDir(safeInstanceId);
        const history = ledger.history(instanceDir, 150);
        return { ok: true, history, storeMb: objectStore.stats().mb };
    } catch (err) {
        return { ok: false, error: err.message, history: [] };
    }
});

ipcMain.handle('mod-rollback', (event, { instanceId, entryId }) => {
    try {
        const safeInstanceId = sanitizeInstanceId(instanceId);
        const instanceDir = instanceManager.getInstanceGameDir(safeInstanceId);
        const result = ledger.rollbackEntry(safeInstanceId, instanceDir, entryId);
        return result;
    } catch (err) {
        return { success: false, error: err.message };
    }
});

// ── Remote Play (Sunshine host config; v1) ───────────────────────────────────
ipcMain.handle('remote-detect', () => remotePlay.detect());

ipcMain.handle('remote-ensure-app', (event, { instanceId, instanceName }) => {
    try {
        const detected = remotePlay.detect();
        if (!detected.found) return { ok: false, error: 'Sunshine config not found on this machine' };
        const binary = process.env.APPIMAGE || process.execPath;
        const entry = RemotePlayService.buildAppEntry(binary, instanceId, instanceName);
        return remotePlay.writeAppsJson(detected.appsJsonPath, entry);
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('remote-pin', async (event, pin) => remotePlay.pairPin(pin));

ipcMain.on('remote-open-ui', () => {
    shell.openExternal('https://127.0.0.1:47990').catch(() => {});
});

// ── Benchmark summary for UI ─────────────────────────────────────────────────
ipcMain.handle('benchmark-summary', () => benchmark.summary(8));

// ── Faz 4: Mod Updates / Share Code / 1-Click Server / World Preview / LAN ──
const UpdateChecker = require('./src/services/updateChecker');
const ShareCode = require('./src/services/shareCode');
const ServerExporter = require('./src/services/serverExporter');
const WorldPreview = require('./src/services/worldPreview');

const SERVERS_ROOT = path.join(app.getPath('home'), '.devlauncher', 'servers');
const PLAYTIME_PATH = path.join(app.getPath('home'), '.devlauncher', 'playtime.json');
const serverExporter = new ServerExporter(SERVERS_ROOT, path.join(app.getPath('home'), '.devlauncher'));

function readPlaytime() {
    try { return JSON.parse(fs.readFileSync(PLAYTIME_PATH, 'utf8')) || {}; } catch (_) { return {}; }
}

function recordPlaytime(instanceId, startTs) {
    try {
        const minutes = Math.max(0, Math.round((Date.now() - startTs) / 60000));
        if (minutes < 1) return;
        const map = readPlaytime();
        map[instanceId] = map[instanceId] || { totalMinutes: 0, sessions: 0, lastPlayed: null };
        map[instanceId].totalMinutes += minutes;
        map[instanceId].sessions += 1;
        map[instanceId].lastPlayed = new Date().toISOString();
        fs.writeFileSync(PLAYTIME_PATH, JSON.stringify(map, null, 1));
    } catch (err) {
        console.error('[Playtime] record failed:', err.message);
    }
}

function instancesForUi() {
    const map = readPlaytime();
    return instanceManager.listInstances().map(ins => ({
        ...ins,
        playtimeHours: +(((map[ins.id] || {}).totalMinutes || 0) / 60).toFixed(1)
    }));
}
instancesForUi(); // warm-up (also migrates the default instance if needed)

ipcMain.on('check-mod-updates', async (event, instanceId) => {
    try {
        const safeInstanceId = sanitizeInstanceId(instanceId);
        const instanceDir = instanceManager.getInstanceGameDir(safeInstanceId);
        const inst = instanceManager.getInstance(safeInstanceId) || {};
        const mcVersion = inst.version || configStore.get('selectedVersion') || '1.21.1';
        const loader = inst.loaderType && inst.loaderType !== 'optifine' && inst.loaderType !== 'optifine-forge' ? inst.loaderType : 'fabric';
        const rows = await UpdateChecker.checkInstance({ modsDir: path.join(instanceDir, 'mods'), mcVersion, loader });
        event.reply('mod-updates-result', { ok: true, rows, mcVersion, loader });
    } catch (err) {
        event.reply('mod-updates-result', { ok: false, error: err.message });
    }
});

ipcMain.on('update-mods-all', async (event, instanceId) => {
    try {
        const safeInstanceId = sanitizeInstanceId(instanceId);
        const instanceDir = instanceManager.getInstanceGameDir(safeInstanceId);
        const modsDir = path.join(instanceDir, 'mods');
        const inst = instanceManager.getInstance(safeInstanceId) || {};
        const mcVersion = inst.version || configStore.get('selectedVersion') || '1.21.1';
        const loader = inst.loaderType && inst.loaderType !== 'optifine' && inst.loaderType !== 'optifine-forge' ? inst.loaderType : 'fabric';
        const pending = (await UpdateChecker.checkInstance({ modsDir, mcVersion, loader })).filter(r => r.updateAvailable);
        if (pending.length === 0) {
            event.reply('mod-update-complete', { ok: true, updated: [] });
            return;
        }
        const txnId = `modupdate-${Date.now().toString(36)}`;
        const updated = [], failed = [];
        for (const [i, row] of pending.entries()) {
            event.reply('mod-update-progress', { current: i + 1, total: pending.length, file: row.latestFilename || row.filename });
            const dest = path.join(modsDir, row.latestFilename);
            const dl = await UpdateChecker.downloadVerified(row.downloadUrl, dest, row.latestSha1);
            if (dl.ok) {
                if (row.latestFilename !== row.filename) {
                    try {
                        fs.rmSync(path.join(modsDir, row.filename), { force: true });
                        ledger.recordRemove(safeInstanceId, instanceDir, modsDir, row.filename, { txnId: txnId + '-rm', note: 'replaced by update' });
                    } catch (_) {}
                }
                ledger.recordInstall(safeInstanceId, instanceDir, modsDir, row.latestFilename, { txnId, note: `update ${row.project}: ${row.currentVersion} → ${row.latestVersion}` });
                updated.push(row.latestFilename);
            } else {
                failed.push({ file: row.filename, error: dl.error });
            }
        }
        event.reply('mod-update-complete', { ok: true, updated, failed });
    } catch (err) {
        event.reply('mod-update-complete', { ok: false, error: err.message });
    }
});

ipcMain.on('share-code-generate', async (event, instanceId) => {
    try {
        const safeInstanceId = sanitizeInstanceId(instanceId);
        const instanceDir = instanceManager.getInstanceGameDir(safeInstanceId);
        const inst = instanceManager.getInstance(safeInstanceId) || {};
        const collected = await ShareCode.collect(path.join(instanceDir, 'mods'), inst.version, (inst.loaderType || 'vanilla') === 'forge' ? 'forge' : (inst.loaderType || 'vanilla'));
        const code = ShareCode.encode({
            v: 1,
            n: inst.name || safeInstanceId,
            mv: inst.version || '1.21.1',
            lt: inst.loaderType || 'vanilla',
            lv: inst.loaderVersion || null,
            mods: collected.mods
        });
        event.reply('share-code-generated', { ok: true, code, modCount: collected.mods.length, unknown: collected.unknown });
    } catch (err) {
        event.reply('share-code-generated', { ok: false, error: err.message });
    }
});

ipcMain.on('share-code-import', async (event, code) => {
    try {
        const dec = ShareCode.decode(code);
        if (!dec.ok) return event.reply('share-code-import-result', dec);
        const d = dec.data;
        const displayName = String(d.n || '').trim() || 'Imported Instance';
        const created = instanceManager.createInstance({
            name: displayName,
            mcVersion: d.mv,
            loaderType: d.lt,
            loaderVersion: d.lv
        });
        const instanceId = created.id;
        const instanceDir = instanceManager.getInstanceGameDir(instanceId);
        const modsDir = path.join(instanceDir, 'mods');
        fs.mkdirSync(modsDir, { recursive: true });
        const installed = [], failures = [];
        for (const [i, entry] of d.mods.entries()) {
            event.reply('share-code-import-progress', { current: i + 1, total: d.mods.length });
            const resolved = await ShareCode.resolveDownload(entry, d.mv, d.lt);
            if (!resolved.ok) { failures.push({ project: entry.p, error: resolved.error }); continue; }
            const dl = await UpdateChecker.downloadVerified(resolved.url, path.join(modsDir, resolved.filename), resolved.sha1);
            if (dl.ok) {
                ledger.recordInstall(instanceId, instanceDir, modsDir, resolved.filename, { txnId: `sharecode-${Date.now().toString(36)}`, note: `share code import (project ${entry.p})` });
                installed.push(resolved.filename);
            } else {
                failures.push({ project: entry.p, error: dl.error });
            }
        }
        event.reply('share-code-import-result', { ok: true, instanceId, installed: installed.length, installedNames: installed, failures, total: d.mods.length });
        event.reply('instances-list', instancesForUi());
    } catch (err) {
        event.reply('share-code-import-result', { ok: false, error: err.message });
    }
});

ipcMain.on('create-server-from-instance', async (event, instanceId) => {
    try {
        const safeInstanceId = sanitizeInstanceId(instanceId);
        const inst = instanceManager.getInstance(safeInstanceId) || {};
        if (!inst.version) return event.reply('server-create-result', { ok: false, error: 'Active instance has no version recorded' });
        const instanceDir = instanceManager.getInstanceGameDir(safeInstanceId);
        const result = await serverExporter.createServer({
            name: inst.name || safeInstanceId,
            version: inst.version,
            loaderType: inst.loaderType || 'vanilla',
            loaderVersion: inst.loaderVersion || null,
            instanceDir,
            maxRam: configStore.get('maxRam') || '4G'
        }, (msg) => event.reply('server-create-progress', { message: msg }));
        if (result.ok) shell.openPath(result.serverDir);
        event.reply('server-create-result', result);
    } catch (err) {
        event.reply('server-create-result', { ok: false, error: err.message });
    }
});

ipcMain.on('world-preview-show', (event, { instanceId, worldFolder }) => {
    try {
        const safeInstanceId = sanitizeInstanceId(instanceId);
        if (!worldFolder || !/^[\w .()\-\u00c0-\u024f]+$/.test(worldFolder)) return event.reply('world-preview-result', { ok: false, error: 'Invalid world folder name' });
        const instanceDir = instanceManager.getInstanceGameDir(safeInstanceId);
        event.reply('world-preview-result', WorldPreview.previewSpawn(path.join(instanceDir, 'saves', worldFolder)));
    } catch (err) {
        event.reply('world-preview-result', { ok: false, error: err.message });
    }
});

// ── Instance snapshots (v2) ─────────────────────────────────────────────
ipcMain.on('snapshot-create', (event, { instanceId, label }) => {
    try {
        const safeInstanceId = sanitizeInstanceId(instanceId);
        const instanceDir = instanceManager.getInstanceGameDir(safeInstanceId);
        if (!fs.existsSync(instanceDir)) throw new Error('Instance folder not found');
        event.reply('snapshot-created', { ok: true, manifest: instanceSnapshots.create(safeInstanceId, instanceDir, label) });
    } catch (err) {
        event.reply('snapshot-created', { ok: false, error: err.message });
    }
});

ipcMain.on('snapshot-list', (event, instanceId) => {
    try {
        const safeInstanceId = sanitizeInstanceId(instanceId);
        event.reply('snapshot-list-result', { ok: true, snapshots: instanceSnapshots.list(safeInstanceId) });
    } catch (err) {
        event.reply('snapshot-list-result', { ok: false, error: err.message, snapshots: [] });
    }
});

ipcMain.on('snapshot-restore', (event, { instanceId, snapshotId }) => {
    try {
        const safeInstanceId = sanitizeInstanceId(instanceId);
        const instanceDir = instanceManager.getInstanceGameDir(safeInstanceId);
        event.reply('snapshot-restored', { ok: true, ...instanceSnapshots.restore(safeInstanceId, snapshotId, instanceDir) });
    } catch (err) {
        event.reply('snapshot-restored', { ok: false, error: err.message });
    }
});

ipcMain.on('snapshot-delete', (event, { instanceId, snapshotId }) => {
    try {
        const safeInstanceId = sanitizeInstanceId(instanceId);
        instanceSnapshots.delete(safeInstanceId, snapshotId);
        event.reply('snapshot-deleted', { ok: true });
    } catch (err) {
        event.reply('snapshot-deleted', { ok: false, error: err.message });
    }
});

// ── Integrity sweep (libraries verification + repair) ──────────────────
ipcMain.handle('integrity-list-versions', async () => {
    try {
        const rootDir = path.join(app.getPath('home'), '.devlauncher');
        const versionsDir = path.join(rootDir, 'versions');
        if (!fs.existsSync(versionsDir)) return { ok: true, versions: [] };
        const versions = fs.readdirSync(versionsDir).filter(v =>
            /^[\w.+-]+$/.test(v) && fs.existsSync(path.join(versionsDir, v, `${v}.json`))
        );
        return { ok: true, versions };
    } catch (err) {
        return { ok: false, error: err.message, versions: [] };
    }
});

ipcMain.handle('integrity-scan', async (event, versionId) => {
    try {
        const rootDir = path.join(app.getPath('home'), '.devlauncher');
        const service = new IntegrityService({ rootDir });
        const result = service.scan(String(versionId));
        return { ok: true, ...result };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('integrity-repair', async (event, { versionId, entries }) => {
    try {
        const rootDir = path.join(app.getPath('home'), '.devlauncher');
        const service = new IntegrityService({ rootDir });
        const report = await service.repair(entries);
        const after = service.scan(String(versionId));
        return { ok: true, ...report, after };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.on('get-lan-info', (event) => {
    const ips = [];
    for (const list of Object.values(os.networkInterfaces())) {
        for (const n of list || []) {
            if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
        }
    }
    event.reply('lan-info', { ok: true, ips });
});

// ── UI prefs & About ─────────────────────────────────────────────────────────
ipcMain.on('save-ui-font', (event, fontStack) => {
    if (typeof fontStack === 'string' && fontStack.length <= 200 && /^[A-Za-z0-9 '\",\-_]+$/.test(fontStack)) {
        configStore.update({ uiFont: fontStack });
    }
});

ipcMain.handle('get-app-info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform
}));

// ── Connectivity Doctor ─────────────────────────────────────────────────────
let lastNetworkDiagnostics = null;

ipcMain.handle('connectivity-test', async () => {
    const endpoints = [
        { id: 'mojang-meta', label: 'Mojang versions & launcher meta', url: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json' },
        { id: 'mojang-libs', label: 'Mojang libraries CDN', url: 'https://libraries.minecraft.net/' },
        { id: 'mojang-assets', label: 'Mojang assets CDN', url: 'https://resources.download.minecraft.net/' },
        { id: 'mojang-session', label: 'Mojang session server', url: 'https://sessionserver.mojang.com/' },
        { id: 'modrinth-api', label: 'Modrinth API (mods)', url: 'https://api.modrinth.com/v2/' },
        { id: 'modrinth-cdn', label: 'Modrinth CDN (file downloads)', url: 'https://cdn.modrinth.com/' },
        { id: 'adoptium', label: 'Adoptium (automatic Java install)', url: 'https://api.adoptium.net/v3/info' },
        { id: 'github', label: 'GitHub (launcher self-update)', url: 'https://api.github.com/' }
    ];
    const probe = async (e) => {
        const started = Date.now();
        try {
            const res = await netClient.fetch(e.url, { timeoutMs: 12000 });
            const ms = Date.now() - started;
            // Anything below 500 means the network path works (404/405 on root paths are fine).
            return { ...e, reachable: res.status < 500, status: res.status, ms };
        } catch (err) {
            const msg = String(err.message || err);
            return { ...e, reachable: false, status: 0, ms: Date.now() - started, error: /abort|timed? out/i.test(msg) ? 'timeout' : /getaddr|ENOTFOUND|dns/i.test(msg) ? 'DNS blocked' : 'blocked or unreachable', detail: msg.slice(0, 140) };
        }
    };
    lastNetworkDiagnostics = { generatedAt: new Date().toISOString(), endpoints: await Promise.all(endpoints.map(probe)) };
    return { ok: true, ...lastNetworkDiagnostics, proxyMode: configStore.get('proxyMode') || 'system' };
});

// ── Diagnostics zip (bug reports) ────────────────────────────────────────────
ipcMain.handle('export-diagnostics', async (event) => {
    try {
        const AdmZip = require('adm-zip');
        const zip = new AdmZip();
        const addIfExists = (p, zipPath) => {
            if (fs.existsSync(p)) try { zip.addLocalFile(p, zipPath); } catch (_) {}
        };
        // Metadata first (redacted: no accounts, no tokens)
        const cfg = configStore.getAll();
        delete cfg.microsoftAuthData;
        delete cfg.accounts;
        zip.addFile('config-redacted.json', JSON.stringify(cfg, null, 2));
        zip.addFile('about.json', JSON.stringify({
            appVersion: app.getVersion(),
            electron: process.versions.electron,
            node: process.versions.node,
            platform: process.platform,
            generatedAt: new Date().toISOString()
        }, null, 2));
        if (fs.existsSync(LOGS_DIR)) {
            for (const f of fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.log') || f.endsWith('.txt'))) {
                addIfExists(path.join(LOGS_DIR, f), 'logs');
            }
        }
        try {
            for (const inst of instanceManager.listInstances()) {
                const dir = instanceManager.getInstanceGameDir(inst.id);
                const meta = path.join(dir, 'instance.json');
                addIfExists(meta, `instances/${inst.id}`);
                addIfExists(path.join(dir, 'instanceLedger.jsonl'), `instances/${inst.id}`);
                const crashDir = path.join(dir, 'crash-reports');
                if (fs.existsSync(crashDir)) {
                    for (const f of fs.readdirSync(crashDir).filter(f => f.endsWith('.txt')).slice(-3)) {
                        addIfExists(path.join(crashDir, f), `instances/${inst.id}/crash-reports`);
                    }
                }
            }
        } catch (_) {}
        if (fs.existsSync(benchmark.storagePath)) addIfExists(benchmark.storagePath, 'benchmark');
        if (lastNetworkDiagnostics) {
            zip.addFile('connectivity-report.json', JSON.stringify(lastNetworkDiagnostics, null, 2));
        }
        const out = path.join(app.getPath('desktop'), `devlauncher-diagnostics-${Date.now().toString(36)}.zip`);
        zip.writeZip(out);
        return { ok: true, path: out };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

// ── Mod Doctor (static jar health check) ─────────────────────────────────────
const modDoctor = new ModDoctor();

ipcMain.handle('mod-doctor-scan', (event, instanceId) => {
    try {
        const safeInstanceId = sanitizeInstanceId(instanceId);
        const instanceDir = instanceManager.getInstanceGameDir(safeInstanceId);
        const instanceConfig = instanceManager.getInstance(safeInstanceId) || {};
        return modDoctor.scan(path.join(instanceDir, 'mods'), instanceConfig);
    } catch (err) {
        return { ok: false, error: err.message, entries: [], duplicateIds: [], missingDependencies: [], summary: { total: 0, ok: 0, warn: 0, error: 0, disabled: 0 } };
    }
});

// Rename (display name only - the id is permanent) and Duplicate
ipcMain.on('rename-instance', (event, { instanceId, newName }) => {
    try {
        const id = sanitizeInstanceId(instanceId);
        const name = String(newName || '').trim().slice(0, 60);
        if (!name) {
            event.reply('instance-operation-failed', 'Instance name must not be empty');
            return;
        }
        instanceManager.renameInstance(id, name);
        event.reply('instances-list', instancesForUi());
    } catch (err) {
        event.reply('instance-operation-failed', err.message);
    }
});

ipcMain.on('duplicate-instance', (event, { instanceId }) => {
    try {
        const id = sanitizeInstanceId(instanceId);
        const created = instanceManager.duplicateInstance(id, '');
        event.reply('instances-list', instancesForUi());
        console.log(`[InstanceManager] duplicated "${id}" into "${created.id}"`);
    } catch (err) {
        event.reply('instance-operation-failed', err.message);
    }
});

// Screenshots IPC
ipcMain.on('get-screenshots', (event, instanceId) => {
    let safeInstanceId;
    try {
        safeInstanceId = sanitizeInstanceId(instanceId);
    } catch (err) {
        event.reply('screenshots-list', []);
        return;
    }
    const instanceDir = instanceManager.getInstanceGameDir(safeInstanceId);
    const screenshots = ScreenshotManager.getScreenshots(instanceDir);
    event.reply('screenshots-list', screenshots);
});

ipcMain.on('copy-screenshot-clipboard', (event, filePath) => {
    try {
        // Only allow reading images that live inside any instance's screenshots folder
        const requested = path.resolve(String(filePath || ''));
        const instancesRoot = path.resolve(instanceManager.baseDir);
        const withinAnyInstance =
            requested.startsWith(instancesRoot + path.sep) &&
            requested.slice(instancesRoot.length + 1).split(path.sep).slice(1, 2).join() === 'screenshots';
        if (!withinAnyInstance) {
            return event.reply('copy-screenshot-result', { success: false, error: 'Access denied' });
        }
        if (!fs.existsSync(requested)) {
            return event.reply('copy-screenshot-result', { success: false, error: 'File not found' });
        }
        const img = nativeImage.createFromPath(requested);
        clipboard.writeImage(img);
        event.reply('copy-screenshot-result', { success: true });
    } catch (e) {
        event.reply('copy-screenshot-result', { success: false, error: e.message });
    }
});

ipcMain.on('export-screenshots-zip', async (event, instanceId) => {
    try {
        const safeInstanceId = sanitizeInstanceId(instanceId);
        const instanceDir = instanceManager.getInstanceGameDir(safeInstanceId);
        const saveRes = await dialog.showSaveDialog(mainWindow, {
            title: 'Export Screenshots (.zip)',
            defaultPath: path.join(app.getPath('downloads'), `${safeInstanceId}-screenshots.zip`),
            filters: [{ name: 'Zip Archive', extensions: ['zip'] }]
        });
        if (!saveRes.canceled && saveRes.filePath) {
            ScreenshotManager.exportScreenshotsToZip(instanceDir, saveRes.filePath);
            event.reply('export-screenshots-success', saveRes.filePath);
        }
    } catch (err) {
        event.reply('export-screenshots-failed', err.message);
    }
});

// World / Saves IPC
ipcMain.on('get-worlds', (event, instanceId) => {    try {
        const safeInstanceId = sanitizeInstanceId(instanceId);
        const instanceDir = instanceManager.getInstanceGameDir(safeInstanceId);
        const worlds = WorldService.listWorlds(instanceDir).map(w => ({
            ...w,
            stats: WorldPreview.readLevelDat(path.join(instanceDir, 'saves', w.folderName))
        }));
        event.reply('worlds-list', worlds);
    } catch (err) {
        event.reply('worlds-list', []);
    }
});

ipcMain.on('backup-world', async (event, { instanceId, worldFolder }) => {
    try {
        const safeInstanceId = sanitizeInstanceId(instanceId);
        // worldFolder comes from the renderer — reject traversal before touching the filesystem
        const safeWorldFolder = (typeof worldFolder === 'string' &&
            worldFolder.length > 0 &&
            !worldFolder.includes('/') &&
            !worldFolder.includes('\\') &&
            !worldFolder.includes('..')) ? worldFolder : null;
        if (!safeWorldFolder) {
            return event.reply('backup-world-failed', 'Invalid world folder name');
        }
        const instanceDir = instanceManager.getInstanceGameDir(safeInstanceId);
        const saveRes = await dialog.showSaveDialog(mainWindow, {
            title: `Backup World (${safeWorldFolder})`,
            defaultPath: path.join(app.getPath('downloads'), `${safeWorldFolder}-backup.zip`),
            filters: [{ name: 'Zip Archive', extensions: ['zip'] }]
        });
        if (!saveRes.canceled && saveRes.filePath) {
            WorldService.backupWorld(instanceDir, safeWorldFolder, saveRes.filePath);
            event.reply('backup-world-success', saveRes.filePath);
        }
    } catch (err) {
        event.reply('backup-world-failed', err.message);
    }
});

// Smart Storage Cleaner IPC
ipcMain.on('scan-garbage', (event) => {
    try {
        const rootMinecraftDir = path.join(app.getPath('home'), '.devlauncher');
        const report = CleanerService.scanGarbage(rootMinecraftDir);
        event.reply('garbage-scan-result', report);
    } catch (err) {
        event.reply('garbage-scan-result', { totalMB: '0.00', filesCount: 0 });
    }
});

ipcMain.on('clean-garbage', (event) => {
    try {
        const rootMinecraftDir = path.join(app.getPath('home'), '.devlauncher');
        const res = CleanerService.cleanGarbage(rootMinecraftDir);
        event.reply('garbage-clean-result', res);
    } catch (err) {
        event.reply('garbage-clean-result', { deletedMB: '0.00', deletedCount: 0 });
    }
});

// FPS Optimizer IPC
ipcMain.on('get-optimization-mods', (event, { loaderType, mcVersion }) => {
    const mods = OptimizerService.getRecommendedMods(loaderType, mcVersion);
    event.reply('optimization-mods-list', mods);
});

// Crash Analyzer IPC
const crashAnalyzer = new CrashAnalyzer();

ipcMain.on('analyze-crash', (event, { instanceId, customLog }) => {
    try {
        let logContent = customLog;
        const safeInstanceId = sanitizeInstanceId(instanceId);
        const instanceDir = instanceManager.getInstanceGameDir(safeInstanceId);

        if (!logContent) {
            logContent = CrashAnalyzer.getLatestCrashReport(instanceDir) || CrashAnalyzer.getLatestLog(instanceDir);
        }

        if (!logContent) {
            return event.reply('crash-analysis-result', { found: false, message: 'No crash report or log file found.' });
        }

        const diagnosis = crashAnalyzer.analyze(logContent);
        event.reply('crash-analysis-result', {
            found: true,
            diagnosis,
            rawLogLength: logContent.length
        });
    } catch (err) {
        event.reply('crash-analysis-result', { found: false, error: err.message });
    }
});

ipcMain.on('autofix-crash', async (event, { instanceId, autoFix, searchTerm }) => {
    try {
        const safeInstanceId = sanitizeInstanceId(instanceId);
        const instanceDir = instanceManager.getInstanceGameDir(safeInstanceId);
        const modsDir = path.join(instanceDir, 'mods');

        if (autoFix.type === 'disable_mod' && autoFix.target) {
            if (fs.existsSync(modsDir)) {
                const files = fs.readdirSync(modsDir);
                const targetMod = files.find(f => f.toLowerCase().includes(autoFix.target.toLowerCase()) && f.endsWith('.jar'));
                if (targetMod) {
                    try {
                        ledger.recordToggle(safeInstanceId, instanceDir, modsDir, targetMod, { note: 'crash autofix' });
                    } catch (ledgerErr) {
                        console.error('[Ledger] autofix toggle failed:', ledgerErr.message);
                    }
                    return event.reply('autofix-result', { success: true, message: `"${targetMod}" was disabled successfully.` });
                }
            }
            return event.reply('autofix-result', { success: false, message: `Target mod (${autoFix.target}) was not found in the mods folder.` });
        }

        if (autoFix.type === 'increase_ram') {
            configStore.set('maxRam', autoFix.target || '6G');
            return event.reply('autofix-result', { success: true, message: `Max RAM was set to ${autoFix.target}.` });
        }

        if (autoFix.type === 'open_mods_folder') {
            if (!fs.existsSync(modsDir)) fs.mkdirSync(modsDir, { recursive: true });
            await shell.openPath(modsDir);
            return event.reply('autofix-result', { success: true, message: 'Mods folder opened.' });
        }

        if (autoFix.type === 'inspect_logs') {
            const logsDir = path.join(instanceDir, 'logs');
            if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
            await shell.openPath(logsDir);
            return event.reply('autofix-result', { success: true, message: 'Logs folder opened - check the crash report.' });
        }

        if (autoFix.type === 'open_settings') {
            return event.reply('autofix-result', { success: true, message: 'You can update the Java version from Settings.', openSettings: true });
        }

        if (autoFix.type === 'install_mod' && autoFix.target) {
            // Modrinth fallback install for a known missing dependency.
            try {
                const inst = instanceManager.getInstance(safeInstanceId) || {};
                const gameVersion = String(inst.version || '1.21.1').split('-')[0];
                const loader = inst.loaderType === 'fabric' ? 'fabric' : (inst.loaderType === 'quilt' ? 'quilt' : 'vanilla');
                if (loader === 'vanilla') {
                    return event.reply('autofix-result', { success: false, message: 'Missing-dependency installs need a Fabric or Quilt instance.' });
                }
                event.reply('autofix-result', { success: true, message: `Downloading "${autoFix.target}" from Modrinth...`, pending: true });
                const dest = await new ModrinthService().downloadModVersion(autoFix.target, gameVersion, modsDir);
                try { ledger.recordInstall(safeInstanceId, instanceDir, modsDir, path.basename(dest), { note: 'crash autofix install' }); } catch (_) {}
                return event.reply('autofix-result', { success: true, message: `Installed ${path.basename(dest)} - relaunch the game to verify the fix.` });
            } catch (installErr) {
                return event.reply('autofix-result', { success: false, message: `Modrinth install failed: ${installErr.message}` });
            }
        }

        if (autoFix.type === 'search_modrinth') {
            const query = (autoFix.target || searchTerm || '').trim() || 'fabric mods';
            const url = `https://modrinth.com/mods?q=${encodeURIComponent(query)}`;
            await shell.openExternal(url);
            return event.reply('autofix-result', { success: true, message: `Opened Modrinth search for "${query}".` });
        }

        event.reply('autofix-result', { success: false, message: 'No automatic repair is defined for this rule.' });
    } catch (err) {
        event.reply('autofix-result', { success: false, message: err.message });
    }
});

// Export Instance Zip IPC
ipcMain.on('export-instance-zip', async (event, instanceId) => {
    try {
        const safeInstanceId = sanitizeInstanceId(instanceId);
        const instanceDir = instanceManager.getInstanceGameDir(safeInstanceId);
        const saveRes = await dialog.showSaveDialog(mainWindow, {
            title: 'Export Instance (.zip)',
            defaultPath: path.join(app.getPath('downloads'), `${safeInstanceId}.zip`),
            filters: [{ name: 'Zip Archive', extensions: ['zip'] }]
        });

        if (!saveRes.canceled && saveRes.filePath) {
            ModpackService.exportInstanceToZip(instanceDir, saveRes.filePath);
            event.reply('export-instance-success', saveRes.filePath);
        }
    } catch (err) {
        event.reply('export-instance-failed', err.message);
    }
});

// 1-Click Performance Modpack Auto-Setup IPC
ipcMain.on('install-performance-pack', async (event, { instanceId, version }) => {
    try {
        const safeInstanceId = sanitizeInstanceId(instanceId);
        const instanceDir = instanceManager.getInstanceGameDir(safeInstanceId);
        const parsed = parseVersionConfig(version || '1.21.1');
        const installedMods = await ModpackService.installPerformancePack(instanceDir, parsed.number, 'fabric');
        recordInstalledJars(safeInstanceId, instanceDir, (installedMods || []).map(m => typeof m === 'string' ? m : m.filename || m.name), `perfpack-${Date.now().toString(36)}`, 'performance pack');
        event.reply('performance-pack-installed', installedMods);
    } catch (err) {
        event.reply('performance-pack-failed', err.message);
    }
});

// Fetch Version Lists (Vanilla, Fabric, Forge, Quilt, NeoForge)
ipcMain.on('get-versions', (event) => {
    const mojangUrl = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
    const fabricUrl = 'https://meta.fabricmc.net/v2/versions/loader';
    const quiltUrl = 'https://meta.quiltmc.org/v3/versions/loader';
    const forgePromosUrl = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';

    https.get(mojangUrl, (res) => {
        let mojangData = '';
        res.on('data', (chunk) => { mojangData += chunk; });
        res.on('end', () => {
            try {
                const manifest = JSON.parse(mojangData);
                const vanillaReleases = manifest.versions
                    .filter(v => v.type === 'release')
                    .map(v => v.id);

                https.get(fabricUrl, (fabRes) => {
                    let fabricData = '';
                    fabRes.on('data', (chunk) => { fabricData += chunk; });
                    fabRes.on('end', () => {
                        let stableFabricLoader = '0.19.5';
                        try {
                            const fabricManifest = JSON.parse(fabricData);
                            stableFabricLoader = fabricManifest.find(l => l.stable === true)?.version || '0.19.5';
                        } catch (e) {}

                        https.get(quiltUrl, (quiltRes) => {
                            let quiltData = '';
                            quiltRes.on('data', (chunk) => { quiltData += chunk; });
                            quiltRes.on('end', () => {
                                let stableQuiltLoader = '0.26.0';
                                try {
                                    const quiltManifest = JSON.parse(quiltData);
                                    stableQuiltLoader = quiltManifest[0]?.version || '0.26.0';
                                } catch (e) {}

                                https.get(forgePromosUrl, (forgeRes) => {
                                    let forgeData = '';
                                    forgeRes.on('data', (chunk) => { forgeData += chunk; });
                                    forgeRes.on('end', () => {
                                        let promos = {};
                                        try {
                                            const forgeJson = JSON.parse(forgeData);
                                            promos = forgeJson.promos || {};
                                        } catch (e) {}

                                        event.reply('versions-list', {
                                            vanilla: vanillaReleases,
                                            fabricLoader: stableFabricLoader,
                                            quiltLoader: stableQuiltLoader,
                                            forgePromos: promos
                                        });
                                    }).on('error', () => {
                                        event.reply('versions-list', { vanilla: vanillaReleases, fabricLoader: stableFabricLoader, quiltLoader: stableQuiltLoader, forgePromos: {} });
                                    });
                                }).on('error', () => {
                                    event.reply('versions-list', { vanilla: vanillaReleases, fabricLoader: stableFabricLoader, quiltLoader: stableQuiltLoader, forgePromos: {} });
                                });
                            }).on('error', () => {
                                event.reply('versions-list', { vanilla: vanillaReleases, fabricLoader: stableFabricLoader, quiltLoader: '0.26.0', forgePromos: {} });
                            });
                        }).on('error', () => {
                            event.reply('versions-list', { vanilla: vanillaReleases, fabricLoader: stableFabricLoader, quiltLoader: '0.26.0', forgePromos: {} });
                        });
                    });
                }).on('error', () => {
                    event.reply('versions-list', { vanilla: vanillaReleases, fabricLoader: '0.19.5', quiltLoader: '0.26.0', forgePromos: {} });
                });

            } catch (err) {
                console.error("Failed to fetch versions:", err);
                event.reply('versions-list', { vanilla: ['1.21.4', '1.21.1', '1.20.1', '1.19.2', '1.18.2', '1.16.5', '1.12.2'], fabricLoader: '0.19.5', quiltLoader: '0.26.0', forgePromos: {} });
            }
        });
    }).on('error', () => {
        event.reply('versions-list', { vanilla: ['1.21.4', '1.21.1', '1.20.1', '1.19.2', '1.18.2', '1.16.5', '1.12.2'], fabricLoader: '0.19.5', quiltLoader: '0.26.0', forgePromos: {} });
    });
});

// Check if version is downloaded
ipcMain.on('check-version-status', (event, versionString) => {
    const isDownloaded = checkVersionIsDownloaded(versionString);
    event.reply('version-status-response', { version: versionString, isDownloaded });
});

// Instance Management IPC
ipcMain.on('list-instances', (event) => {
    event.reply('instances-list', instancesForUi());
});

ipcMain.on('create-instance', (event, instanceData) => {
    try {
        const created = instanceManager.createInstance({
            name: instanceData.name,
            mcVersion: instanceData.version,
            loaderType: instanceData.loaderType,
            loaderVersion: instanceData.loaderVersion
        });
        console.log(`[InstanceManager] created "${created.id}" from "${instanceData.name || ''}"`);
        event.reply('instance-created-success', created);
        event.reply('instances-list', instancesForUi());
        try {
            const selected = configStore.get('selectedInstanceId');
            if (!selected || !instanceManager.exists(selected)) {
                configStore.set('selectedInstanceId', created.id);
            }
        } catch (_) {}
    } catch (err) {
        event.reply('instance-operation-failed', err.message);
    }
});

ipcMain.on('delete-instance', (event, instanceId) => {
    try {
        instanceManager.deleteInstance(instanceId);
        event.reply('instance-deleted-success', instanceId);
        event.reply('instances-list', instancesForUi());
    } catch (err) {
        event.reply('instance-operation-failed', err.message);
    }
});

// Microsoft Auth
ipcMain.on('login-microsoft', async (event) => {
    try {
        const authManager = new Auth("select_account");
        const xboxManager = await authManager.launch("electron");
        const token = await xboxManager.getMinecraft();
        const authData = token.mclc();

        // Save into the multi-account hub and make it active
        if (accountService) {
            const rawSave = (typeof token.save === 'function') ? token.save() : null;
            const id = accountService.addMicrosoft(authData, rawSave);
            accountService.setActive(id);
        }

        // Legacy single-account field kept in sync for older code paths
        configStore.update({
            accountType: 'microsoft',
            microsoftAuthData: authData,
            username: authData.name
        });

        event.reply('microsoft-login-success', authData);
    } catch (error) {
        console.error("Microsoft auth failed:", error);
        event.reply('microsoft-login-failed', error.message || error);
    }
});

// ── Account hub IPC ─────────────────────────────────────────────────────────
ipcMain.handle('accounts-list', () => (accountService ? accountService.list() : []));

ipcMain.handle('account-add-offline', (event, username) => {
    try {
        if (!accountService) throw new Error('Services not ready yet');
        const id = accountService.addOffline(username);
        accountService.setActive(id);
        return { success: true, id };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('account-set-active', (event, id) => {
    try {
        if (!accountService) throw new Error('Services not ready yet');
        const active = accountService.setActive(id);
        return { success: !!active, id: active };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('account-remove', (event, id) => {
    try {
        if (!accountService) throw new Error('Services not ready yet');
        accountService.remove(id);
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('account-refresh', async (event, id) => {
    try {
        if (!accountService) throw new Error('Services not ready yet');
        const auth = await accountService.refreshMicrosoft(Auth, id);
        if (auth) {
            // Keep legacy field fresh for old code paths
            configStore.set('microsoftAuthData', auth);
            return { success: true, username: auth.name };
        }
        return { success: false, error: 'Could not refresh the Microsoft session — sign in again.' };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

// ── Skin / profile IPC ───────────────────────────────────────────────────────
ipcMain.handle('get-profile-skin', async (event) => {
    try {
        if (!accountService || !skinService) throw new Error('Services not ready yet');
        const account = accountService.getActive();
        if (!account || account.type !== 'microsoft') {
            return { ok: false, error: 'Only Microsoft accounts have server-synced skins. Offline players use the skin of their chosen username or a custom .png below.' };
        }
        const auth = accountService.resolveForLaunch(null);
        if (!auth || !auth.access_token || auth.access_token === '0') {
            return { ok: false, error: 'Microsoft session token unavailable — sign in again.' };
        }
        return await skinService.getProfile(auth.access_token);
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('choose-skin-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Select Minecraft Skin (.png)',
        filters: [{ name: 'PNG Images', extensions: ['png'] }],
        properties: ['openFile']
    });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true };
    return { canceled: false, path: result.filePaths[0] };
});

ipcMain.handle('upload-skin', async (event, { filePath, variant }) => {
    try {
        if (!accountService || !skinService) throw new Error('Services not ready yet');
        const account = accountService.getActive();
        if (!account || account.type !== 'microsoft') {
            return { ok: false, error: 'Skin upload requires a signed-in Microsoft account. Offline players set this file as their launcher skin instead.' };
        }
        const auth = accountService.resolveForLaunch(null);
        if (!auth || !auth.access_token || auth.access_token === '0') {
            return { ok: false, error: 'Microsoft session token unavailable — sign in again.' };
        }
        const res = await skinService.uploadSkin(auth.access_token, filePath, variant);
        return res;
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

// Skin Upload IPC
ipcMain.on('select-skin-file', async (event) => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Select Minecraft Skin (.png)',
        filters: [{ name: 'PNG Images', extensions: ['png'] }],
        properties: ['openFile']
    });

    if (!result.canceled && result.filePaths.length > 0) {
        const skinPath = result.filePaths[0];
        configStore.set('customSkinPath', skinPath);
        event.reply('skin-file-selected', skinPath);
    }
});

// Modrinth API IPC (Mods / Resourcepacks / Shaders)
ipcMain.on('search-modrinth-mods', async (event, { query, version, loader, projectType }) => {
    try {
        const parsed = parseVersionConfig(version);
        const gameVersion = parsed.number;

        const facets = [];
        if (gameVersion) facets.push([`versions:${gameVersion}`]);
        if (loader && projectType === 'mod') facets.push([`categories:${loader}`]);
        facets.push([`project_type:${projectType || 'mod'}`]);

        const facetsParam = encodeURIComponent(JSON.stringify(facets));
        const queryParam = encodeURIComponent(query || '');
        const url = `https://api.modrinth.com/v2/search?query=${queryParam}&facets=${facetsParam}&limit=20`;

        const response = await fetch(url, {
            headers: { 'User-Agent': `devLauncher/${APP_VERSION}` }
        });

        if (!response.ok) {
            throw new Error(`Modrinth API status ${response.status}`);
        }

        const data = await response.json();
        event.reply('modrinth-search-results', data.hits);
    } catch (error) {
        console.error("Modrinth search failed:", error);
        event.reply('modrinth-search-failed', error.message);
    }
});

ipcMain.on('download-modrinth-mod', async (event, { projectId, version, loader, instanceId }) => {
    try {
        const parsed = parseVersionConfig(version);
        const gameVersion = parsed.number;

        const versionsUrl = `https://api.modrinth.com/v2/project/${projectId}/version`;
        const response = await fetch(versionsUrl, {
            headers: { 'User-Agent': `devLauncher/${APP_VERSION}` }
        });

        if (!response.ok) {
            throw new Error(`Modrinth API status ${response.status}`);
        }

        const versions = await response.json();
        const matchingVersion = versions.find(v => {
            const matchesGame = !gameVersion || v.game_versions.includes(gameVersion);
            const matchesLoader = !loader || v.loaders.includes(loader);
            return matchesGame && matchesLoader;
        }) || versions[0];

        if (!matchingVersion || !matchingVersion.files || matchingVersion.files.length === 0) {
            throw new Error('No compatible mod file found');
        }

        const fileToDownload = matchingVersion.files.find(f => f.primary) || matchingVersion.files[0];
        const safeFilename = sanitizeModFilename(fileToDownload.filename);
        if (!safeFilename) {
            throw new Error(`Unsafe mod filename received from Modrinth: ${fileToDownload.filename}`);
        }
        const safeInstanceId = sanitizeInstanceId(instanceId);
        const instanceDir = instanceManager.getInstanceGameDir(safeInstanceId);
        const modsDir = path.join(instanceDir, 'mods');

        if (!fs.existsSync(modsDir)) {
            fs.mkdirSync(modsDir, { recursive: true });
        }

        const filePath = resolveSafePath(modsDir, safeFilename);
        const fileResponse = await fetch(fileToDownload.url);
        const arrayBuffer = await fileResponse.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        // Integrity: verify against Modrinth's published sha1 when present
        const publishedSha1 = fileToDownload.hashes && fileToDownload.hashes.sha1;
        if (publishedSha1) {
            const actualSha1 = crypto.createHash('sha1').update(buffer).digest('hex');
            if (actualSha1 !== String(publishedSha1).toLowerCase()) {
                throw new Error(`Download integrity check failed for ${safeFilename} (sha1 mismatch)`);
            }
        }

        // Time Machine: stash current content before an overwrite, then record
        const wasUpdate = fs.existsSync(filePath);
        const prevSha1 = wasUpdate ? ledger.stashBeforeUpdate(safeInstanceId, modsDir, safeFilename) : null;
        fs.writeFileSync(filePath, buffer);
        try {
            if (wasUpdate) {
                ledger.recordUpdate(safeInstanceId, instanceDir, modsDir, safeFilename, { prevSha1 });
            } else {
                ledger.recordInstall(safeInstanceId, instanceDir, modsDir, safeFilename);
            }
        } catch (ledgerErr) {
            console.error('[Ledger] record failed:', ledgerErr.message);
        }

        event.reply('modrinth-download-success', { projectId, filename: fileToDownload.filename, path: filePath });
    } catch (error) {
        console.error("Modrinth download failed:", error);
        event.reply('modrinth-download-failed', { projectId, error: error.message });
    }
});

// P2P Multiplayer Sharing IPC Handlers
ipcMain.on('p2p-host-world', async (event, { port, roomName }) => {
    try {
        const roomInfo = await p2pService.hostWorld(port, roomName);
        event.reply('p2p-host-success', roomInfo);
    } catch (err) {
        console.error('[P2P IPC] Host failed:', err);
        event.reply('p2p-host-failed', err.message || 'Failed to start P2P tunnel');
    }
});

ipcMain.on('p2p-stop-host', async (event) => {
    await p2pService.stopHost();
    event.reply('p2p-stop-success');
});

ipcMain.on('p2p-get-status', (event) => {
    event.reply('p2p-status-update', p2pService.getActiveRoom());
});

// Launch Game IPC with Linux GPU Acceleration & GC Mode Selector (G1GC vs ZGC)
ipcMain.on('launch-game', async (event, config) => {
    try {

    const activeInstanceId = sanitizeInstanceId(config.instanceId);
    const instanceGameDir = instanceManager.getInstanceGameDir(activeInstanceId);
    restoreModsAfterSafeMode(activeInstanceId); // a previous Safe Mode run parks mods; normal launch always restores first

    // Benchmark: anchor the TTFP wall clock at the very start of the launch IPC
    benchmark.start({
        instanceId: activeInstanceId,
        version: config.version,
        loaderType: (instanceManager.getInstance(activeInstanceId) || {}).loaderType,
        prefetchDone: !prefetch.summary().running
    });
    benchmark.clickNow();
    const launchStartTimestamp = Date.now();

    configStore.update({
        username: config.username,
        selectedVersion: config.version,
        selectedInstanceId: activeInstanceId,
        minRam: config.minRam,
        maxRam: config.maxRam,
        javaPath: config.javaPath
    });

    const rootMinecraftDir = path.join(app.getPath('home'), '.devlauncher');

    const parsed = parseVersionConfig(config.version);
    // Validate loader compatibility between selected version and instance's configured loader
    const instanceConfig = instanceManager.getInstance(activeInstanceId);
    if (instanceConfig) {
        const instanceLoader = instanceConfig.loaderType || 'vanilla';
        const selectedLoader = parsed.loader;
        if (selectedLoader !== instanceLoader) {
            const errMsg = `Version/loader mismatch: this instance is configured for ${instanceLoader}, but the selected version is for ${selectedLoader}. Select a ${instanceLoader} version for this instance or create a matching instance.`;
            console.error(errMsg);
            event.reply('game-launch-failed', errMsg);
            return;
        }
    }
    const gameVersion = parsed.number;

    // Resolve loader assets before launching
    let launcherForgePath = null;
    let versionCustom = parsed.custom;
    if (parsed.loader === 'forge') {
        launcherForgePath = await ensureForgeInstaller(parsed);
        versionCustom = null; // MCLC + ForgeWrapper generate the profile themselves
    } else if (parsed.loader === 'neoforge') {
        const neo = await ensureNeoForgeProfile(parsed);
        versionCustom = neo.profileId;
    } else if (parsed.loader === 'optifine' || parsed.loader === 'optifine-forge') {
        ensureOptiFineProfileAvailable(parsed);
    } else if (parsed.loader === 'fabric' || parsed.loader === 'quilt') {
        await ensureLoaderProfileJson(parsed, rootMinecraftDir);
    }

    let authObj;
    const accountAuth = accountService ? accountService.resolveForLaunch(instanceConfig) : null;
    if (accountAuth) {
        authObj = accountAuth;
    } else if (configStore.get('accountType') === 'microsoft' && configStore.get('microsoftAuthData')) {
        authObj = configStore.get('microsoftAuthData');
    } else {
        const username = config.username || 'Player';
        authObj = {
            name: username,
            uuid: '00000000-0000-0000-0000-000000000000',
            access_token: 'offline_token',
            meta: { type: 'mojang' }
        };
    }

    // ── Detect Java major version ─────────────────────────────────────────
    const javaExe = process.env.DEVLAUNCHER_JAVA_PATH || config.javaPath || 'java';
    const installedJavaMajor = detectJavaMajor(javaExe);
    console.log(`[devLauncher] Java ${installedJavaMajor} @ ${javaExe}`);

    // ── GC Flags ─────────────────────────────────────────────────────────
    const selectedGcMode2 = configStore.get('gcMode') || 'g1gc';

    const zgcFlags = [
        '-XX:+UnlockExperimentalVMOptions',
        '-XX:+UseZGC',
        // -XX:+ZGenerational only exists on JDK 21-22; default (generational) on 23+, absent on <21
        ...((installedJavaMajor >= 21 && installedJavaMajor < 23) ? ['-XX:+ZGenerational'] : []),
        '-XX:+AlwaysPreTouch',
        '-XX:+DisableExplicitGC',
        '-XX:+PerfDisableSharedMem'
    ];

    const aikarG1Flags = [
        '-XX:+UnlockExperimentalVMOptions',
        '-XX:+UseG1GC',
        '-XX:+ParallelRefProcEnabled',
        '-XX:MaxGCPauseMillis=200',
        '-XX:+DisableExplicitGC',
        '-XX:+AlwaysPreTouch',
        '-XX:G1NewSizePercent=30',
        '-XX:G1MaxNewSizePercent=40',
        '-XX:G1HeapRegionSize=8M',
        '-XX:G1ReservePercent=20',
        '-XX:G1HeapWastePercent=5',
        '-XX:G1MixedGCCountTarget=4',
        '-XX:InitiatingHeapOccupancyPercent=15',
        '-XX:G1MixedGCLiveThresholdPercent=90',
        '-XX:SurvivorRatio=32',
        '-XX:+PerfDisableSharedMem',
        '-XX:MaxTenuringThreshold=1'
    ];

    const chosenGcFlags = selectedGcMode2 === 'zgc' ? zgcFlags : aikarG1Flags;
    const userCustomArgs2 = configStore.get('customJvmArgs');
    let customJvmArgs = [
        ...chosenGcFlags,
        ...(userCustomArgs2 ? userCustomArgs2.split(' ').filter(Boolean) : [])
    ];

    // Filter Java 25+ flags if on older Java
    if (installedJavaMajor < 25) {
        const java25OnlyPrefixes = ['--sun-misc-unsafe-memory-access', '--enable-native-access'];
        customJvmArgs = customJvmArgs.filter(arg => !java25OnlyPrefixes.some(p => arg.startsWith(p)));
    }

    if (process.platform === 'linux') {
        process.env.MESA_GL_THREAD = '1';
        process.env.__GL_THREADED_OPTIMIZATIONS = '1';
    }

    const launcherOptions = {
        authorization: authObj,
        root: rootMinecraftDir,
        gameDirectory: instanceGameDir,
        overrides: {
            gameDirectory: instanceGameDir,
            cwd: instanceGameDir,
            directory: path.join(rootMinecraftDir, 'versions', gameVersion)
        },
        version: {
            number: gameVersion,
            type: "release",
            ...(versionCustom ? { custom: versionCustom } : {})
        },
        ...(launcherForgePath ? { forge: launcherForgePath } : {}),
        memory: {
            max: `${parseInt(config.maxRam) ? parseInt(config.maxRam) * (String(config.maxRam).toUpperCase().includes('G') ? 1024 : 1) : 4096}M`,
            min: `${parseInt(config.minRam) ? parseInt(config.minRam) * (String(config.minRam).toUpperCase().includes('G') ? 1024 : 1) : 2048}M`
        },
        javaPath: javaExe,
        customArgs: customJvmArgs
    };

    discordRpc.updateActivity(`Playing Minecraft ${gameVersion}`, `Instance: ${activeInstanceId}`);
    console.log(`[devLauncher] Launching via MCLC (Java ${installedJavaMajor}, GC: ${selectedGcMode2}, version: ${gameVersion})`);

    const launcher = new Client();
    let gameLogBuffer = '';

    launcher.on('progress', (e) => {
        event.reply('download-progress', e);
        benchmark.onLauncherProgress(e);
    });

    launcher.on('data', (e) => {
        const text = String(e);
        console.log(`[GAME LOG]: ${text}`);
        gameLogBuffer += text + '\n';
        if (gameLogBuffer.length > 50000) {
            gameLogBuffer = gameLogBuffer.slice(-30000);
        }
        benchmark.markGameLogLine(text);
    });

    launcher.on('close', (e) => {
        console.log(`[devLauncher] Game exited with code ${e}`);
        const benchRec = benchmark.closed(e);
        if (benchRec) {
            console.log(`[Benchmark] TTFP ${benchRec.ttfpSeconds ?? 'n/a'}s (${benchRec.failed ? 'no playable marker' : benchRec.marker}), ${benchRec.assetDone}/${benchRec.assetTasks} assets, prefetchDone=${benchRec.prefetchDone}`);
        }
        discordRpc.updateActivity('devLauncher', 'In Menu');
        recordPlaytime(activeInstanceId, launchStartTimestamp);
        event.reply('game-closed', e);

        // If non-zero exit code, automatically check for crash analysis
        if (e !== 0) {
            const diagnosis = crashAnalyzer.analyze(gameLogBuffer) || 
                crashAnalyzer.analyze(CrashAnalyzer.getLatestCrashReport(instanceGameDir) || '');
            if (diagnosis) {
                event.reply('crash-detected', { diagnosis, exitCode: e });
            }
        }
    });

    launcher.on('error', (err) => {
        console.error('[GAME ERR]:', err);
        const diagnosis = crashAnalyzer.analyze(String(err) + '\n' + gameLogBuffer);
        if (diagnosis) {
            event.reply('crash-detected', { diagnosis, error: err?.message || String(err) });
        }
        event.reply('game-closed');
    });

    try {
        await launcher.launch(launcherOptions);
        event.reply('game-launched');
    } catch (launchErr) {
        console.error('MCLC Launch Failed:', launchErr);
        event.reply('game-launch-failed', launchErr?.message || 'Launch failed');
        event.reply('game-closed');
    }
    } catch (preflightErr) {
        console.error('Launch preflight failed:', preflightErr);
        event.reply('game-launch-failed', preflightErr?.message || 'Launch failed');
        event.reply('game-closed');
    }
});
