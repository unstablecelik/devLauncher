const { ipcRenderer, shell } = require('electron');

let currentConfig = {};
let isVersionDownloadedLocally = false;
let currentActiveInstanceId = 'default';
let activeModrinthCategory = 'mod';

document.addEventListener('DOMContentLoaded', () => {
    ipcRenderer.send('get-config');
    ipcRenderer.send('get-themes');
    ipcRenderer.send('get-versions');
    ipcRenderer.send('detect-java-runtimes');
    ipcRenderer.send('list-instances');

    initEventListeners();
});

function initEventListeners() {
    document.getElementById('play-btn').addEventListener('click', handleLaunch);
    document.getElementById('github-link').addEventListener('click', () => {
        shell.openExternal('https://github.com/fedevoral/devLauncher');
    });

    document.getElementById('refresh-btn').addEventListener('click', () => {
        ipcRenderer.send('get-versions');
    });

    document.getElementById('folder-btn').addEventListener('click', () => {
        ipcRenderer.send('open-mods-folder', currentActiveInstanceId);
    });

    document.getElementById('detect-java-btn').addEventListener('click', () => {
        ipcRenderer.send('detect-java-runtimes');
    });

    document.getElementById('version').addEventListener('change', (e) => {
        const selectedVer = e.target.value;
        ipcRenderer.send('save-config', { selectedVersion: selectedVer });
        ipcRenderer.send('check-version-status', selectedVer);
    });

    document.getElementById('offline-username-input').addEventListener('change', (e) => {
        const username = e.target.value.trim() || 'Player';
        ipcRenderer.send('save-config', { username, accountType: 'offline' });
        updateAccountButtonDisplay();
    });

    document.getElementById('ms-login-btn').addEventListener('click', () => {
        document.getElementById('ms-login-btn').innerText = "Logging in with Microsoft...";
        ipcRenderer.send('login-microsoft');
    });

    document.getElementById('select-skin-btn').addEventListener('click', () => {
        ipcRenderer.send('select-skin-file');
    });

    document.getElementById('mod-search-btn').addEventListener('click', () => {
        const query = document.getElementById('mod-search-input').value;
        const version = document.getElementById('version').value;
        ipcRenderer.send('search-modrinth-mods', { query, version, loader: 'fabric', projectType: activeModrinthCategory });
    });

    document.getElementById('submit-create-instance-btn').addEventListener('click', handleCreateInstance);

    document.getElementById('install-perf-pack-btn').addEventListener('click', () => {
        const version = document.getElementById('version').value;
        document.getElementById('install-perf-pack-btn').innerText = 'Installing Performance Pack...';
        ipcRenderer.send('install-performance-pack', { instanceId: currentActiveInstanceId, version });
    });

    document.getElementById('export-instance-zip-btn').addEventListener('click', () => {
        ipcRenderer.send('export-instance-zip', currentActiveInstanceId);
    });

    document.getElementById('export-screenshots-zip-btn').addEventListener('click', () => {
        ipcRenderer.send('export-screenshots-zip', currentActiveInstanceId);
    });

    document.getElementById('min-ram').addEventListener('change', saveSettingsForm);
    document.getElementById('max-ram').addEventListener('change', saveSettingsForm);
    document.getElementById('java-path').addEventListener('change', saveSettingsForm);
    document.getElementById('gc-mode-select').addEventListener('change', saveSettingsForm);
    document.getElementById('custom-jvm-args').addEventListener('change', saveSettingsForm);
    document.getElementById('discord-client-id').addEventListener('change', saveSettingsForm);

    document.getElementById('java-select').addEventListener('change', (e) => {
        if (e.target.value) {
            document.getElementById('java-path').value = e.target.value;
            saveSettingsForm();
        }
    });
}

function saveSettingsForm() {
    ipcRenderer.send('save-config', {
        minRam: document.getElementById('min-ram').value,
        maxRam: document.getElementById('max-ram').value,
        javaPath: document.getElementById('java-path').value,
        gcMode: document.getElementById('gc-mode-select').value,
        customJvmArgs: document.getElementById('custom-jvm-args').value,
        discordClientId: document.getElementById('discord-client-id').value
    });
}

function updateAccountButtonDisplay() {
    const accountBtn = document.getElementById('account-btn-trigger');
    if (currentConfig.accountType === 'microsoft' && currentConfig.microsoftAuthData) {
        accountBtn.innerText = `🟢 ${currentConfig.microsoftAuthData.name}`;
    } else {
        accountBtn.innerText = `👤 ${currentConfig.username || 'fedevoral'}`;
    }
}

