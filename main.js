const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { Client, Authenticator } = require('minecraft-launcher-core');
const { Auth } = require('msmc');

const ConfigStore = require('./src/services/configStore');
const InstanceManager = require('./src/services/instanceManager');
const ThemeStore = require('./src/services/themeStore');
const ScreenshotManager = require('./src/services/screenshotManager');
const ModpackService = require('./src/services/modpackService');
const discordRpc = require('./src/services/discordRpc');
const { getInstalledJavaRuntimes } = require('./src/utils/javaDetector');

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
const launcher = new Client();
let mainWindow;

discordRpc.init();

function parseVersionConfig(versionString) {
    if (!versionString) return { number: '1.21.1', custom: null, loaderVersion: null };

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
            loaderVersion: loaderVersion
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

        const customProfile = `1.${mcVersion}-forge-${forgeVersion}`;
        return {
            number: mcVersion,
            custom: customProfile,
            loaderVersion: forgeVersion,
            isForge: true
        };
    }

    return {
        number: versionString,
        custom: null,
        loaderVersion: null
    };
}

function checkVersionIsDownloaded(versionString) {
    if (!versionString) return false;
    const minecraftDir = process.platform === 'win32'
        ? path.join(process.env.APPDATA, '.minecraft')
        : path.join(app.getPath('home'), '.minecraft');

    const parsed = parseVersionConfig(versionString);
    const gameVersion = parsed.number;

    const vanillaJson = path.join(minecraftDir, 'versions', gameVersion, `${gameVersion}.json`);
    const vanillaJar = path.join(minecraftDir, 'versions', gameVersion, `${gameVersion}.jar`);

    const vanillaDownloaded = fs.existsSync(vanillaJson) && fs.existsSync(vanillaJar);

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

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// Settings & Config IPC
ipcMain.on('get-config', (event) => {
    event.reply('config-data', configStore.getAll());
});

ipcMain.on('save-config', (event, data) => {
    configStore.update(data);
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
ipcMain.on('get-themes', (event) => {
    event.reply('themes-list', {
        themes: ThemeStore.getAllThemes(),
        currentTheme: configStore.get('theme') || 'dark'
    });
});

ipcMain.on('set-theme', (event, themeKey) => {
    configStore.set('theme', themeKey);
    event.reply('theme-changed', {
        themeKey,
        themeData: ThemeStore.getTheme(themeKey)
    });
});

// Java Runtimes (Linux OpenJDK / System Java)
ipcMain.on('detect-java-runtimes', (event) => {
    const runtimes = getInstalledJavaRuntimes();
    event.reply('java-runtimes-detected', runtimes);
});

// Open Instance folder
ipcMain.on('open-mods-folder', (event, instanceId) => {
    const instanceDir = instanceManager.getInstanceGameDir(instanceId);
    const modsDir = path.join(instanceDir, 'mods');

    if (!fs.existsSync(modsDir)) {
        fs.mkdirSync(modsDir, { recursive: true });
    }
    shell.openPath(modsDir);
});

// Screenshots IPC
ipcMain.on('get-screenshots', (event, instanceId) => {
    const instanceDir = instanceManager.getInstanceGameDir(instanceId || 'default');
    const screenshots = ScreenshotManager.getScreenshots(instanceDir);
    event.reply('screenshots-list', screenshots);
});

ipcMain.on('export-screenshots-zip', async (event, instanceId) => {
    try {
        const instanceDir = instanceManager.getInstanceGameDir(instanceId || 'default');
        const saveRes = await dialog.showSaveDialog(mainWindow, {
            title: 'Export Screenshots (.zip)',
            defaultPath: path.join(app.getPath('downloads'), `${instanceId || 'minecraft'}-screenshots.zip`),
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

// Export Instance Zip IPC
ipcMain.on('export-instance-zip', async (event, instanceId) => {
    try {
        const instanceDir = instanceManager.getInstanceGameDir(instanceId || 'default');
        const saveRes = await dialog.showSaveDialog(mainWindow, {
            title: 'Export Instance (.zip)',
            defaultPath: path.join(app.getPath('downloads'), `${instanceId || 'instance'}.zip`),
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
        const instanceDir = instanceManager.getInstanceGameDir(instanceId || 'default');
        const parsed = parseVersionConfig(version || '1.21.1');
        const installedMods = await ModpackService.installPerformancePack(instanceDir, parsed.number, 'fabric');
        event.reply('performance-pack-installed', installedMods);
    } catch (err) {
        event.reply('performance-pack-failed', err.message);
    }
});

// Fetch Version Lists (Vanilla, Fabric, Forge)
ipcMain.on('get-versions', (event) => {
    const mojangUrl = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
    const fabricUrl = 'https://meta.fabricmc.net/v2/versions/loader';
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
                        try {
                            const fabricManifest = JSON.parse(fabricData);
                            const stableLoader = fabricManifest.find(l => l.stable === true)?.version || '0.19.5';

                            https.get(forgePromosUrl, (forgeRes) => {
                                let forgeData = '';
                                forgeRes.on('data', (chunk) => { forgeData += chunk; });
                                forgeRes.on('end', () => {
                                    try {
                                        const forgeJson = JSON.parse(forgeData);
                                        const promos = forgeJson.promos || {};
                                        event.reply('versions-list', {
                                            vanilla: vanillaReleases,
                                            fabricLoader: stableLoader,
                                            forgePromos: promos
                                        });
                                    } catch (e) {
                                        event.reply('versions-list', { vanilla: vanillaReleases, fabricLoader: stableLoader, forgePromos: {} });
                                    }
                                }).on('error', () => {
                                    event.reply('versions-list', { vanilla: vanillaReleases, fabricLoader: stableLoader, forgePromos: {} });
                                });
                            }).on('error', () => {
                                event.reply('versions-list', { vanilla: vanillaReleases, fabricLoader: stableLoader, forgePromos: {} });
                            });

                        } catch (e) {
                            event.reply('versions-list', { vanilla: vanillaReleases, fabricLoader: '0.19.5', forgePromos: {} });
                        }
                    });
                }).on('error', () => {
                    event.reply('versions-list', { vanilla: vanillaReleases, fabricLoader: '0.19.5', forgePromos: {} });
                });

            } catch (err) {
                console.error("Failed to fetch versions:", err);
                event.reply('versions-list', { vanilla: ['1.21.4', '1.21.1', '1.20.1', '1.19.2', '1.18.2', '1.16.5', '1.12.2'], fabricLoader: '0.19.5', forgePromos: {} });
            }
        });
    });
});

// Check if version is downloaded
ipcMain.on('check-version-status', (event, versionString) => {
    const isDownloaded = checkVersionIsDownloaded(versionString);
    event.reply('version-status-response', { version: versionString, isDownloaded });
});

// Instance Management IPC
ipcMain.on('list-instances', (event) => {
    event.reply('instances-list', instanceManager.listInstances());
});

ipcMain.on('create-instance', (event, instanceData) => {
    try {
        const created = instanceManager.createInstance(
            instanceData.id,
            instanceData.name,
            instanceData.version,
            instanceData.loaderType,
            instanceData.loaderVersion
        );
        event.reply('instance-created-success', created);
        event.reply('instances-list', instanceManager.listInstances());
    } catch (err) {
        event.reply('instance-operation-failed', err.message);
    }
});

ipcMain.on('delete-instance', (event, instanceId) => {
    try {
        instanceManager.deleteInstance(instanceId);
        event.reply('instance-deleted-success', instanceId);
        event.reply('instances-list', instanceManager.listInstances());
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
            headers: { 'User-Agent': 'devLauncher/1.0.0' }
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
            headers: { 'User-Agent': 'devLauncher/1.0.0' }
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
        const instanceDir = instanceManager.getInstanceGameDir(instanceId || 'default');
        const modsDir = path.join(instanceDir, 'mods');

        if (!fs.existsSync(modsDir)) {
            fs.mkdirSync(modsDir, { recursive: true });
        }

        const filePath = path.join(modsDir, fileToDownload.filename);
        const fileResponse = await fetch(fileToDownload.url);
        const arrayBuffer = await fileResponse.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        fs.writeFileSync(filePath, buffer);
        event.reply('modrinth-download-success', { projectId, filename: fileToDownload.filename, path: filePath });
    } catch (error) {
        console.error("Modrinth download failed:", error);
        event.reply('modrinth-download-failed', { projectId, error: error.message });
    }
});

// Launch Game IPC with Linux GPU Acceleration & GC Mode Selector (G1GC vs ZGC)
ipcMain.on('launch-game', async (event, config) => {
    const rootMinecraftDir = process.platform === 'win32'
        ? path.join(process.env.APPDATA, '.minecraft')
        : path.join(app.getPath('home'), '.minecraft');

    const activeInstanceId = config.instanceId || 'default';
    const instanceGameDir = instanceManager.getInstanceGameDir(activeInstanceId);

    configStore.update({
        username: config.username,
        selectedVersion: config.version,
        selectedInstanceId: activeInstanceId,
        minRam: config.minRam,
        maxRam: config.maxRam,
        javaPath: config.javaPath
    });

    const parsed = parseVersionConfig(config.version);
    const gameVersion = parsed.number;
    const customProfile = parsed.custom;

    if (customProfile && customProfile.startsWith('fabric')) {
        const profileDir = path.join(rootMinecraftDir, 'versions', customProfile);
        const profileJsonPath = path.join(profileDir, `${customProfile}.json`);

        if (!fs.existsSync(profileJsonPath)) {
            fs.mkdirSync(profileDir, { recursive: true });
            const fabricJsonUrl = `https://meta.fabricmc.net/v2/versions/loader/${gameVersion}/${parsed.loaderVersion}/profile/json`;

            try {
                const response = await fetch(fabricJsonUrl);
                if (response.ok) {
                    const jsonText = await response.text();
                    JSON.parse(jsonText);
                    fs.writeFileSync(profileJsonPath, jsonText);
                }
            } catch (err) {
                console.error("Failed to download Fabric profile JSON:", err);
            }
        }
    }

    let authObj;
    if (configStore.get('accountType') === 'microsoft' && configStore.get('microsoftAuthData')) {
        authObj = configStore.get('microsoftAuthData');
    } else {
        authObj = Authenticator.getAuth(config.username || 'Player');
    }

    // Garbage Collector Selection (Aikar G1GC vs Ultra Low-Latency ZGC)
    const selectedGcMode = configStore.get('gcMode') || 'g1gc';
    let gcFlags = [];

    if (selectedGcMode === 'zgc') {
        // Zero-Stutter Low-Latency ZGC Flags
        gcFlags = [
            '-XX:+UseZGC',
            '-XX:+ZGenerational',
            '-XX:+UnlockExperimentalVMOptions',
            '-XX:+AlwaysPreTouch',
            '-XX:+DisableExplicitGC',
            '-XX:+PerfDisableSharedMem'
        ];
    } else {
        // Aikar G1GC Tuning
        gcFlags = [
            '-XX:+UseG1GC',
            '-XX:+ParallelRefProcEnabled',
            '-XX:MaxGCPauseMillis=200',
            '-XX:+UnlockExperimentalVMOptions',
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
            '-XX:SurviorRatio=32',
            '-XX:+PerfDisableSharedMem',
            '-XX:MaxTenuringThreshold=1'
        ];
    }

    let customJvmArgs = [...gcFlags];
    const userCustomArgs = configStore.get('customJvmArgs');
    if (userCustomArgs) {
        customJvmArgs.push(...userCustomArgs.split(' ').filter(Boolean));
    }

    // Cross-Platform Linux OpenGL Multithreading GPU Environment Variables
    if (process.platform === 'linux') {
        process.env.MESA_GL_THREAD = '1';
        process.env.__GL_THREADED_OPTIMIZATIONS = '1';
    }

    let opts = {
        clientPackage: null,
        authorization: authObj,
        root: rootMinecraftDir,
        gameDirectory: instanceGameDir,
        version: {
            number: gameVersion,
            type: "release"
        },
        memory: {
            max: config.maxRam || '4G',
            min: config.minRam || '2G'
        },
        javaPath: config.javaPath || undefined,
        customArgs: customJvmArgs,
        overrides: {
            gameDirectory: instanceGameDir
        }
    };

    if (customProfile) {
        opts.version.custom = customProfile;
    }

    discordRpc.updateActivity(`Playing Minecraft ${gameVersion}`, `Instance: ${activeInstanceId}`);

    launcher.launch(opts);

    launcher.on('debug', (e) => console.log(`[DEBUG] ${e}`));
    launcher.on('data', (e) => console.log(`[DATA] ${e}`));

    launcher.on('progress', (e) => {
        event.reply('download-progress', { type: 'progress', current: e.task, total: e.total });
    });

    launcher.on('download-status', (e) => {
        if (e.type === 'extract') {
            event.reply('download-progress', { type: 'extract' });
        }
    });

    launcher.on('launch', () => {
        event.reply('game-launched');
    });

    launcher.on('close', () => {
        discordRpc.updateActivity('devLauncher', 'In Menu');
        event.reply('game-closed');
    });
});