function applyTheme(themeData) {
    if (!themeData) return;
    const root = document.documentElement;
    root.style.setProperty('--bg-main', themeData.bgMain);
    root.style.setProperty('--bg-dark', themeData.bgDark);
    root.style.setProperty('--bg-bar', themeData.bgBar);
    root.style.setProperty('--accent', themeData.accent);
    root.style.setProperty('--accent-hover', themeData.accentHover);
    root.style.setProperty('--text', themeData.text);
    root.style.setProperty('--text-muted', themeData.textMuted);
    root.style.setProperty('--border', themeData.border);
}

// Tab Switching & Dynamic Discord Presence Update
function switchTab(tabId, btnElement) {
    document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.nav-tab').forEach(btn => btn.classList.remove('active'));

    document.getElementById(tabId).classList.add('active');
    if (btnElement) btnElement.classList.add('active');

    let sectionName = 'Browsing Dashboard';
    if (tabId === 'modrinth-tab') sectionName = 'Browsing Mod Manager';
    if (tabId === 'instances-tab') sectionName = 'Managing Instances';
    if (tabId === 'screenshots-tab') {
        sectionName = 'Viewing Screenshots';
        ipcRenderer.send('get-screenshots', currentActiveInstanceId);
    }

    ipcRenderer.send('update-discord-presence', {
        details: 'devLauncher 2.0',
        state: sectionName
    });
}

function selectModrinthCategory(category, btnElement) {
    activeModrinthCategory = category;
    document.querySelectorAll('.sub-tab-btn').forEach(btn => btn.classList.remove('active'));
    if (btnElement) btnElement.classList.add('active');

    const query = document.getElementById('mod-search-input').value;
    const version = document.getElementById('version').value;
    ipcRenderer.send('search-modrinth-mods', { query, version, loader: 'fabric', projectType: activeModrinthCategory });
}

// Modal Control with Discord Presence Updates
function openAccountModal() {
    ipcRenderer.send('update-discord-presence', { details: 'devLauncher 2.0', state: 'Configuring Account' });
    document.getElementById('modal-overlay').style.display = 'block';
    document.getElementById('account-modal').style.display = 'block';
}

function openSettingsModal() {
    ipcRenderer.send('update-discord-presence', { details: 'devLauncher 2.0', state: 'Adjusting Settings' });
    document.getElementById('modal-overlay').style.display = 'block';
    document.getElementById('settings-modal').style.display = 'block';
}

function openCreateInstanceModal() {
    ipcRenderer.send('update-discord-presence', { details: 'devLauncher 2.0', state: 'Creating Instance' });
    document.getElementById('modal-overlay').style.display = 'block';
    document.getElementById('create-instance-modal').style.display = 'block';
}

function openThemeModal() {
    ipcRenderer.send('update-discord-presence', { details: 'devLauncher 2.0', state: 'Customizing Theme' });
    ipcRenderer.send('get-themes');
    document.getElementById('modal-overlay').style.display = 'block';
    document.getElementById('theme-modal').style.display = 'block';
}

function closeAllModals() {
    document.getElementById('modal-overlay').style.display = 'none';
    document.querySelectorAll('.modal').forEach(m => m.style.display = 'none');
    ipcRenderer.send('update-discord-presence', { details: 'devLauncher 2.0', state: 'In Launcher Menu' });
}

// IPC Receivers
ipcRenderer.on('config-data', (event, config) => {
    currentConfig = config;
    currentActiveInstanceId = config.selectedInstanceId || 'default';
    
    document.getElementById('offline-username-input').value = config.username || 'fedevoral';
    document.getElementById('min-ram').value = config.minRam || '2G';
    document.getElementById('max-ram').value = config.maxRam || '4G';
    document.getElementById('java-path').value = config.javaPath || '';
    document.getElementById('gc-mode-select').value = config.gcMode || 'g1gc';
    document.getElementById('custom-jvm-args').value = config.customJvmArgs || '';
    document.getElementById('discord-client-id').value = config.discordClientId || '';

    if (config.customSkinPath) {
        document.getElementById('skin-path-display').innerText = config.customSkinPath;
    }

    updateAccountButtonDisplay();
    document.getElementById('instance-path-text').innerText = currentActiveInstanceId;
});

ipcRenderer.on('config-saved', (event, config) => {
    currentConfig = config;
    updateAccountButtonDisplay();
});

// Theme IPC
ipcRenderer.on('themes-list', (event, { themes, currentTheme }) => {
    const container = document.getElementById('theme-grid-container');
    container.innerHTML = '';

    applyTheme(themes[currentTheme]);

    Object.keys(themes).forEach(key => {
        const theme = themes[key];
        const card = document.createElement('div');
        card.className = 'theme-card';
        if (key === currentTheme) {
            card.style.borderColor = 'var(--accent)';
        }

        card.innerHTML = `
            <span>${theme.name}</span>
            <div style="display: flex; gap: 4px;">
                <span style="width: 12px; height: 12px; border-radius: 50%; background: ${theme.bgDark}; display: inline-block;"></span>
                <span style="width: 12px; height: 12px; border-radius: 50%; background: ${theme.accent}; display: inline-block;"></span>
            </div>
        `;

        card.addEventListener('click', () => {
            ipcRenderer.send('set-theme', key);
        });

        container.appendChild(card);
    });
});

ipcRenderer.on('theme-changed', (event, { themeKey, themeData }) => {
    applyTheme(themeData);
    ipcRenderer.send('get-themes');
});

ipcRenderer.on('versions-list', (event, data) => {
    const versionSelect = document.getElementById('version');
    const newInstVersionSelect = document.getElementById('new-instance-version');

    versionSelect.innerHTML = '';
    newInstVersionSelect.innerHTML = '';

    // Special Performance Profile
    const fabricSpecial = document.createElement('option');
    fabricSpecial.value = `fabric-loader-${data.fabricLoader}-1.21.1`;
    fabricSpecial.innerText = 'Fabric 1.21.1 (Performance Profile)';
    versionSelect.appendChild(fabricSpecial);

    // Vanilla Releases
    const vanillaOptgroup = document.createElement('optgroup');
    vanillaOptgroup.label = "Vanilla Releases";
    data.vanilla.forEach(v => {
        const option = document.createElement('option');
        option.value = v;
        option.innerText = `Vanilla ${v}`;
        vanillaOptgroup.appendChild(option);

        const newOpt = document.createElement('option');
        newOpt.value = v;
        newOpt.innerText = v;
        newInstVersionSelect.appendChild(newOpt);
    });
    versionSelect.appendChild(vanillaOptgroup);

    // Fabric Loaders
    const fabricOptgroup = document.createElement('optgroup');
    fabricOptgroup.label = "Fabric Loaders";
    data.vanilla.forEach(v => {
        const majorVer = parseInt(v.split('.')[0], 10);
        const minorVer = parseInt(v.split('.')[1], 10);
        if (majorVer >= 26 || (majorVer === 1 && minorVer >= 14)) {
            const option = document.createElement('option');
            option.value = `fabric-loader-${data.fabricLoader}-${v}`;
            option.innerText = `Fabric ${v}`;
            fabricOptgroup.appendChild(option);
        }
    });
    versionSelect.appendChild(fabricOptgroup);

    // Dynamic Full Forge Loaders
    const forgeOptgroup = document.createElement('optgroup');
    forgeOptgroup.label = "Forge Loaders";

    const promos = data.forgePromos || {};
    data.vanilla.forEach(ver => {
        const promoVer = promos[`${ver}-recommended`] || promos[`${ver}-latest`];
        if (promoVer) {
            const option = document.createElement('option');
            option.value = `forge-${promoVer}-${ver}`;
            option.innerText = `Forge ${ver} (${promoVer})`;
            forgeOptgroup.appendChild(option);
        }
    });

    Object.keys(promos).forEach(key => {
        if (key.endsWith('-recommended')) {
            const ver = key.replace('-recommended', '');
            if (!data.vanilla.includes(ver)) {
                const promoVer = promos[key];
                const option = document.createElement('option');
                option.value = `forge-${promoVer}-${ver}`;
                option.innerText = `Forge ${ver} (${promoVer})`;
                forgeOptgroup.appendChild(option);
            }
        }
    });

    versionSelect.appendChild(forgeOptgroup);

    if (currentConfig.selectedVersion) {
        versionSelect.value = currentConfig.selectedVersion;
    }

    ipcRenderer.send('check-version-status', versionSelect.value);
});

ipcRenderer.on('version-status-response', (event, data) => {
    isVersionDownloadedLocally = data.isDownloaded;
    const playBtn = document.getElementById('play-btn');
    if (playBtn && !playBtn.disabled) {
        playBtn.innerText = isVersionDownloadedLocally ? "PLAY" : "DOWNLOAD & PLAY";
    }
});

ipcRenderer.on('java-runtimes-detected', (event, runtimes) => {
    const javaSelect = document.getElementById('java-select');
    javaSelect.innerHTML = '<option value="">System Default Java</option>';

    runtimes.forEach(runtime => {
        const option = document.createElement('option');
        option.value = runtime.path;
        option.innerText = `${runtime.name} (${runtime.path})`;
        javaSelect.appendChild(option);
    });

    if (currentConfig.javaPath) {
        javaSelect.value = currentConfig.javaPath;
    }
});

ipcRenderer.on('microsoft-login-success', (event, authData) => {
    const msBtn = document.getElementById('ms-login-btn');
    msBtn.innerText = `Logged in as ${authData.name}`;
    msBtn.style.backgroundColor = "#2ecc71";
    updateAccountButtonDisplay();
});

ipcRenderer.on('microsoft-login-failed', (event, error) => {
    const msBtn = document.getElementById('ms-login-btn');
    msBtn.innerText = "Login Failed - Try Again";
});

ipcRenderer.on('skin-file-selected', (event, skinPath) => {
    document.getElementById('skin-path-display').innerText = skinPath;
});

// Modrinth Search & Install
ipcRenderer.on('modrinth-search-results', (event, mods) => {
    const container = document.getElementById('mod-results-container');
    container.innerHTML = '';

    if (!mods || mods.length === 0) {
        container.innerHTML = '<div style="color: var(--text-muted);">No items found for query.</div>';
        return;
    }

    mods.forEach(mod => {
        const card = document.createElement('div');
        card.className = 'mod-card';

        const info = document.createElement('div');
        info.className = 'mod-info';
        info.innerHTML = `<h4>${mod.title}</h4><p>${mod.description || 'No description available.'}</p>`;

        const installBtn = document.createElement('button');
        installBtn.className = 'btn-secondary';
        installBtn.id = `mod-btn-${mod.project_id}`;
        installBtn.innerText = `Install ${activeModrinthCategory}`;
        installBtn.addEventListener('click', () => {
            installBtn.innerText = 'Installing...';
            installBtn.disabled = true;
            ipcRenderer.send('download-modrinth-mod', {
                projectId: mod.project_id,
                version: document.getElementById('version').value,
                loader: 'fabric',
                instanceId: currentActiveInstanceId
            });
        });

        card.appendChild(info);
        card.appendChild(installBtn);
        container.appendChild(card);
    });
});

ipcRenderer.on('modrinth-download-success', (event, res) => {
    const btn = document.getElementById(`mod-btn-${res.projectId}`);
    if (btn) {
        btn.innerText = 'Installed ✓';
        btn.style.borderColor = 'var(--accent)';
        btn.style.color = 'var(--accent)';
        btn.disabled = true;
    }
});

ipcRenderer.on('modrinth-download-failed', (event, res) => {
    const btn = document.getElementById(`mod-btn-${res.projectId}`);
    if (btn) {
        btn.innerText = 'Install Failed';
        btn.disabled = false;
    }
    alert(`Failed to install: ${res.error}`);
});

// Screenshots Manager IPC
ipcRenderer.on('screenshots-list', (event, screenshots) => {
    const container = document.getElementById('screenshots-container');
    container.innerHTML = '';

    if (!screenshots || screenshots.length === 0) {
        container.innerHTML = '<div style="color: var(--text-muted); font-size: 13px;">No screenshots found for active instance.</div>';
        return;
    }

    screenshots.forEach(sc => {
        const card = document.createElement('div');
        card.className = 'screenshot-card';
        card.innerHTML = `
            <img src="file://${sc.path}" alt="${sc.filename}" />
            <div style="font-size: 11px; color: var(--text-muted); margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${sc.filename}</div>
        `;
        container.appendChild(card);
    });
});

ipcRenderer.on('export-screenshots-success', (event, filePath) => {
    alert(`Screenshots successfully exported to: ${filePath}`);
});

ipcRenderer.on('export-screenshots-failed', (event, err) => {
    alert(`Export failed: ${err}`);
});

// Performance Pack IPC
ipcRenderer.on('performance-pack-installed', (event, installedMods) => {
    const btn = document.getElementById('install-perf-pack-btn');
    btn.innerText = '⚡ Performance Pack Installed ✓';
    btn.style.borderColor = 'var(--accent)';
    alert(`Successfully installed performance pack mods: ${installedMods.join(', ')}`);
});

ipcRenderer.on('performance-pack-failed', (event, err) => {
    const btn = document.getElementById('install-perf-pack-btn');
    btn.innerText = '⚡ 1-Click Performance Pack';
    alert(`Performance pack installation failed: ${err}`);
});

// Instance Zip Export IPC
ipcRenderer.on('export-instance-success', (event, filePath) => {
    alert(`Instance successfully exported to: ${filePath}`);
});

ipcRenderer.on('export-instance-failed', (event, err) => {
    alert(`Instance export failed: ${err}`);
});

// Instance Management IPC handlers
function handleCreateInstance() {
    const name = document.getElementById('new-instance-name').value.trim();
    const version = document.getElementById('new-instance-version').value;
    const loaderType = document.getElementById('new-instance-loader').value;

    if (!name) {
        alert('Please enter an instance name');
        return;
    }

    ipcRenderer.send('create-instance', {
        name,
        version,
        loaderType
    });
    closeAllModals();
}

ipcRenderer.on('instances-list', (event, instances) => {
    const container = document.getElementById('instances-container');
    container.innerHTML = '';

    instances.forEach(inst => {
        const item = document.createElement('div');
        item.className = 'instance-item-card';
        if (inst.id === currentActiveInstanceId) {
            item.style.borderColor = 'var(--accent)';
        }

        item.innerHTML = `
            <div>
                <strong style="color: var(--text);">${inst.name}</strong>
                <div style="font-size: 11px; color: var(--text-muted);">Version: ${inst.version} (${inst.loaderType})</div>
            </div>
            <div style="display: flex; gap: 8px;">
                <button class="btn-secondary" onclick="selectInstance('${inst.id}')">
                    ${inst.id === currentActiveInstanceId ? 'Active' : 'Select'}
                </button>
                ${inst.id !== 'default' ? `<button class="close-btn" style="padding: 6px 10px; margin-top: 0; font-size: 11px;" onclick="deleteInstance('${inst.id}')">Delete</button>` : ''}
            </div>
        `;
        container.appendChild(item);
    });
});

function selectInstance(instanceId) {
    currentActiveInstanceId = instanceId;
    ipcRenderer.send('save-config', { selectedInstanceId: instanceId });
    document.getElementById('instance-path-text').innerText = instanceId;
    ipcRenderer.send('list-instances');
}

function deleteInstance(instanceId) {
    if (confirm(`Delete instance ${instanceId}?`)) {
        ipcRenderer.send('delete-instance', instanceId);
    }
}

// Game Launching logic & Button behavior fix
function handleLaunch() {
    const playBtn = document.getElementById('play-btn');
    playBtn.disabled = true;

    if (isVersionDownloadedLocally) {
        playBtn.innerText = "LOADING...";
    } else {
        playBtn.innerText = "DOWNLOADING...";
    }

    const config = {
        username: document.getElementById('offline-username-input').value,
        version: document.getElementById('version').value,
        javaPath: document.getElementById('java-path').value,
        minRam: document.getElementById('min-ram').value,
        maxRam: document.getElementById('max-ram').value,
        instanceId: currentActiveInstanceId
    };

    ipcRenderer.send('launch-game', config);
}

ipcRenderer.on('download-progress', (event, data) => {
    const playBtn = document.getElementById('play-btn');
    if (data.type === 'progress') {
        let percent = Math.round((data.current / data.total) * 100);
        if (isVersionDownloadedLocally) {
            playBtn.innerText = `LOADING... ${percent}%`;
        } else {
            playBtn.innerText = `DOWNLOADING... ${percent}%`;
        }
    } else if (data.type === 'extract') {
        playBtn.innerText = isVersionDownloadedLocally ? "LOADING..." : "EXTRACTING...";
    }
});

ipcRenderer.on('game-launched', () => {
    const playBtn = document.getElementById('play-btn');
    playBtn.innerText = "PLAYING";
});

ipcRenderer.on('game-closed', () => {
    const playBtn = document.getElementById('play-btn');
    playBtn.innerText = isVersionDownloadedLocally ? "PLAY" : "DOWNLOAD & PLAY";
    playBtn.disabled = false;
});
