const { ipcRenderer, shell } = require('electron');
const qrcode = require('qrcode');

let currentConfig = {};
// Single source of truth (package.json) prevents stale version strings in UI.
const APP_VERSION = require('./package.json').version;
let isVersionDownloadedLocally = false;
let currentActiveInstanceId = null;
let activeModrinthCategory = 'mod';
let instanceManagerList = [];

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

document.addEventListener('DOMContentLoaded', () => {
    ipcRenderer.send('get-config');
    ipcRenderer.send('get-themes');
    ipcRenderer.send('get-versions');
    ipcRenderer.send('detect-java-runtimes');
    ipcRenderer.send('list-instances');

    initEventListeners();
    initFontSelector();

    document.getElementById('about-update-btn').addEventListener('click', () => ipcRenderer.send('check-for-update-manual'));
    document.getElementById('about-github-btn').addEventListener('click', () => shell.openExternal('https://github.com/unstablecelik/devLauncher'));
    document.getElementById('about-instagram-btn').addEventListener('click', () => shell.openExternal('https://www.instagram.com/unstlcelik'));
    document.getElementById('about-export-diagnostics-btn').addEventListener('click', exportDiagnosticsZip);
});

function initEventListeners() {
    document.getElementById('play-btn').addEventListener('click', () => handleLaunch());
    document.getElementById('github-link').addEventListener('click', () => {
        shell.openExternal('https://github.com/unstablecelik/devLauncher');
    });
    document.getElementById('instagram-link').addEventListener('click', () => {
        shell.openExternal('https://www.instagram.com/unstablecelik');
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

    let searchDebounceTimer = null;
    document.getElementById('mod-search-btn').addEventListener('click', triggerModrinthSearch);
    document.getElementById('mod-search-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            triggerModrinthSearch();
        }
    });
    document.getElementById('mod-search-input').addEventListener('input', (e) => {
        clearTimeout(searchDebounceTimer);
        const query = e.target.value.trim();
        if (query.length >= 2) {
            searchDebounceTimer = setTimeout(() => {
                triggerModrinthSearch();
            }, 300);
        }
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

    document.getElementById('analyze-crash-btn').addEventListener('click', () => {
        const btn = document.getElementById('analyze-crash-btn');
        btn.innerText = 'Analyzing...';
        btn.disabled = true;
        ipcRenderer.send('analyze-crash', { instanceId: currentActiveInstanceId });
    });

    document.getElementById('export-screenshots-zip-btn').addEventListener('click', () => {
        ipcRenderer.send('export-screenshots-zip', currentActiveInstanceId);
    });

    document.getElementById('open-import-btn').addEventListener('click', openImportModal);
    document.getElementById('import-run-btn').addEventListener('click', runImport);
    document.getElementById('open-timemachine-btn').addEventListener('click', openTimeMachine);
    document.getElementById('open-moddoctor-btn').addEventListener('click', openModDoctor);
    document.getElementById('open-remoteplay-btn').addEventListener('click', openRemotePlay);
    refreshBenchmarkLine();

    async function refreshBenchmarkLine() {
        const line = document.getElementById('benchmark-line');
        if (!line) return;
        try {
            const s = await ipcRenderer.invoke('benchmark-summary');
            if (!s || !s.last) { line.innerText = ''; return; }
            const l = s.last;
            const ttfp = l.ttfpSeconds != null ? `${l.ttfpSeconds}s` : 'no TTFP (crash?)';
            const w = s.averageByPrefetch.withPrefetch ? `${s.averageByPrefetch.withPrefetch.avgSeconds}s (n=${s.averageByPrefetch.withPrefetch.count})` : '—';
            const wo = s.averageByPrefetch.without ? `${s.averageByPrefetch.without.avgSeconds}s (n=${s.averageByPrefetch.without.count})` : '—';
            // A/B verdict when both sides have enough samples
            let verdict = '';
            const wp = s.averageByPrefetch.withPrefetch, wout = s.averageByPrefetch.without;
            if (wp && wout && wp.count >= 3 && wout.count >= 3 && wo !== '—' && w !== '—') {
                const delta = +(wp.avgSeconds - wout.avgSeconds).toFixed(1);
                const pct = wout.avgSeconds > 0 ? Math.round(Math.abs(delta) / wout.avgSeconds * 100) : 0;
                verdict = ` · 🔬 A/B verdict: prefetch ${delta < 0 ? 'saves' : 'costs'} ~${Math.abs(delta)}s (${pct}%) vs no-prefetch`;
            }
            line.innerHTML = `⏱ Last launch: <strong>${ttfp}</strong> → playable (${l.marker || ''}, prefetch ${l.prefetchDone ? 'ON' : 'off'}) · avg with prefetch ${w} · without ${wo}${verdict} · <span title="${escapeHtml(JSON.stringify(l))}">details</span>`;
        } catch (_) { line.innerText = ''; }
    }

    async function openRemotePlay() {
        ipcRenderer.send('update-discord-presence', { details: `devLauncher ${APP_VERSION}`, state: 'Configuring Remote Play' });
        openModal('remoteplay-modal');
        refreshRemoteStatus();
    }

    function renderRemoteStatus(d) {
        const el = document.getElementById('remote-status');
        if (!d || !d.found) {
            el.innerHTML = '❌ <em>Sunshine was not found.</em> Open this panel again after installing it.';
        } else {
            el.innerHTML = `✅ <strong>Sunshine bulundu</strong> (${escapeHtml(d.platform)})<br>
                <span style="color:var(--text-muted);font-size:10px;">config: ${escapeHtml(d.configDir || '—')}<br>
                apps.json: ${escapeHtml(d.appsJsonPath || '—')} · binary: ${escapeHtml(d.binaryPath || '—')} · web: ${escapeHtml(d.webUrl)}</span>`;
        }
    }

    async function refreshRemoteStatus() {
        document.getElementById('remote-status').innerHTML = '🔎 Detecting Sunshine...';
        try {
            renderRemoteStatus(await ipcRenderer.invoke('remote-detect'));
        } catch (err) {
            document.getElementById('remote-status').innerText = 'Detect failed: ' + (err.message || err);
        }
    }

    document.getElementById('remote-refresh-btn').addEventListener('click', refreshRemoteStatus);
    document.getElementById('remote-ui-btn').addEventListener('click', () => ipcRenderer.send('remote-open-ui'));
    document.getElementById('remote-app-btn').addEventListener('click', async () => {
        const btn = document.getElementById('remote-app-btn');
        btn.disabled = true;
        try {
            const res = await ipcRenderer.invoke('remote-ensure-app', { instanceId: currentActiveInstanceId, instanceName: currentActiveInstanceId });
            document.getElementById('remote-status').innerHTML = res && res.ok
                ? `✅ devLauncher Sunshine apps.json'a eklendi (backup: ${escapeHtml(res.backup || '')})`
                : `⚠️ ${escapeHtml((res && res.error) || 'Could not write apps.json')}`;
        } finally { btn.disabled = false; }
    });
    document.getElementById('remote-pin-btn').addEventListener('click', async () => {
        const btn = document.getElementById('remote-pin-btn');
        const out = document.getElementById('remote-pin-result');
        const pin = document.getElementById('remote-pin-input').value.trim();
        if (!pin) { out.innerText = 'Enter the PIN displayed by Sunshine.'; return; }
        btn.disabled = true; out.innerText = 'Pairing…';
        const res = await ipcRenderer.invoke('remote-pin', pin);
        btn.disabled = false;
        if (res && res.ok) out.innerHTML = '✅ Paired! Moonlight can now connect.';
        else if (res && res.manual) out.innerHTML = `⚠️ ${escapeHtml(res.error || '')}`;
        else out.innerText = `❌ ${escapeHtml((res && (res.error || res.body)) || 'Pair failed')}`;
    });

    ipcRenderer.on('game-closed', refreshBenchmarkLine);

    document.getElementById('add-offline-account-btn').addEventListener('click', async () => {
        const input = document.getElementById('offline-username-input');
        const name = input.value.trim();
        if (!name) { alert('Enter an offline username first.'); return; }
        const res = await ipcRenderer.invoke('account-add-offline', name);
        if (res && res.success) {
            refreshAccountsList();
            updateAccountButtonDisplay();
        } else {
            alert((res && res.error) || 'Could not save account');
        }
    });

    document.getElementById('change-skin-btn').addEventListener('click', changeSkinFlow);

    document.getElementById('refresh-ms-session-btn').addEventListener('click', async () => {
        // null → the hub refreshes whichever Microsoft account is active
        const res = await ipcRenderer.invoke('account-refresh', null);
        alert(res && res.success ? 'Microsoft session refreshed.' : (res && res.error) || 'Refresh failed');
        refreshAccountsList();
    });

    document.getElementById('min-ram').addEventListener('change', saveSettingsForm);
    document.getElementById('max-ram').addEventListener('change', saveSettingsForm);
    document.getElementById('java-path').addEventListener('change', saveSettingsForm);
    document.getElementById('gc-mode-select').addEventListener('change', saveSettingsForm);
    document.getElementById('custom-jvm-args').addEventListener('change', saveSettingsForm);
    document.getElementById('discord-client-id').addEventListener('change', saveSettingsForm);
    ['proxy-mode-select', 'proxy-url-input', 'proxy-user-input'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', saveSettingsForm);
    });
    {
        const passInput = document.getElementById('proxy-pass-input');
        if (passInput) {
            passInput.addEventListener('change', saveSettingsForm);
            passInput.addEventListener('blur', saveSettingsForm);
        }
    }

    document.getElementById('connectivity-test-btn') && document.getElementById('connectivity-test-btn').addEventListener('click', async () => {
        const btn = document.getElementById('connectivity-test-btn');
        const summary = document.getElementById('connectivity-summary');
        btn.disabled = true;
        btn.innerText = '🛰 Testing…';
        summary.innerText = 'Probing Mojang, Modrinth, GitHub and Adoptium (12s timeout each)…';
        try {
            const res = await ipcRenderer.invoke('connectivity-test');
            if (!res.ok) throw new Error(res.error || 'test failed');
            const ok = res.endpoints.filter(e => e.reachable);
            const bad = res.endpoints.filter(e => !e.reachable);
            if (!bad.length) {
                summary.innerHTML = `<span style="color:#2ecc71;">✔ All ${ok.length} connected services reachable</span> — network is fine.`;
            } else {
                summary.innerHTML = `<span style="color:#e74c3c;">✖ ${bad.length} of ${res.endpoints.length} blocked:</span><br>` +
                    bad.map(e => `• ${e.label} — ${e.error || ('HTTP ' + e.status)}`).join('<br>') +
                    `<br><span style="color:var(--text-muted);">School/work networks usually need a proxy: set Proxy → Custom above, or use a Mobile Hotspot.</span>`;
            }
        } catch (err) {
            summary.innerHTML = `<span style="color:#e74c3c;">✖ Connectivity test failed: ${escapeHtml(String(err.message || err))}</span>`;
        } finally {
            btn.disabled = false;
            btn.innerText = '🛰 Test Connectivity';
        }
    });

    document.getElementById('java-select').addEventListener('change', (e) => {
        if (e.target.value) {
            document.getElementById('java-path').value = e.target.value;
            saveSettingsForm();
        }
    });

    // P2P World Sharing Listeners
    document.getElementById('p2p-start-btn').addEventListener('click', () => {
        const port = document.getElementById('p2p-port-input').value || 25565;
        const roomName = document.getElementById('p2p-room-input').value.trim() || null;
        document.getElementById('p2p-start-btn').innerText = 'Starting Tunnel...';
        document.getElementById('p2p-start-btn').disabled = true;
        ipcRenderer.send('p2p-host-world', { port, roomName });
    });

    document.getElementById('p2p-stop-btn').addEventListener('click', () => {
        ipcRenderer.send('p2p-stop-host');
    });

    document.getElementById('p2p-copy-btn').addEventListener('click', () => {
        const copyText = document.getElementById('p2p-connect-address');
        copyText.select();
        navigator.clipboard.writeText(copyText.value);
        document.getElementById('p2p-copy-btn').innerText = 'Copied!';
        setTimeout(() => { document.getElementById('p2p-copy-btn').innerText = 'Copy'; }, 2000);
    });
}

function saveSettingsForm() {
    ipcRenderer.send('save-config', {
        minRam: document.getElementById('min-ram').value,
        maxRam: document.getElementById('max-ram').value,
        javaPath: document.getElementById('java-path').value,
        gcMode: document.getElementById('gc-mode-select').value,
        customJvmArgs: document.getElementById('custom-jvm-args').value,
        discordClientId: document.getElementById('discord-client-id').value,
        proxyMode: document.getElementById('proxy-mode-select').value,
        proxyUrl: document.getElementById('proxy-url-input').value.trim(),
        proxyUser: document.getElementById('proxy-user-input').value.trim(),
        proxyPass: document.getElementById('proxy-pass-input').value
    });
}

function updateAccountButtonDisplay() {
    const accountBtn = document.getElementById('account-btn-trigger');
    if (currentConfig.accountType === 'microsoft' && currentConfig.microsoftAuthData) {
        accountBtn.innerText = `🟢 ${currentConfig.microsoftAuthData.name}`;
    } else {
        accountBtn.innerText = `👤 ${currentConfig.username || 'Player'}`;
    }
}

function hexToRgba(hex, alpha) {
    if (!hex) return hex;
    let c = hex.replace('#', '');
    if (c.length === 3) c = c.split('').map(x => x + x).join('');
    const num = parseInt(c, 16);
    return `rgba(${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}, ${alpha})`;
}

function applyTheme(themeData) {
    if (!themeData) return;
    const root = document.documentElement;
    const opacity = typeof themeData.opacity === 'number' ? themeData.opacity : 1.0;

    root.style.setProperty('--bg-main', opacity < 1 ? hexToRgba(themeData.bgMain, opacity) : themeData.bgMain);
    root.style.setProperty('--bg-dark', opacity < 1 ? hexToRgba(themeData.bgDark, opacity) : themeData.bgDark);
    root.style.setProperty('--bg-bar', opacity < 1 ? hexToRgba(themeData.bgBar, opacity) : themeData.bgBar);
    root.style.setProperty('--accent', themeData.accent);
    root.style.setProperty('--accent-hover', themeData.accentHover);
    root.style.setProperty('--text', themeData.text);
    root.style.setProperty('--text-muted', themeData.textMuted);
    root.style.setProperty('--border', themeData.border);

    if (themeData.fontFamily) {
        document.documentElement.style.setProperty('--ui-font', themeData.fontFamily);
    }
}

// ── Interface font (OS-optimized, persisted) ────────────────────────────────
const UI_FONT_LISTS = [
    { name: 'Departure Mono (default)', stack: "'Departure Mono', 'JetBrains Mono', monospace" },
    { name: 'JetBrains Mono (main)', stack: "'JetBrains Mono', monospace" },
    { name: 'Iosevka Mono', stack: "'Iosevka Mono', 'Iosevka', monospace" },
    { name: 'Cascadia Mono', stack: "'Cascadia Mono', 'Cascadia Code', Consolas, monospace" },
    { name: 'Zed Mono', stack: "'Zed Mono', 'Zed Plex Mono', 'JetBrains Mono', monospace" },
    { name: 'System UI font (auto per OS)', stack: "system-ui, sans-serif" },
    { name: 'Segoe UI (Windows)', stack: "'Segoe UI', system-ui, sans-serif" },
    { name: 'SF Pro / System (macOS)', stack: "-apple-system, 'SF Pro Text', 'Helvetica Neue', sans-serif" },
    { name: 'Inter (Linux)', stack: "Inter, 'Noto Sans', sans-serif" },
    { name: 'Ubuntu (Linux)', stack: "Ubuntu, 'Noto Sans', sans-serif" },
    { name: 'Noto Sans (Linux)', stack: "'Noto Sans', sans-serif" }
];

function applyUiFont(fontStack) {
    if (!fontStack || typeof fontStack !== 'string' || fontStack.length > 200) return;
    // Only allow sane font stacks: letters, digits, quotes, commas, dashes.
    if (!/^[A-Za-z0-9 '\",\-_]+$/.test(fontStack)) return;
    document.documentElement.style.setProperty('--ui-font', fontStack);
}

function initFontSelector() {
    const sel = document.getElementById('font-select');
    if (!sel) return;
    sel.innerHTML = '';
    for (const f of UI_FONT_LISTS) {
        const opt = document.createElement('option');
        opt.value = f.stack;
        opt.innerText = f.name;
        sel.appendChild(opt);
    }
    sel.addEventListener('change', () => {
        if (!sel.value) return;
        applyUiFont(sel.value);
        document.getElementById('font-custom-input').value = '';
        ipcRenderer.send('save-ui-font', sel.value);
    });
    document.getElementById('font-apply-btn').addEventListener('click', () => {
        const val = document.getElementById('font-custom-input').value.trim();
        if (!val) return;
        applyUiFont(val);
        sel.value = '';
        ipcRenderer.send('save-ui-font', val);
    });
}

async function fillAboutSection() {
    const box = document.getElementById('about-info');
    try {
        const info = await ipcRenderer.invoke('get-app-info');
        box.innerHTML = `<strong>devLauncher</strong> v${info.version}<br>` +
            `Electron ${info.electron} · Node ${info.node} · ${info.platform}<br>` +
            `Configs & data: <span style="color:var(--text)">~/.devlauncher</span><br>` +
            `Maker: unstablecelik — Minecraft instance manager, mod manager & benchmarking launcher.`;
    } catch (_) {
        box.innerText = 'devLauncher v0.13.0';
    }
}

async function exportDiagnosticsZip() {
    const btn = document.getElementById('about-export-diagnostics-btn');
    btn.disabled = true;
    try {
        const res = await ipcRenderer.invoke('export-diagnostics');
        if (res && res.ok) {
            alert(`Diagnostics zip created:\n${res.path}\n\nAttach it to bug reports. Accounts & auth tokens are excluded.`);
            shell.showItemInFolder(res.path);
        } else {
            alert(`Diagnostics export failed: ${(res && res.error) || 'unknown error'}`);
        }
    } finally {
        btn.disabled = false;
    }
}

// ── Faz 4 UI wiring ──────────────────────────────────────────────────────────
// Mod Updates / Share Code / 1-Click Server / World Preview / LAN QR / First Run

function drawConnectQR(text, canvasId = 'p2p-qr-canvas') {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    try {
        qrcode.toCanvas(canvas, String(text || ''), { width: canvas.width, margin: 1 }, (err) => {
            if (err) canvas.style.display = 'none';
        });
        canvas.style.display = 'block';
    } catch (_) {}
}

// ── Mod updates ──────────────────────────────────────────────────────────────
let modUpdateRows = [];
const modUpdatesStatus = () => document.getElementById('mod-updates-status');
if (document.getElementById('check-mod-updates-btn')) {
    document.getElementById('check-mod-updates-btn').addEventListener('click', () => {
        modUpdatesStatus().innerText = '🔎 Checking Modrinth by jar hash...';
        ipcRenderer.send('check-mod-updates', currentActiveInstanceId);
    });
}
if (document.getElementById('update-mods-all-btn')) {
    document.getElementById('update-mods-all-btn').addEventListener('click', () => {
        const btn = document.getElementById('update-mods-all-btn');
        btn.disabled = true;
        modUpdatesStatus().innerText = '⬆ Updating...';
        ipcRenderer.send('update-mods-all', currentActiveInstanceId);
    });
}
ipcRenderer.on('mod-updates-result', (event, res) => {
    const st = modUpdatesStatus();
    const btnAll = document.getElementById('update-mods-all-btn');
    const btnCheck = document.getElementById('check-mod-updates-btn');
    if (btnCheck) btnCheck.disabled = false;
    if (btnAll) btnAll.disabled = false;
    if (!res.ok) { st.innerText = `❌ ${res.error}`; if (btnAll) btnAll.style.display = 'none'; return; }
    modUpdateRows = res.rows || [];
    const notModrinth = modUpdateRows.filter(r => r.status !== 'ok').length;
    const updates = modUpdateRows.filter(r => r.updateAvailable);
    st.innerHTML = `Checked <strong>${modUpdateRows.length}</strong> mods against ${escapeHtml(String(res.mcVersion))}/${escapeHtml(String(res.loader))}: ` +
        `${notModrinth ? notModrinth + ' not from Modrinth, ' : ''}` +
        (updates.length ? `<strong style="color:var(--accent)">${updates.length} update(s) available 🎉</strong>` : 'all up to date ✅');
    const updatesList = updates.map(u => `${escapeHtml(u.project || '')}: ${escapeHtml(String(u.currentVersion))} → <span style="color:var(--accent)">${escapeHtml(String(u.latestVersion))}</span>`).join(' · ');
    if (updates.length) {
        btnAll.style.display = 'inline-block';
        document.getElementById('update-count-display').innerText = updates.length;
        st.innerHTML += `<br><span style="font-size:10px;">${updatesList}</span>`;
    } else {
        btnAll.style.display = 'none';
    }
});
ipcRenderer.on('mod-update-progress', (event, p) => {
    if (p.project) {
        modUpdatesStatus().innerText = `📥 ${p.current}/${p.total}: ${p.project}`;
    } else {
        modUpdatesStatus().innerText = `⬆ ${p.current}/${p.total}: ${p.file}`;
    }
});
ipcRenderer.on('mod-update-complete', (event, res) => {
    if (!res.ok) { modUpdatesStatus().innerText = `❌ ${res.error}`; return; }
    const failMsg = res.failed && res.failed.length ? `, ${res.failed.length} failed (${res.failed.map(f => f.file).join(', ')})` : '';
    alert(`Mod updates finished: ${res.updated.length} updated${failMsg}. Every change is in the Time Machine — undo anything from there.`);
    modUpdatesStatus().innerText = res.updated.length ? `✅ Updated ${res.updated.length}` : 'Already up to date.';
    ipcRenderer.send('get-installed-mods', currentActiveInstanceId);
});

// ── Share Code ───────────────────────────────────────────────────────────────
ipcRenderer.on('share-code-generated', (event, res) => {
    const st = document.getElementById('share-code-generate-status');
    if (!res.ok) { st.innerText = `❌ ${res.error}`; return; }
    document.getElementById('share-code-output').value = res.code;
    document.getElementById('share-code-copy-btn').style.display = 'inline-block';
    st.innerText = `Contains ${res.modCount} Modrinth mod(s).${res.unknown && res.unknown.length ? ` Skipped non-Modrinth: ${res.unknown.join(', ')}` : ''}`;
});
ipcRenderer.on('share-code-import-progress', (event, p) => {
    document.getElementById('share-code-import-status').innerText = `📥 Installing mods ${p.current}/${p.total}...`;
});
ipcRenderer.on('share-code-import-result', (event, res) => {
    const st = document.getElementById('share-code-import-status');
    if (!res.ok) { st.innerText = `❌ ${res.error}`; return; }
    const failMsg = res.failures && res.failures.length ? `<br><span style="color:#ff7b72;">Failures: ${res.failures.map(f => `${f.project}: ${f.error}`).join(' · ')}</span>` : '';
    st.innerHTML = `✅ Instance <strong>${escapeHtml(res.instanceId)}</strong> created — installed ${res.installed}/${res.total} mods.${failMsg}`;
    ipcRenderer.send('list-instances');
});

ipcRenderer.on('server-create-progress', (event, p) => {
    const el = document.getElementById('server-progress');
    if (el) el.innerText = `⏳ ${p.message}`;
});
ipcRenderer.on('server-create-result', (event, res) => {
    const el = document.getElementById('server-result');
    const btn = document.getElementById('server-create-btn');
    if (btn) btn.disabled = false;
    if (!el) return;
    if (!res.ok) {
        el.innerHTML = `❌ <span style="color:#ff7b72;">${escapeHtml(res.error || 'unknown')}</span>`;
        return;
    }
    el.innerHTML = `✅ Server ready at <strong>${escapeHtml(res.serverDir)}</strong>` +
        `<br>${res.notes.map(n => `• ${escapeHtml(n)}`).join('<br>')}` +
        `<br>Run <strong>start.sh</strong> (or start.bat) and the console opens.`;
});

ipcRenderer.on('world-preview-result', (event, res) => {
    const canvas = document.getElementById('worldpreview-canvas');
    const stats = document.getElementById('worldpreview-stats');
    if (!res.ok) {
        stats.innerHTML = `❌ ${escapeHtml(res.error || 'preview failed')}`;
        return;
    }
    const ctx = canvas.getContext('2d');
    for (let i = 0; i < 256; i++) {
        ctx.fillStyle = res.colors[i] || '#000';
        ctx.fillRect((i % 16) * 16, Math.floor(i / 16) * 16, 16, 16);
    }
    const s = res.stats || {};
    const gm = { 0: 'Survival', 1: 'Creative', 2: 'Adventure' }[s.GameType] || '?';
    stats.innerHTML = `<strong>${escapeHtml(String(s.LevelName || 'World'))}</strong> (${escapeHtml(String(s.version || 'unknown version'))})<br>` +
        `Game mode: ${gm} · Spawn: ${s.SpawnX ?? '?'} / ${s.SpawnY ?? '?'} / ${s.SpawnZ ?? '?'}<br>` +
        `Region file: ${escapeHtml(res.regionFile || '—')} · Height range: ${Math.min(...res.heights)}–${Math.max(...res.heights)}`;
});

// ── First-Run Wizard ─────────────────────────────────────────────────────────
let firstRunStep = 0;
let firstRunShownThisSession = false;
function showFirstRun() {
    if (firstRunShownThisSession) return; // never re-grab the overlay twice per session
    firstRunShownThisSession = true;
    firstRunStep = 1;
    if (!openModal('firstrun-modal')) return;
    // Low-RAM machines (school laptops, 8GB or less): default to 2G so the
    // OS + browser stays usable while the game runs.
    try {
        const totalGb = (require('os').totalmem() || 0) / (1024 * 1024 * 1024);
        if (totalGb && totalGb < 8) {
            const memSelect = document.getElementById('firstrun-memory');
            if (memSelect) memSelect.value = '2G';
        }
    } catch (_) {}
}
function setFirstRunStep(n) {
    for (let i = 1; i <= 3; i++) {
        const el = document.getElementById(`firstrun-step${i}`);
        if (el) el.style.display = i === n ? 'block' : 'none';
    }
    document.getElementById('firstrun-next-btn').innerText = n === 3 ? 'Finish 🚀' : 'Continue';
}
async function loadFirstRunScan() {
    const list = document.getElementById('firstrun-scan-list');
    list.innerHTML = '<div style="color:var(--text-muted); font-size:11px;">🔎 Scanning Prism / MultiMC / vanilla roots...</div>';
    const items = await ipcRenderer.invoke('import-scan');
    if (!Array.isArray(items) || items.length === 0) {
        list.innerHTML = '<div style="color:var(--text-muted); font-size:11px;">Nothing found from other launchers — you are starting fresh 🙂</div>';
        return;
    }
    list.innerHTML = items.map((it, i) => `<label style="display:flex; gap:6px; align-items:center;"><input type="checkbox" class="firstrun-import-item" value="${escapeHtml(String(i))}" checked> ${escapeHtml(it.name || String(i))}</label>`).join('');
    list.dataset.count = items.length;
}

if (document.getElementById('firstrun-next-btn')) {
    document.getElementById('firstrun-next-btn').addEventListener('click', async () => {
        const btn = document.getElementById('firstrun-next-btn');
        if (firstRunStep === 1) {
            const username = document.getElementById('firstrun-username').value.trim() || 'Player';
            const memory = document.getElementById('firstrun-memory').value;
            ipcRenderer.send('save-config', { username, maxRam: memory, minRam: '2G' });
            document.getElementById('offline-username-input').value = username;
            document.getElementById('max-ram').value = memory;
            firstRunStep = 2;
            setFirstRunStep(2);
            await loadFirstRunScan();
        } else if (firstRunStep === 2) {
            const items = await ipcRenderer.invoke('import-scan');
            const checked = Array.from(document.querySelectorAll('.firstrun-import-item')).filter(cb => cb.checked).map(cb => items[Number(cb.value)]).filter(Boolean);
            if (checked.length > 0) {
                btn.disabled = true;
                btn.innerText = 'Importing...';
                const results = await ipcRenderer.invoke('import-run', checked);
                btn.innerText = results.filter(r => r.success).length + ' items imported.';
            }
            firstRunStep = 3;
            setFirstRunStep(3);
            btn.disabled = false;
        } else {
            ipcRenderer.send('save-config', { firstRunDone: true });
            closeAllModals();
        }
    });
    document.getElementById('firstrun-skip-btn').addEventListener('click', () => {
        ipcRenderer.send('save-config', { firstRunDone: true });
        closeAllModals();
    });
}

// Show the wizard once when setup was never completed
setTimeout(() => {
    if (currentConfig && currentConfig.firstRunDone !== true) showFirstRun();
}, 1500);
// ── Faz 4 modal openers & buttons ────────────────────────────────────────────
if (document.getElementById('share-code-btn')) {
    document.getElementById('share-code-btn').addEventListener('click', () => {
        ipcRenderer.send('update-discord-presence', { details: `devLauncher ${APP_VERSION}`, state: 'Sharing Instance Code' });
        openModal('sharecode-modal');
    });
    document.getElementById('share-code-generate-btn').addEventListener('click', () => {
        const btn = document.getElementById('share-code-generate-btn');
        btn.disabled = true;
        document.getElementById('share-code-generate-status').innerText = '🔎 Resolving mods on Modrinth (sha1 lookups)...';
        ipcRenderer.send('share-code-generate', currentActiveInstanceId);
        setTimeout(() => { btn.disabled = false; }, 400);
    });
    document.getElementById('share-code-copy-btn').addEventListener('click', () => {
        const out = document.getElementById('share-code-output');
        out.select();
        navigator.clipboard.writeText(out.value).then(() => {
            document.getElementById('share-code-generate-status').innerText = '✅ Copied to clipboard.';
        });
    });
    document.getElementById('share-code-import-btn').addEventListener('click', () => {
        const code = document.getElementById('share-code-input').value.trim();
        if (!code) { document.getElementById('share-code-import-status').innerText = 'Paste a DL13- code first.'; return; }
        document.getElementById('share-code-import-status').innerText = '⚡ Creating instance + downloading mods...';
        ipcRenderer.send('share-code-import', code);
    });
}
if (document.getElementById('one-click-server-btn')) {
    document.getElementById('one-click-server-btn').addEventListener('click', () => {
        const inst = instanceManagerList.find(i => i.id === currentActiveInstanceId);
        document.getElementById('server-instance-name').innerText = inst ? `${inst.name} (${inst.version}/${inst.loaderType})` : currentActiveInstanceId;
        document.getElementById('server-progress').innerText = '';
        document.getElementById('server-result').innerText = '';
        openModal('server-modal');
    });
    document.getElementById('server-create-btn').addEventListener('click', () => {
        document.getElementById('server-create-btn').disabled = true;
        document.getElementById('server-progress').innerText = '⏳ Starting...';
        ipcRenderer.send('create-server-from-instance', currentActiveInstanceId);
        setTimeout(() => { const b = document.getElementById('server-create-btn'); if (b) b.disabled = false; }, 5000);
    });
}

// ── Tab Switching & Dynamic Discord Presence Update
function switchTab(tabId, btnElement) {
    document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.nav-tab').forEach(btn => btn.classList.remove('active'));

    document.getElementById(tabId).classList.add('active');
    if (btnElement) btnElement.classList.add('active');

    let sectionName = 'Browsing Dashboard';
    if (tabId === 'modrinth-tab') sectionName = 'Browsing Mod Manager';
    if (tabId === 'instances-tab') sectionName = 'Managing Instances';
    if (tabId === 'worlds-tab') {
        sectionName = 'Exploring Worlds';
        ipcRenderer.send('get-worlds', currentActiveInstanceId);
    }
    if (tabId === 'screenshots-tab') {
        sectionName = 'Viewing Screenshots';
        ipcRenderer.send('get-screenshots', currentActiveInstanceId);
    }
    if (tabId === 'p2p-tab') {
        sectionName = 'Sharing Worlds Online';
        ipcRenderer.send('p2p-get-status');
    }

    ipcRenderer.send('update-discord-presence', {
        details: `devLauncher ${APP_VERSION}`,
        state: sectionName
    });

    if (tabId === 'instances-tab') {
        ipcRenderer.send('get-installed-mods', currentActiveInstanceId);
    }
}

// Apply the selected Minecraft version to the dropdown and check installed/downloaded state.
// Prevents the play button showing a wrong "DOWNLOAD & PLAY" / "DOWNLOADING" label
// after a race between config-data and versions-list arriving in any order.
function applySelectedVersion() {
    const versionSelect = document.getElementById('version');
    if (!versionSelect || !versionSelect.options || versionSelect.options.length === 0) {
        return;
    }

    if (currentConfig && currentConfig.selectedVersion) {
        const exists = Array.from(versionSelect.options).some(opt => opt.value === currentConfig.selectedVersion);
        if (exists) {
            versionSelect.value = currentConfig.selectedVersion;
        }
    }

    ipcRenderer.send('check-version-status', versionSelect.value);
}

function getActiveLoader() {
    const ver = document.getElementById('version').value;
    if (ver.startsWith('fabric')) return 'fabric';
    if (ver.startsWith('quilt')) return 'quilt';
    if (ver.startsWith('neoforge')) return 'neoforge';
    if (ver.startsWith('forge')) return 'forge';
    return null;
}

function triggerModrinthSearch() {
    const query = document.getElementById('mod-search-input').value;
    const version = document.getElementById('version').value;
    const loader = getActiveLoader();
    ipcRenderer.send('search-modrinth-mods', { query, version, loader, projectType: activeModrinthCategory });
}

function selectModrinthCategory(category, btnElement) {
    activeModrinthCategory = category;
    document.querySelectorAll('.sub-tab-btn').forEach(btn => btn.classList.remove('active'));
    if (btnElement) btnElement.classList.add('active');

    triggerModrinthSearch();
}

// Modal Control with Discord Presence Updates
function openAccountModal() {
    ipcRenderer.send('update-discord-presence', { details: `devLauncher ${APP_VERSION}`, state: 'Configuring Account' });
    openModal('account-modal');
    refreshAccountsList();
    loadProfileSkin();
}

async function refreshAccountsList() {
    try {
        const accounts = await ipcRenderer.invoke('accounts-list');
        renderAccountsList(accounts);
    } catch (err) {
        const box = document.getElementById('accounts-list');
        if (box) box.innerHTML = `<div style="color: var(--text-muted); font-size: 11px;">${escapeHtml(String(err.message || err))}</div>`;
    }
}

function renderAccountsList(accounts) {
    const box = document.getElementById('accounts-list');
    if (!box) return;
    box.innerHTML = '';
    if (!accounts || accounts.length === 0) {
        box.innerHTML = '<div style="color: var(--text-muted); font-size: 11px;">No accounts saved yet.</div>';
        return;
    }
    accounts.forEach(acc => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--bg-main);border:1px solid var(--border);border-radius:6px;';
        row.innerHTML = `
            <span style="font-size:14px;">${acc.type === 'microsoft' ? '🟩' : '⚪'}</span>
            <div style="flex:1;">
                <strong style="font-size:12px;color:var(--text);">${escapeHtml(acc.username)}</strong>
                <div style="font-size:10px;color:var(--text-muted);">${acc.type === 'microsoft' ? 'Microsoft' : 'Offline'}${acc.encrypted ? ' · 🔒 encrypted' : ''}${acc.refreshTokenSaved ? ' · refresh saved' : ''}</div>
            </div>
        `;
        const setActiveBtn = document.createElement('button');
        setActiveBtn.className = 'btn-secondary';
        setActiveBtn.style.cssText = 'padding:4px 8px;font-size:10px;';
        setActiveBtn.innerText = 'Use';
        setActiveBtn.addEventListener('click', async () => {
            await ipcRenderer.invoke('account-set-active', acc.id);
            refreshAccountsList();
        });
        const refreshBtn = document.createElement('button');
        refreshBtn.style.cssText = 'padding:4px 8px;font-size:10px;';
        refreshBtn.className = 'btn-secondary';
        refreshBtn.innerText = '🔁';
        refreshBtn.title = 'Refresh Microsoft session token';
        if (acc.type !== 'microsoft') {
            refreshBtn.disabled = true;
            refreshBtn.style.opacity = '0.4';
        }
        refreshBtn.addEventListener('click', async () => {
            refreshBtn.disabled = true;
            const res = await ipcRenderer.invoke('account-refresh', acc.id);
            refreshBtn.disabled = false;
            if (res && res.success) { refreshAccountsList(); }
            else alert((res && res.error) || 'Refresh failed');
        });
        const removeBtn = document.createElement('button');
        removeBtn.className = 'close-btn';
        removeBtn.style.cssText = 'padding:4px 8px;margin-top:0;font-size:10px;';
        removeBtn.innerText = '✕';
        removeBtn.title = 'Remove account';
        removeBtn.addEventListener('click', async () => {
            if (!confirm(`Remove account "${acc.username}"?`)) return;
            await ipcRenderer.invoke('account-remove', acc.id);
            refreshAccountsList();
        });
        row.appendChild(setActiveBtn);
        row.appendChild(refreshBtn);
        row.appendChild(removeBtn);
        box.appendChild(row);
    });
}

// ── Skin manager (Mojang profile API + isometric head renderer) ──────────────
async function loadProfileSkin() {
    const section = document.getElementById('ms-profile-section');
    const status = document.getElementById('ms-profile-status');
    const canvas = document.getElementById('skin-head-canvas');
    if (!section) return;

    try {
        const res = await ipcRenderer.invoke('get-profile-skin');
        if (!res.ok) {
            section.style.display = 'none';
            if (status) status.innerText = res.error || 'Profile unavailable.';
            return;
        }
        section.style.display = 'block';
        document.getElementById('ms-profile-name').innerText = res.name || '—';
        document.getElementById('ms-profile-variant').innerText = res.skin && res.skin.variant ? `Skin: ${res.skin.variant}` : 'No active skin';

        if (res.skinDataUrl && canvas) {
            const img = new Image();
            img.onload = () => { drawIsoHead(canvas, img); };
            img.src = res.skinDataUrl;
        }
    } catch (err) {
        section.style.display = 'none';
        if (status) status.innerText = 'Profile error: ' + (err.message || err);
    }
}

// Isometric Minecraft head from a skin texture (top + front + side, with hat layer)
function drawIsoHead(canvas, img, size) {
    if (!canvas || !img) return;
    size = size || 96;
    const margin = 2;
    const s = (size - margin * 2) / 16; // cube edge in px
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, size, size);

    const cx = size / 2;
    const she = 0.5 * s;                 // half-edge vertical shear
    const paneTopTilt = s / 8;           // per-texture-pixel slope of pane tops
    const topY = margin + 1.5 * s;       // top vertex y
    const paneTopV = topY + 2 * she;     // pane outer top corners (y)

    const face = (sx, sy, a, b, c, d, e, f) => {
        ctx.save();
        ctx.setTransform(a, b, c, d, e, f);
        ctx.drawImage(img, sx, sy, 8, 8, 0, 0, 8, 8);
        ctx.restore();
    };

    // Left pane = front face (8,8): converges down toward the center vertex
    face(8, 8, s / 8, paneTopTilt, 0, s / 8, cx - 8 * (s / 8), paneTopV);
    // Right pane = left-side texture (16,8): mirrors the tilt
    face(16, 8, s / 8, -paneTopTilt, 0, s / 8, cx, paneTopV + 2 * she);
    // Top diamond = top face (8,0)
    face(8, 0, s / 8, paneTopTilt, -(s / 8), paneTopTilt, cx, topY);

    // Hat overlay (transparent pixels don't paint)
    face(40, 8, s / 8, paneTopTilt, 0, s / 8, cx - 8 * (s / 8), paneTopV);
    face(48, 8, s / 8, -paneTopTilt, 0, s / 8, cx, paneTopV + 2 * she);
    face(40, 0, s / 8, paneTopTilt, -(s / 8), paneTopTilt, cx, topY);
}

async function changeSkinFlow() {
    const status = document.getElementById('ms-profile-status');
    try {
        const chosen = await ipcRenderer.invoke('choose-skin-file');
        if (!chosen || chosen.canceled) return;
        const variant = confirm('Is this a SLIM (Alex) skin?\n\nOK = slim arms\nCancel = classic arms');
        status.innerText = 'Uploading skin...';
        const res = await ipcRenderer.invoke('upload-skin', { filePath: chosen.path, variant: variant ? 'slim' : 'classic' });
        if (res && res.ok) {
            status.innerText = '✅ Skin uploaded! In-game preview may take a few seconds to refresh.';
            loadProfileSkin();
        } else {
            status.innerText = (res && res.error) || 'Upload failed.';
            alert((res && res.error) || 'Skin upload failed');
        }
    } catch (err) {
        status.innerText = 'Error: ' + (err.message || err);
    }
}

function openSettingsModal() {
    ipcRenderer.send('update-discord-presence', { details: `devLauncher ${APP_VERSION}`, state: 'Adjusting Settings' });
    openModal('settings-modal');
    fillAboutSection();
}

function openCreateInstanceModal() {
    ipcRenderer.send('update-discord-presence', { details: `devLauncher ${APP_VERSION}`, state: 'Creating Instance' });
    openModal('create-instance-modal');
}

function openThemeModal() {
    ipcRenderer.send('update-discord-presence', { details: `devLauncher ${APP_VERSION}`, state: 'Customizing Theme' });
    ipcRenderer.send('get-themes');
    openModal('theme-modal');
}

async function openImportModal() {
    ipcRenderer.send('update-discord-presence', { details: `devLauncher ${APP_VERSION}`, state: 'Importing Instances' });
    openModal('import-modal');
    document.getElementById('import-results').innerText = '';
    document.getElementById('import-run-btn').disabled = true;
    document.getElementById('import-run-btn').innerText = 'Import Selected';

    const listEl = document.getElementById('import-items-list');
    listEl.innerHTML = '<div style="color: var(--text-muted); font-size: 12px;">Scanning...</div>';
    try {
        const items = await ipcRenderer.invoke('import-scan');
        lastImportItems = items;
        renderImportItems(items);
    } catch (err) {
        listEl.innerHTML = `<div style="color: var(--text-muted); font-size: 12px;">Scan failed: ${escapeHtml(String(err.message || err))}</div>`;
    }
}

function renderImportItems(items) {
    const listEl = document.getElementById('import-items-list');
    listEl.innerHTML = '';
    if (!items || items.length === 0) {
        listEl.innerHTML = '<div style="color: var(--text-muted); font-size: 12px;">Nothing found. Install things or launch games with Prism/MultiMC/vanilla first, then re-open this window.</div>';
        return;
    }
    items.forEach((item, idx) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:10px;align-items:center;padding:10px;background:var(--bg-main);border:1px solid var(--border);border-radius:6px;';
        const loaderBadge = item.loaderType !== 'vanilla' ? ` · <strong>${escapeHtml(item.loaderType)}</strong> ${escapeHtml(item.loaderVersion || '')}` : '';
        row.innerHTML = `
            <input type="checkbox" class="import-check" data-idx="${idx}" checked style="width:16px;height:16px;" />
            <div style="flex:1;">
                <strong style="font-size:12px;">${escapeHtml(item.name)}</strong>
                <div style="font-size:10px;color:var(--text-muted);">
                    ${escapeHtml(item.source)} · v${escapeHtml(item.version)}${loaderBadge} · ${item.modsCount} mods · ${item.worldsCount} worlds · ~${item.sizeMB} MB
                </div>
            </div>
        `;
        listEl.appendChild(row);
    });
    document.getElementById('import-run-btn').disabled = false;
}

async function runImport() {
    const btn = document.getElementById('import-run-btn');
    const selected = [...document.querySelectorAll('.import-check:checked')]
        .map(cb => lastImportItems[parseInt(cb.dataset.idx, 10)])
        .filter(Boolean);
    if (selected.length === 0) return;

    btn.disabled = true;
    btn.innerText = 'Importing...';
    try {
        const results = await ipcRenderer.invoke('import-run', selected);
        if (results) lastImportItems = null;
        const lines = results.map(r => r.success
            ? `✅ ${escapeHtml(r.name)} → instance "${escapeHtml(r.instanceId)}"`
            : `❌ ${escapeHtml(r.name || '?')}: ${escapeHtml(String(r.error))}`);
        document.getElementById('import-results').innerHTML = lines.join('<br>');
        ipcRenderer.send('list-instances'); // refresh instance list
    } catch (err) {
        document.getElementById('import-results').innerText = 'Import failed: ' + (err.message || err);
    } finally {
        btn.innerText = 'Import Selected';
    }
}

let lastImportItems = null;

// ── Mod Doctor UI ────────────────────────────────────────────────────────────
async function openModDoctor() {
    ipcRenderer.send('update-discord-presence', { details: `devLauncher ${APP_VERSION}`, state: 'Running Mod Doctor' });
    openModal('moddoctor-modal');
    const resultsEl = document.getElementById('moddoctor-results');
    resultsEl.innerHTML = '<div style="color: var(--text-muted); font-size: 12px;">Scanning jars...</div>';
    try {
        const res = await ipcRenderer.invoke('mod-doctor-scan', currentActiveInstanceId);
        renderModDoctorResults(res);
    } catch (err) {
        resultsEl.innerHTML = `<div style="color: var(--text-muted); font-size: 12px;">${escapeHtml(String(err.message || err))}</div>`;
    }
}

function renderModDoctorResults(res) {
    const resultsEl = document.getElementById('moddoctor-results');
    const summaryEl = document.getElementById('moddoctor-summary');
    if (!res || res.error) {
        resultsEl.innerHTML = `<div style="color: var(--text-muted); font-size: 12px;">${escapeHtml((res && res.error) || 'Scan failed')}</div>`;
        return;
    }
    const s = res.summary;
    summaryEl.innerHTML = `
        <span style="padding:4px 8px;border:1px solid var(--border);border-radius:5px;">🧾 ${s.total} mods</span>
        <span style="padding:4px 8px;border:1px solid var(--border);border-radius:5px;color:#2ecc71;">${s.ok} ok</span>
        <span style="padding:4px 8px;border:1px solid var(--border);border-radius:5px;color:#f39c12;">${s.warn} warn</span>
        <span style="padding:4px 8px;border:1px solid var(--border);border-radius:5px;color:#e74c3c;">${s.error} problems</span>
        <span style="padding:4px 8px;border:1px solid var(--border);border-radius:5px;color:var(--text-muted);">${s.disabled} disabled</span>
    `;

    resultsEl.innerHTML = '';
    if (s.total === 0) {
        resultsEl.innerHTML = '<div style="color: var(--text-muted); font-size: 12px;">No mods installed in this instance. Nothing to check.</div>';
        return;
    }

    // Missing dependencies banner
    if (res.missingDependencies.length > 0) {
        const missingRows = res.missingDependencies.map(md => `${escapeHtml(md.depId)} (needed by ${md.requiredBy.map(escapeHtml).join(', ')})`).join('<br>');
        resultsEl.innerHTML += `<div style="padding:10px;background:rgba(243,156,18,0.12);border:1px solid #f39c12;border-radius:6px;font-size:11px;">
            ⚠️ <strong>Missing dependencies:</strong><br>${missingRows}
        </div>`;
    }

    const ordered = [...res.entries].sort((a, b) => {
        const rank = { error: 0, warn: 1, ok: 2 };
        return (rank[a.status] ?? 3) - (rank[b.status] ?? 3);
    });

    for (const entry of ordered) {
        const row = document.createElement('div');
        row.style.cssText = `display: flex; flex-direction: column; gap: 4px; background: var(--bg-main); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; font-size: 11px;`;

        const color = entry.status === 'error' ? '#e74c3c' : entry.status === 'warn' ? '#f39c12' : '#2ecc71';
        const title = document.createElement('div');
        title.innerHTML = `<strong style="color:${color};">${entry.status === 'error' ? '❌' : entry.status === 'warn' ? '⚠️' : '✅'} ${escapeHtml(entry.file)}</strong>
            <span style="color: var(--text-muted);">${entry.modId ? escapeHtml(`${entry.name || entry.modId} ${entry.version || ''} · ${entry.loader}`) : 'no metadata'}</span>`;
        row.appendChild(title);

        if (entry.issues.length > 0) {
            const issues = document.createElement('div');
            issues.style.cssText = 'color: var(--text-muted); font-size: 10px; padding-left: 8px;';
            issues.innerHTML = entry.issues.map(i => `• ${escapeHtml(i.message)}`).join('<br>');
            row.appendChild(issues);
        }

        if (entry.suspicions && entry.suspicions.hits.length > 0) {
            const sus = document.createElement('div');
            sus.style.cssText = 'color: #f39c12; font-size: 10px; padding-left: 8px;';
            sus.innerHTML = entry.suspicions.hits.map(h => `🔍 <em>${escapeHtml(h.message)}</em>`).join('<br>');
            row.appendChild(sus);
        }

        resultsEl.appendChild(row);
    }
}

// ── Mod Time Machine UI ──────────────────────────────────────────────────────
async function openTimeMachine() {
    ipcRenderer.send('update-discord-presence', { details: `devLauncher ${APP_VERSION}`, state: 'Browsing Mod History' });
    openModal('timemachine-modal');
    await refreshTimeMachine();
}

async function refreshTimeMachine() {
    const listEl = document.getElementById('timemachine-list');
    try {
        const res = await ipcRenderer.invoke('mod-history', currentActiveInstanceId);
        if (!res.ok) {
            listEl.innerHTML = `<div style="color: var(--text-muted); font-size: 12px;">${escapeHtml(res.error || 'History unavailable')}</div>`;
            return;
        }
        document.getElementById('timemachine-store-size').innerText = `${res.storeMb} MB`;
        renderTimeMachineList(res.history);
    } catch (err) {
        listEl.innerHTML = `<div style="color: var(--text-muted); font-size: 12px;">${escapeHtml(String(err.message || err))}</div>`;
    }
}

const TM_OP_META = {
    install:  { icon: '⬇️', label: 'Installed',  color: '#2ecc71' },
    update:   { icon: '🔁', label: 'Updated',    color: '#3498db' },
    remove:   { icon: '🗑', label: 'Removed',    color: '#e74c3c' },
    enable:   { icon: '✅', label: 'Enabled',    color: '#2ecc71' },
    disable:  { icon: '⏸', label: 'Disabled',   color: '#f39c12' },
    autofix:  { icon: '🩺', label: 'Autofix',    color: '#9b59b6' }
};

function renderTimeMachineList(history) {
    const listEl = document.getElementById('timemachine-list');
    listEl.innerHTML = '';
    if (!history || history.length === 0) {
        listEl.innerHTML = '<div style="color: var(--text-muted); font-size: 12px;">No changes recorded yet for this instance. Install or toggle a mod and it will appear here.</div>';
        return;
    }
    history.forEach(entry => {
        const meta = TM_OP_META[entry.op] || { icon: '❓', label: entry.op, color: 'var(--text-muted)' };
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--bg-main);border:1px solid var(--border);border-radius:6px;';
        row.innerHTML = `
            <span>${meta.icon}</span>
            <div style="flex:1;min-width:0;">
                <div style="font-size:11px;"><strong style="color:${meta.color};">${meta.label}</strong> <span style="word-break:break-all;">${escapeHtml(entry.target)}</span>
                ${entry.txnId ? '<span style="color:var(--text-muted);"> · txn</span>' : ''}${entry.note ? ` <span style="color:var(--text-muted);font-size:10px;">(${escapeHtml(entry.note)})</span>` : ''}
                </div>
                <div style="font-size:10px;color:var(--text-muted);">${new Date(entry.ts).toLocaleString()}</div>
            </div>
        `;
        const undoBtn = document.createElement('button');
        undoBtn.className = 'btn-secondary';
        undoBtn.style.cssText = 'padding:4px 10px;font-size:10px;flex-shrink:0;';
        undoBtn.innerText = '↩ Undo';
        undoBtn.addEventListener('click', async () => {
            if (!confirm(`Undo "${meta.label}" for ${entry.target}?`)) return;
            undoBtn.disabled = true;
            undoBtn.innerText = '…';
            const res = await ipcRenderer.invoke('mod-rollback', { instanceId: currentActiveInstanceId, entryId: entry.id });
            undoBtn.disabled = false;
            undoBtn.innerText = '↩ Undo';
            if (res && res.success) {
                await refreshTimeMachine();
                ipcRenderer.send('get-installed-mods', currentActiveInstanceId);
            } else {
                alert((res && res.error) || 'Rollback failed');
            }
        });
        row.appendChild(undoBtn);
        listEl.appendChild(row);
    });
}

function closeAllModals() {
    document.getElementById('modal-overlay').style.display = 'none';
    document.querySelectorAll('.modal').forEach(m => m.style.display = 'none');
    currentOpenModalId = null;
    ipcRenderer.send('update-discord-presence', { details: `devLauncher ${APP_VERSION}`, state: 'In Launcher Menu' });
}

// ── Central modal system ─────────────────────────────────────────────────────
// Every modal in the app opens through openModal(). Hiding all modals first
// makes re-opening the same (or another) modal always succeed - the historical
// "menu opens once, never again" bug came from ad-hoc open paths leaving
// stale state behind.
let currentOpenModalId = null;

function openModal(id) {
    if (!id) return null;
    const el = document.getElementById(id);
    if (!el || !el.classList.contains('modal')) {
        console.error(`[UI] openModal: unknown modal id "${id}"`);
        return null;
    }
    document.querySelectorAll('.modal').forEach(m => { m.style.display = 'none'; });
    document.getElementById('modal-overlay').style.display = 'block';
    el.style.display = 'block';
    currentOpenModalId = id;
    return el;
}

// true when the requested modal is currently on screen (for guards in async flows)
function isModalOpen(id) {
    return currentOpenModalId === id;
}

// IPC Receivers
ipcRenderer.on('config-data', (event, config) => {
    currentConfig = config;
    currentActiveInstanceId = (config.selectedInstanceId && config.selectedInstanceId !== 'default') ? config.selectedInstanceId : null;
    
    document.getElementById('offline-username-input').value = config.username || 'Player';
    if (config.uiFont) applyUiFont(config.uiFont);
    document.getElementById('prefetch-cap').value = config.assetByteCapMB != null ? config.assetByteCapMB : 400;
    document.getElementById('min-ram').value = config.minRam || '2G';
    document.getElementById('max-ram').value = config.maxRam || '4G';
    document.getElementById('java-path').value = config.javaPath || '';
    document.getElementById('gc-mode-select').value = config.gcMode || 'g1gc';
    document.getElementById('proxy-mode-select').value = config.proxyMode || 'system';
    document.getElementById('proxy-url-input').value = config.proxyUrl || '';
    document.getElementById('proxy-user-input').value = config.proxyUser || '';
    document.getElementById('proxy-pass-input').value = config.proxyPass || '';
    document.getElementById('custom-jvm-args').value = config.customJvmArgs || '';
    document.getElementById('discord-client-id').value = config.discordClientId || '';

    if (config.customSkinPath) {
        document.getElementById('skin-path-display').innerText = config.customSkinPath;
    }

    updateAccountButtonDisplay();
    document.getElementById('instance-path-text').innerText = currentActiveInstanceId;
    ipcRenderer.send('get-installed-mods', currentActiveInstanceId);

    // If the version list is already loaded, apply the selected version; otherwise it will be applied inside versions-list.
    applySelectedVersion();
});

ipcRenderer.on('config-saved', (event, config) => {
    currentConfig = config;
    updateAccountButtonDisplay();
});

// Instance / Modrinth / Launch error surfaces
ipcRenderer.on('instance-operation-failed', (event, message) => {
    alert(`Instance operation failed: ${message}`);
    ipcRenderer.send('list-instances');
});

ipcRenderer.on('instance-created-success', (event, created) => {
    if (created && created.id) {
        currentActiveInstanceId = created.id;
        ipcRenderer.send('save-config', { selectedInstanceId: created.id });
        document.getElementById('instance-path-text').innerText = created.id;
        document.getElementById('active-instance-name-display').innerText = created.id;
    }
});

ipcRenderer.on('modrinth-search-failed', (event, message) => {
    const container = document.getElementById('mod-results-container');
    if (container) {
        container.innerHTML = `<div style="color: var(--text-muted);">Search failed: ${escapeHtml(message)}</div>`;
    } else {
        alert(`Modrinth search failed: ${message}`);
    }
});

ipcRenderer.on('game-launch-failed', (event, message) => {
    const playBtn = document.getElementById('play-btn');
    if (playBtn) {
        playBtn.disabled = false;
        playBtn.innerText = isVersionDownloadedLocally ? 'PLAY' : 'DOWNLOAD & PLAY';
    }
    alert(`Game launch failed: ${message}`);
});

// Theme IPC
ipcRenderer.on('themes-list', (event, { themes, currentTheme, customThemeData }) => {
    const container = document.getElementById('theme-grid-container');
    container.innerHTML = '';

    applyTheme(themes[currentTheme]);

    if (customThemeData) {
        if (document.getElementById('theme-custom-accent')) document.getElementById('theme-custom-accent').value = customThemeData.accent || '#2ecc71';
        if (document.getElementById('theme-custom-bgmain')) document.getElementById('theme-custom-bgmain').value = customThemeData.bgMain || '#2b2b36';
        if (document.getElementById('theme-custom-bgdark')) document.getElementById('theme-custom-bgdark').value = customThemeData.bgDark || '#1e1e24';
        if (document.getElementById('theme-custom-bgbar')) document.getElementById('theme-custom-bgbar').value = customThemeData.bgBar || '#141419';
        if (document.getElementById('theme-custom-opacity')) {
            document.getElementById('theme-custom-opacity').value = customThemeData.opacity ?? 1.0;
            document.getElementById('opacity-val-display').innerText = `${Math.round((customThemeData.opacity ?? 1.0) * 100)}%`;
        }
        if (document.getElementById('theme-custom-font')) document.getElementById('theme-custom-font').value = customThemeData.fontFamily || 'JetBrains Mono, monospace';
    }

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

// Opacity slider live feedback
const opacitySlider = document.getElementById('theme-custom-opacity');
if (opacitySlider) {
    opacitySlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        document.getElementById('opacity-val-display').innerText = `${Math.round(val * 100)}%`;
        applyTheme({
            bgMain: document.getElementById('theme-custom-bgmain').value,
            bgDark: document.getElementById('theme-custom-bgdark').value,
            bgBar: document.getElementById('theme-custom-bgbar').value,
            accent: document.getElementById('theme-custom-accent').value,
            accentHover: document.getElementById('theme-custom-accent').value,
            text: '#ffffff',
            textMuted: '#a0a0b0',
            border: '#3a3a4a',
            fontFamily: document.getElementById('theme-custom-font').value,
            opacity: val
        });
    });
}

// Apply Custom Theme Button
const applyCustomThemeBtn = document.getElementById('apply-custom-theme-btn');
if (applyCustomThemeBtn) {
    applyCustomThemeBtn.addEventListener('click', () => {
        const customData = {
            accent: document.getElementById('theme-custom-accent').value,
            accentHover: document.getElementById('theme-custom-accent').value,
            bgMain: document.getElementById('theme-custom-bgmain').value,
            bgDark: document.getElementById('theme-custom-bgdark').value,
            bgBar: document.getElementById('theme-custom-bgbar').value,
            text: '#ffffff',
            textMuted: '#a0a0b0',
            border: '#3a3a4a',
            opacity: parseFloat(document.getElementById('theme-custom-opacity').value),
            fontFamily: document.getElementById('theme-custom-font').value
        };
        ipcRenderer.send('save-custom-theme', customData);
    });
}

// Export Theme JSON Button
const exportThemeBtn = document.getElementById('export-theme-json-btn');
if (exportThemeBtn) {
    exportThemeBtn.addEventListener('click', () => {
        const themeExport = {
            name: 'devLauncher Custom Theme',
            accent: document.getElementById('theme-custom-accent').value,
            bgMain: document.getElementById('theme-custom-bgmain').value,
            bgDark: document.getElementById('theme-custom-bgdark').value,
            bgBar: document.getElementById('theme-custom-bgbar').value,
            opacity: parseFloat(document.getElementById('theme-custom-opacity').value),
            fontFamily: document.getElementById('theme-custom-font').value
        };
        const blob = new Blob([JSON.stringify(themeExport, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'theme.devtheme';
        a.click();
        URL.revokeObjectURL(url);
    });
}

ipcRenderer.on('versions-list', (event, data) => {
    const versionSelect = document.getElementById('version');
    const newInstVersionSelect = document.getElementById('new-instance-version');

    versionSelect.innerHTML = '';
    newInstVersionSelect.innerHTML = '';

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
        if ((majorVer > 1) || (majorVer === 1 && minorVer >= 14)) {
            const option = document.createElement('option');
            option.value = `fabric-loader-${data.fabricLoader}-${v}`;
            option.innerText = `Fabric ${v}`;
            fabricOptgroup.appendChild(option);
        }
    });
    versionSelect.appendChild(fabricOptgroup);

    // Quilt Loaders
    const quiltOptgroup = document.createElement('optgroup');
    quiltOptgroup.label = "Quilt Loaders";
    data.vanilla.forEach(v => {
        const majorVer = parseInt(v.split('.')[0], 10);
        const minorVer = parseInt(v.split('.')[1], 10);
        if ((majorVer > 1) || (majorVer === 1 && minorVer >= 14)) {
            const option = document.createElement('option');
            option.value = `quilt-loader-${data.quiltLoader || '0.26.0'}-${v}`;
            option.innerText = `Quilt ${v}`;
            quiltOptgroup.appendChild(option);
        }
    });
    versionSelect.appendChild(quiltOptgroup);

    // NeoForge Loaders
    const neoforgeOptgroup = document.createElement('optgroup');
    neoforgeOptgroup.label = "NeoForge Loaders";
    data.vanilla.forEach(v => {
        if (v.startsWith('1.20') || v.startsWith('1.21') || parseInt(v.split('.')[0], 10) >= 26) {
            const option = document.createElement('option');
            option.value = `neoforge-${v}`;
            option.innerText = `NeoForge ${v}`;
            neoforgeOptgroup.appendChild(option);
        }
    });
    versionSelect.appendChild(neoforgeOptgroup);

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

    // OptiFine Standard HD
    const optifineOptgroup = document.createElement('optgroup');
    optifineOptgroup.label = "OptiFine HD Ultra";
    data.vanilla.slice(0, 15).forEach(v => {
        const option = document.createElement('option');
        option.value = `optifine-${v}`;
        option.innerText = `OptiFine HD ${v}`;
        optifineOptgroup.appendChild(option);
    });
    versionSelect.appendChild(optifineOptgroup);

    // OptiFine + Forge Hybrid
    const optifineForgeOptgroup = document.createElement('optgroup');
    optifineForgeOptgroup.label = "OptiFine + Forge Hybrid";
    data.vanilla.slice(0, 15).forEach(v => {
        const option = document.createElement('option');
        option.value = `optifine-forge-${v}`;
        option.innerText = `OptiFine + Forge ${v}`;
        optifineForgeOptgroup.appendChild(option);
    });
    versionSelect.appendChild(optifineForgeOptgroup);

    // If a version is selected, apply it and re-check the installed state.
    applySelectedVersion();
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
        option.innerText = `${runtime.name} (Java ${runtime.version}) -> ${runtime.path}`;
        javaSelect.appendChild(option);
    });

    if (currentConfig.javaPath) {
        javaSelect.value = currentConfig.javaPath;
    }
});

function autoInstallJava(versionMajor) {
    alert(`Downloading OpenJDK ${versionMajor}... This may take a moment.`);
    ipcRenderer.send('auto-install-java', versionMajor);
}

ipcRenderer.on('java-installed-success', (event, { javaPath, runtimes }) => {
    document.getElementById('java-path').value = javaPath;
    saveSettingsForm();
    ipcRenderer.send('detect-java-runtimes');
    alert(`Successfully installed and selected OpenJDK! Path: ${javaPath}`);
});

ipcRenderer.on('java-installed-failed', (event, errorMsg) => {
    alert(`Failed to auto-install Java: ${errorMsg}`);
});

ipcRenderer.on('microsoft-login-success', (event, authData) => {
    const msBtn = document.getElementById('ms-login-btn');
    msBtn.innerText = `Logged in as ${authData.name}`;
    msBtn.style.backgroundColor = "#2ecc71";
    updateAccountButtonDisplay();
    refreshAccountsList();
    loadProfileSkin();
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
        card.style.display = 'flex';
        card.style.gap = '12px';
        card.style.alignItems = 'flex-start';

        const safeTitle = escapeHtml(mod.title);
        const safeDesc = escapeHtml(mod.description || 'No description available.');
        const safeIconUrl = /^[a-z]+:\/\//i.test(String(mod.icon_url || ''))
            ? escapeHtml(mod.icon_url)
            : '';

        const iconHtml = safeIconUrl
            ? `<img src="${safeIconUrl}" style="width: 48px; height: 48px; border-radius: 6px; object-fit: cover;" alt="${safeTitle}" />`
            : `<div style="width: 48px; height: 48px; border-radius: 6px; background: var(--bg-dark); display: flex; align-items: center; justify-content: center; font-size: 20px;">🧩</div>`;

        const loadersList = (mod.categories || []).slice(0, 4).map(c => escapeHtml(c)).join(', ');
        const versionsList = (mod.versions || []).slice(-3).map(v => escapeHtml(v)).join(', ');

        const projectId = escapeHtml(mod.project_id);

        const info = document.createElement('div');
        info.className = 'mod-info';
        info.style.flex = '1';
        info.innerHTML = `
            <div style="display: flex; gap: 10px; align-items: center;">
                ${iconHtml}
                <div>
                    <h4 style="margin: 0; font-size: 14px;">${safeTitle}</h4>
                    <div style="font-size: 10px; color: var(--accent); margin-top: 2px;">
                        ${loadersList ? `⚙️ Loaders: <strong>${loadersList}</strong>` : ''}
                        ${versionsList ? ` | 🎮 Versions: ${versionsList}` : ''}
                    </div>
                </div>
            </div>
            <p style="margin-top: 8px; font-size: 12px; color: var(--text-muted);">${safeDesc}</p>
        `;

        const installBtn = document.createElement('button');
        installBtn.className = 'btn-secondary';
        installBtn.id = `mod-btn-${projectId}`;
        installBtn.innerText = `Install ${activeModrinthCategory}`;
        installBtn.style.alignSelf = 'center';
        installBtn.addEventListener('click', () => {
            if (activeModrinthCategory === 'shader') {
                const wantsIris = confirm(`💡 Smart Shader Helper:\nRunning the "${safeTitle}" shader pack requires the 'Iris' mod on Fabric/Quilt, or 'Oculus' on Forge/NeoForge.\n\nContinue with the download?`);
                if (!wantsIris) return;
            }
            installBtn.innerText = 'Installing...';
            installBtn.disabled = true;
            ipcRenderer.send('download-modrinth-mod', {
                projectId: mod.project_id,
                version: document.getElementById('version').value,
                loader: getActiveLoader() || 'fabric',
                instanceId: currentActiveInstanceId
            });
        });

        card.appendChild(info);
        card.appendChild(installBtn);
        container.appendChild(card);
    });
});

ipcRenderer.on('modrinth-download-success', (event, res) => {
    const btn = document.getElementById(`mod-btn-${escapeHtml(res.projectId)}`);
    if (btn) {
        btn.innerText = 'Installed ✓';
        btn.style.borderColor = 'var(--accent)';
        btn.style.color = 'var(--accent)';
        btn.disabled = true;
    }
});

ipcRenderer.on('modrinth-download-failed', (event, res) => {
    const btn = document.getElementById(`mod-btn-${escapeHtml(res.projectId)}`);
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
        card.style.display = 'flex';
        card.style.flexDirection = 'column';
        card.style.position = 'relative';

        card.innerHTML = `
            <img src="file://${encodeURI(sc.path)}" alt="${escapeHtml(sc.filename)}" style="width: 100%; border-radius: 6px; aspect-ratio: 16/9; object-fit: cover; cursor: pointer;" title="Click to copy image to clipboard" />
            <div style="font-size: 11px; color: var(--text-muted); margin-top: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(sc.filename)}</div>
            <div style="display: flex; gap: 6px; margin-top: 6px;">
                <button class="btn-secondary copy-sc-btn" style="flex: 1; font-size: 10px; padding: 4px 6px;">📋 Copy Image</button>
            </div>
        `;

        const copyBtn = card.querySelector('.copy-sc-btn');
        const img = card.querySelector('img');

        const doCopy = () => {
            ipcRenderer.send('copy-screenshot-clipboard', sc.path);
            copyBtn.innerText = 'Copied ✓';
            setTimeout(() => copyBtn.innerText = '📋 Copy Image', 2000);
        };

        copyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            doCopy();
        });
        img.addEventListener('click', doCopy);

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
    instanceManagerList = Array.isArray(instances) ? instances : [];
    const container = document.getElementById('instances-container');
    container.innerHTML = '';

    // v2 parameter: zero instances = guided empty state, launch blocked.
    if (!instanceManagerList.length) {
        if (currentActiveInstanceId) {
            currentActiveInstanceId = null;
            ipcRenderer.send('save-config', { selectedInstanceId: null });
        }
        const empty = document.createElement('div');
        empty.className = 'instance-item-card';
        empty.style.flexDirection = 'column';
        empty.style.textAlign = 'center';
        empty.innerHTML = `
            <div style="padding: 8px;">
                <strong style="color: var(--text);">No instances yet</strong>
                <p style="font-size: 12px; color: var(--text-muted); margin: 8px 0 12px 0;">
                    An instance holds its own mods, config, saves and settings. Create your first one to start playing — there is no hidden "default" instance anymore.
                </p>
                <button class="btn-primary" onclick="openCreateInstanceModal()">+ Create Your First Instance</button>
            </div>`;
        container.appendChild(empty);
        return;
    }

    if (!instanceManagerList.some(i => i.id === currentActiveInstanceId)) {
        // Selection points at a deleted/renamed instance → adopt the first one.
        currentActiveInstanceId = instanceManagerList[0].id;
        ipcRenderer.send('save-config', { selectedInstanceId: currentActiveInstanceId });
    }
    instanceManagerList.forEach(inst => {
        const item = document.createElement('div');
        item.className = 'instance-item-card';
        if (inst.id === currentActiveInstanceId) {
            item.style.borderColor = 'var(--accent)';
        }

        item.innerHTML = `
            <div style="min-width: 0; word-break: break-word;">
                <strong style="color: var(--text);">${escapeHtml(inst.name)}</strong>
                <div style="font-size: 11px; color: var(--text-muted);">Version: ${escapeHtml(inst.version)} (${escapeHtml(inst.loaderType)})</div>
                <div style="font-size: 10px; color: var(--accent); margin-top: 2px;">⏱ Played: ${inst.playtimeHours ? inst.playtimeHours + ' h' : '0 h'}</div>
            </div>
            <div style="display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end;">
                <button class="btn-secondary select-instance-btn">${inst.id === currentActiveInstanceId ? 'Active' : 'Select'}</button>
                <button class="btn-secondary rename-instance-btn" style="padding: 6px 10px; margin-top: 0; font-size: 11px;">Rename</button>
                <button class="btn-secondary duplicate-instance-btn" style="padding: 6px 10px; margin-top: 0; font-size: 11px;">Clone</button>
                <button class="close-btn delete-instance-btn" style="padding: 6px 10px; margin-top: 0; font-size: 11px;">Delete</button>
            </div>
        `;

        const selectBtn = item.querySelector('.select-instance-btn');
        if (selectBtn) {
            selectBtn.addEventListener('click', () => selectInstance(inst.id));
        }
        const deleteBtn = item.querySelector('.delete-instance-btn');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', () => deleteInstance(inst.id));
        }

        const renameBtn = item.querySelector('.rename-instance-btn');
        if (renameBtn) {
            renameBtn.addEventListener('click', () => {
                const input = document.getElementById('rename-input');
                if (input && openModal('rename-modal')) {
                    renameTargetId = inst.id;
                    input.value = inst.name;
                    ipcRenderer.send('update-discord-presence', { details: `devLauncher ${APP_VERSION}`, state: 'Renaming Instance' });
                }
            });
        }

        const duplicateBtn = item.querySelector('.duplicate-instance-btn');
        if (duplicateBtn) {
            duplicateBtn.addEventListener('click', () => ipcRenderer.send('duplicate-instance', { instanceId: inst.id }));
        }

        container.appendChild(item);
    });
});

function selectInstance(instanceId) {
    currentActiveInstanceId = instanceId;
    ipcRenderer.send('save-config', { selectedInstanceId: instanceId });
    document.getElementById('instance-path-text').innerText = instanceId;
    document.getElementById('active-instance-name-display').innerText = instanceId;
    ipcRenderer.send('list-instances');
    ipcRenderer.send('get-installed-mods', instanceId);
}

function deleteInstance(instanceId) {
    if (confirm(`Delete instance ${instanceId}?`)) {
        ipcRenderer.send('delete-instance', instanceId);
    }
}

// Installed Mods Management IPC Handlers
ipcRenderer.on('installed-mods-list', (event, mods) => {
    const container = document.getElementById('installed-mods-container');
    const nameDisplay = document.getElementById('active-instance-name-display');
    if (nameDisplay) nameDisplay.innerText = currentActiveInstanceId;
    container.innerHTML = '';

    if (!mods || mods.length === 0) {
        container.innerHTML = '<div style="color: var(--text-muted); font-size: 13px;">No mods installed in this instance yet. Use Mod Manager tab to download mods.</div>';
        return;
    }

    mods.forEach(mod => {
        const item = document.createElement('div');
        item.style.display = 'flex';
        item.style.justifyContent = 'space-between';
        item.style.alignItems = 'center';
        item.style.padding = '8px 12px';
        item.style.background = 'var(--bg-main)';
        item.style.border = '1px solid var(--border)';
        item.style.borderRadius = '6px';
        item.style.opacity = mod.enabled ? '1' : '0.5';

        item.innerHTML = `
            <div style="display: flex; align-items: center; gap: 8px;">
                <span style="font-size: 14px;">${mod.enabled ? '🟢' : '⚪'}</span>
                <div>
                    <strong style="font-size: 12px; color: var(--text);">${escapeHtml(mod.name)}</strong>
                    <div style="font-size: 10px; color: var(--text-muted);">${escapeHtml(mod.filename)}</div>
                </div>
            </div>
            <div style="display: flex; gap: 6px;">
                <button class="btn-secondary toggle-mod-btn" style="padding: 4px 8px; font-size: 11px;">
                    ${mod.enabled ? 'Disable' : 'Enable'}
                </button>
                <button class="close-btn remove-mod-btn" style="padding: 4px 8px; margin-top: 0; font-size: 11px;">
                    Delete
                </button>
            </div>
        `;

        item.querySelector('.toggle-mod-btn').addEventListener('click', () => toggleMod(mod.filename));
        item.querySelector('.remove-mod-btn').addEventListener('click', () => removeMod(mod.filename));

        container.appendChild(item);
    });
});

function toggleMod(filename) {
    ipcRenderer.send('toggle-mod', { instanceId: currentActiveInstanceId, filename });
}

function removeMod(filename) {
    if (confirm(`Remove mod ${filename}?`)) {
        ipcRenderer.send('delete-mod', { instanceId: currentActiveInstanceId, filename });
    }
}

// Rename modal wiring: one hidden state for the card that opened it
let renameTargetId = null;
document.getElementById('rename-save-btn') && document.getElementById('rename-save-btn').addEventListener('click', () => {
    if (renameTargetId) {
        ipcRenderer.send('rename-instance', { instanceId: renameTargetId, newName: document.getElementById('rename-input').value.trim() });
        renameTargetId = null;
    }
    closeAllModals();
});

// Game Launching logic & Button behavior fix
let launchPhaseLabel = 'LOADING'; // Captured at launch time, used by progress handler

function handleLaunch() {
    // v2: no implicit default instance - launch requires an explicit active one.
    if (!currentActiveInstanceId) {
        alert('No instance selected. Create an instance first (Instances tab) — every instance keeps its own mods, saves and settings.');
        openCreateInstanceModal();
        return;
    }
    const playBtn = document.getElementById('play-btn');
    playBtn.disabled = true;

    launchPhaseLabel = isVersionDownloadedLocally ? 'LOADING' : 'DOWNLOADING';
    playBtn.innerText = `${launchPhaseLabel}... 0%`;

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
    if (!playBtn || !data || typeof data !== 'object') return;

    const baseText = isVersionDownloadedLocally ? 'LOADING' : 'DOWNLOADING';
    const total = Number.isFinite(data.total) ? data.total : 0;
    const task = Number.isFinite(data.task) ? data.task : (Number.isFinite(data.current) ? data.current : null);
    const hasPercent = total > 0 && task !== null;

    if (hasPercent) {
        const percent = Math.min(Math.max(0, Math.round((task / total) * 100)), 100);
        playBtn.innerText = `${baseText}... ${percent}%`;
    } else {
        playBtn.innerText = `${baseText}... 0%`;
    }
});

ipcRenderer.on('game-launched', () => {
    const playBtn = document.getElementById('play-btn');
    isVersionDownloadedLocally = true;
    playBtn.innerText = "PLAYING";
});

ipcRenderer.on('game-closed', () => {
    const playBtn = document.getElementById('play-btn');
    playBtn.innerText = isVersionDownloadedLocally ? "PLAY" : "DOWNLOAD & PLAY";
    playBtn.disabled = false;
});

// P2P IPC Responses
ipcRenderer.on('p2p-host-success', (event, roomInfo) => {
    document.getElementById('p2p-start-btn').innerText = '🚀 Share World Online';
    document.getElementById('p2p-start-btn').disabled = false;
    document.getElementById('p2p-start-btn').style.display = 'none';
    document.getElementById('p2p-stop-btn').style.display = 'block';
    document.getElementById('p2p-status-box').style.display = 'block';
    document.getElementById('p2p-connect-address').value = roomInfo.connectAddress;
    drawConnectQR(roomInfo.connectAddress);
    ipcRenderer.send('get-lan-info');
});

ipcRenderer.on('lan-info', (event, info) => {
    const listEl = document.getElementById('p2p-lan-list');
    if (!listEl) return;
    const port = info.port || 25565;
    const reachHost = document.getElementById('p2p-reach-host');
    const reachPort = document.getElementById('p2p-reach-port');
    if (reachPort && !reachPort.value) reachPort.value = port;
    if (!info.ok || !info.ips || info.ips.length === 0) {
        listEl.innerText = 'No LAN interface found';
        return;
    }
    listEl.innerHTML = info.ips.map(ip =>
        `<span style="color:var(--text-muted);">${escapeHtml(ip)}:${port}</span> ` +
        `<button class="btn-secondary" data-lanip="${escapeHtml(ip)}:${port}" ` +
        `style="padding:1px 6px; font-size:10px; margin:0 4px 2px 0;">copy</button>`
    ).join('<br>');
});

// Event delegation: chips are re-rendered whenever hosting starts.
const lanListEl = document.getElementById('p2p-lan-list');
if (lanListEl) lanListEl.addEventListener('click', (e) => {
    const target = e.target.closest('button[data-lanip]');
    if (!target) return;
    navigator.clipboard.writeText(target.getAttribute('data-lanip')).then(() => {
        const original = target.innerText;
        target.innerText = 'copied!';
        setTimeout(() => { target.innerText = original; }, 1500);
    });
});

const reachBtnEl = document.getElementById('p2p-reach-test-btn');
if (reachBtnEl) reachBtnEl.addEventListener('click', async () => {
    const host = document.getElementById('p2p-reach-host').value.trim();
    const port = parseInt(document.getElementById('p2p-reach-port').value, 10) || 25565;
    const resultEl = document.getElementById('p2p-reach-result');
    if (!host) { resultEl.innerText = 'Enter the host PC IP first.'; return; }
    resultEl.innerText = 'Testing...';
    try {
        const res = await ipcRenderer.invoke('lan-peer-test', { host, port });
        if (res.ok) {
            resultEl.innerText = `✅ Reachable in ${res.ms} ms — open Minecraft on this PC and Direct Connect to ${host}:${port}.`;
        } else if (res.error === 'timeout') {
            resultEl.innerText = `❌ Timeout: ${host} did not answer. Wrong IP, other PC asleep, or AP/client isolation is taking effect on this Wi-Fi.`;
        } else {
            resultEl.innerText = `❌ ${res.error} — ${host}:${port}. Wait for the host to "Open to LAN", then retest.`;
        }
    } catch (_) {
        resultEl.innerText = '❌ Test failed (internal error).';
    }
});

ipcRenderer.on('p2p-host-failed', (event, errorMsg) => {
    document.getElementById('p2p-start-btn').innerText = '🚀 Share World Online';
    document.getElementById('p2p-start-btn').disabled = false;
    alert(`Failed to share world P2P: ${errorMsg}`);
});

ipcRenderer.on('p2p-stop-success', () => {
    document.getElementById('p2p-start-btn').style.display = 'block';
    document.getElementById('p2p-stop-btn').style.display = 'none';
    document.getElementById('p2p-status-box').style.display = 'none';
    document.getElementById('p2p-connect-address').value = '';
});

// Tunnel can die on its own (server-side close / network drop) — reflect that in the UI.
function resetP2PStatusBox() {
    const startBtn = document.getElementById('p2p-start-btn');
    if (startBtn) {
        startBtn.style.display = 'block';
        startBtn.innerText = '🚀 Share World Online';
        startBtn.disabled = false;
    }
    const stopBtn = document.getElementById('p2p-stop-btn');
    if (stopBtn) stopBtn.style.display = 'none';
    const statusBox = document.getElementById('p2p-status-box');
    if (statusBox) statusBox.style.display = 'none';
    const address = document.getElementById('p2p-connect-address');
    if (address) address.value = '';
}

ipcRenderer.on('p2p-status-update', (event, roomInfo) => {
    if (roomInfo && roomInfo.connectAddress) {
        document.getElementById('p2p-start-btn').style.display = 'none';
        document.getElementById('p2p-stop-btn').style.display = 'block';
        document.getElementById('p2p-status-box').style.display = 'block';
        document.getElementById('p2p-connect-address').value = roomInfo.connectAddress;
    } else {
        resetP2PStatusBox();
    }
});

ipcRenderer.on('p2p-host-stopped', resetP2PStatusBox);
ipcRenderer.on('p2p-tunnel-error', (event, message) => {
    resetP2PStatusBox();
    alert(`P2P tunnel error: ${message}`);
});

// ── Self-Update UI ───────────────────────────────────────────────────────────
ipcRenderer.on('update-status', (event, payload) => {
    const readyBadge = document.getElementById('update-badge');
    const readyText = document.getElementById('update-badge-text');
    const progressBadge = document.getElementById('update-progress-badge');
    const progressText = document.getElementById('update-progress-text');
    if (!readyBadge || !progressBadge) return;

    switch (payload.status) {
        case 'checking':
            progressBadge.style.display = 'block';
            progressText.innerText = '⏳ Checking for updates...';
            readyBadge.style.display = 'none';
            break;
        case 'downloading':
            progressBadge.style.display = 'block';
            progressText.innerText = payload.percent != null
                ? `⬇️ v${payload.version} — ${payload.percent}% (${payload.mbps} MB/s)`
                : `⬇️ Downloading v${payload.version}...`;
            readyBadge.style.display = 'none';
            break;
        case 'ready':
            progressBadge.style.display = 'none';
            readyBadge.style.display = 'block';
            readyText.innerText = `⬆️ Install v${payload.version} & Restart`;
            break;
        case 'up-to-date':
        case 'error':
        case 'dev-disabled':
        default:
            progressBadge.style.display = 'none';
            readyBadge.style.display = 'none';
            break;
    }
});

// prefetch status chip (zero-cold-start)
ipcRenderer.on('prefetch-status', (event, status) => {
    const chip = document.getElementById('prefetch-chip');
    const text = document.getElementById('prefetch-text');
    if (!chip || !status) return;
    if (status.running) {
        chip.style.display = 'block';
        const done = (status.done || 0);
        const total = status.total;
        text.innerText = total ? `Prefetch ${done}/${total}` : 'Prefetch starting…';
    } else {
        const hasData = status.downloaded > 0 || status.skipped > 0 || status.failed > 0 || status.note;
        if (hasData) {
            chip.style.display = 'block';
            const note = status.note ? ` — ${escapeHtml(String(status.note))}` : '';
            text.innerText = `Prefetch done: ⬇${status.downloaded || 0} ↷${status.skipped || 0}${status.failed ? ` ⚠${status.failed}` : ''}${note}`;
            // auto-hide a few seconds after finishing
            clearTimeout(window.__prefetchHideTimer);
            window.__prefetchHideTimer = setTimeout(() => { chip.style.display = 'none'; }, 8000);
        } else {
            chip.style.display = 'none';
        }
    }
});

document.getElementById('update-badge').addEventListener('click', () => {
    ipcRenderer.send('install-update');
});

// ── Worlds & Save Explorer ─────────────────────────────────────────────
const refreshWorldsBtn = document.getElementById('refresh-worlds-btn');
if (refreshWorldsBtn) {
    refreshWorldsBtn.addEventListener('click', () => {
        ipcRenderer.send('get-worlds', currentActiveInstanceId);
    });
}

ipcRenderer.on('worlds-list', (event, worlds) => {
    const container = document.getElementById('worlds-container');
    if (!container) return;
    container.innerHTML = '';

    if (!worlds || worlds.length === 0) {
        container.innerHTML = '<div style="color: var(--text-muted); font-size: 13px;">No worlds found in this instance. Launch the game and create a world!</div>';
        return;
    }

    worlds.forEach(w => {
        const card = document.createElement('div');
        card.style.background = 'var(--bg-dark)';
        card.style.border = '1px solid var(--border)';
        card.style.borderRadius = '8px';
        card.style.padding = '12px';
        card.style.display = 'flex';
        card.style.flexDirection = 'column';
        card.style.gap = '8px';

        const lastPlayedStr = w.lastPlayed ? new Date(w.lastPlayed).toLocaleString() : 'Never';
        const iconSrc = w.iconData || 'assets/icons/icon.png';

        card.innerHTML = `
            <div style="display: flex; gap: 10px; align-items: center;">
                <img src="${iconSrc}" style="width: 48px; height: 48px; border-radius: 6px; object-fit: cover; background: #000;" alt="World Icon">
                <div style="flex: 1; overflow: hidden;">
                    <div style="font-weight: bold; font-size: 14px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(w.displayName)}</div>
                    <div style="font-size: 10px; color: var(--text-muted);">Folder: ${escapeHtml(w.folderName)}${w.stats && w.stats.version ? ` · ${escapeHtml(String(w.stats.version))}` : ''}</div>
                    <div style="font-size: 10px; color: var(--accent); margin-top: 2px;">Last Played: ${lastPlayedStr}</div>
                </div>
            </div>
            <div style="display: flex; gap: 6px; margin-top: 4px;">
                <button class="btn-secondary backup-w-btn" style="flex: 1; font-size: 11px; padding: 6px;">📦 Backup (.zip)</button>
                <button class="btn-secondary preview-w-btn" style="flex: 1; font-size: 11px; padding: 6px;">🗺 Preview</button>
            </div>
        `;

        card.querySelector('.backup-w-btn').addEventListener('click', () => {
            ipcRenderer.send('backup-world', { instanceId: currentActiveInstanceId, worldFolder: w.folderName });
        });

        card.querySelector('.preview-w-btn').addEventListener('click', () => {
            openModal('worldpreview-modal');
            document.getElementById('worldpreview-title').innerText = `🗺 ${w.displayName || w.folderName}`;
            document.getElementById('worldpreview-stats').innerText = 'Reading region data...';
            ipcRenderer.send('world-preview-show', { instanceId: currentActiveInstanceId, worldFolder: w.folderName });
        });

        container.appendChild(card);
    });
});

ipcRenderer.on('backup-world-success', (event, path) => {
    alert(`World backup created successfully:\n${path}`);
});

ipcRenderer.on('backup-world-failed', (event, err) => {
    alert(`Failed to backup world: ${err}`);
});

// ── Smart Storage & Garbage Cleaner ─────────────────────────────────────
const scanGarbageBtn = document.getElementById('scan-garbage-btn');
const cleanGarbageBtn = document.getElementById('clean-garbage-btn');
const garbageMbDisplay = document.getElementById('garbage-mb-display');
const cleanerStatusBadge = document.getElementById('cleaner-status-badge');

if (scanGarbageBtn) {
    scanGarbageBtn.addEventListener('click', () => {
        scanGarbageBtn.innerText = 'Scanning...';
        scanGarbageBtn.disabled = true;
        ipcRenderer.send('scan-garbage');
    });
}

if (cleanGarbageBtn) {
    cleanGarbageBtn.addEventListener('click', () => {
        cleanGarbageBtn.innerText = 'Cleaning...';
        cleanGarbageBtn.disabled = true;
        ipcRenderer.send('clean-garbage');
    });
}

ipcRenderer.on('garbage-scan-result', (event, report) => {
    if (scanGarbageBtn) {
        scanGarbageBtn.innerText = '🔍 Re-Scan';
        scanGarbageBtn.disabled = false;
    }
    if (cleanerStatusBadge) {
        cleanerStatusBadge.innerText = `${report.filesCount} junk files (${report.totalMB} MB)`;
        cleanerStatusBadge.style.color = parseFloat(report.totalMB) > 0 ? '#ffb86c' : 'var(--text-muted)';
    }
    if (cleanGarbageBtn && garbageMbDisplay) {
        garbageMbDisplay.innerText = `${report.totalMB} MB`;
        cleanGarbageBtn.style.display = parseFloat(report.totalMB) > 0 ? 'block' : 'none';
        cleanGarbageBtn.disabled = false;
        cleanGarbageBtn.innerText = `🚀 Clean Now (${report.totalMB} MB)`;
    }
});

ipcRenderer.on('garbage-clean-result', (event, res) => {
    if (cleanGarbageBtn) {
        cleanGarbageBtn.style.display = 'none';
    }
    if (cleanerStatusBadge) {
        cleanerStatusBadge.innerText = `Cleaned ${res.deletedMB} MB (${res.deletedCount} files)!`;
        cleanerStatusBadge.style.color = 'var(--accent)';
    }
    alert(`Cleanup finished! ${res.deletedMB} MB of junk files were deleted.`);
});

// ── Deterministik Crash & Log Analizcisi ─────────────────────────────────
let currentCrashDiagnosis = null;

// Manual "Analyze Last Crash" button result → reuse crash modal UI
function autofixLabel(type, target) {
    switch (type) {
        case 'disable_mod': return `⚡ Disable "${target}" Mod`;
        case 'open_mods_folder': return '📂 Open Mods Folder';
        case 'increase_ram': return `⚡ Set RAM to ${target}`;
        case 'install_mod': return `⚙ Install "${target}" (missing dependency)`;
        case 'search_modrinth': return '🔎 Find missing mod on Modrinth';
        default: return '';
    }
}

ipcRenderer.on('crash-analysis-result', (event, res) => {
    const analyzeBtn = document.getElementById('analyze-crash-btn');
    if (analyzeBtn) {
        analyzeBtn.innerText = '🔍 Analyze Last Crash';
        analyzeBtn.disabled = false;
    }

    if (!res.found) {
        alert(res.error ? `Crash analysis failed: ${res.error}` : 'No crash report or log file found for this instance.');
        return;
    }

    // Forward to the same modal rendering flow used by automatic crash-detected
    currentCrashDiagnosis = res.diagnosis;
    const crashTitle = document.getElementById('crash-title');
    const crashCause = document.getElementById('crash-cause');
    const crashSolution = document.getElementById('crash-solution');
    const crashSnippet = document.getElementById('crash-matched-snippet');
    const autoFixBtn = document.getElementById('crash-autofix-btn');

    if (crashTitle) crashTitle.innerText = `${res.diagnosis.name}`;
    if (crashCause) crashCause.innerText = res.diagnosis.cause;
    if (crashSolution) crashSolution.innerText = res.diagnosis.solution;

    if (crashSnippet && res.diagnosis.matchedSnippet) {
        crashSnippet.style.display = 'block';
        crashSnippet.innerText = res.diagnosis.matchedSnippet;
    } else if (crashSnippet) {
        crashSnippet.style.display = 'none';
    }

    if (autoFixBtn) {
        const af = res.diagnosis ? res.diagnosis.autoFix : null;
        const label = af ? autofixLabel(af.type, af.target) : '';
        autoFixBtn.style.display = label ? 'block' : 'none';
        if (label) autoFixBtn.innerText = label;
    }

    openModal('crash-modal');
});

ipcRenderer.on('crash-detected', (event, { diagnosis, exitCode, error }) => {
    if (!diagnosis) return;
    currentCrashDiagnosis = diagnosis;

    const crashTitle = document.getElementById('crash-title');
    const crashCause = document.getElementById('crash-cause');
    const crashSolution = document.getElementById('crash-solution');
    const crashSnippet = document.getElementById('crash-matched-snippet');
    const autoFixBtn = document.getElementById('crash-autofix-btn');

    if (crashTitle) crashTitle.innerText = `${diagnosis.name}`;
    if (crashCause) crashCause.innerText = diagnosis.cause;
    if (crashSolution) crashSolution.innerText = diagnosis.solution;

    if (crashSnippet && diagnosis.matchedSnippet) {
        crashSnippet.style.display = 'block';
        crashSnippet.innerText = diagnosis.matchedSnippet;
    } else if (crashSnippet) {
        crashSnippet.style.display = 'none';
    }

    if (autoFixBtn) {
        const af = diagnosis ? diagnosis.autoFix : null;
        const label = af ? autofixLabel(af.type, af.target) : '';
        autoFixBtn.style.display = label ? 'block' : 'none';
        if (label) autoFixBtn.innerText = label;
    }

    openModal('crash-modal');
});

const autoFixBtn = document.getElementById('crash-autofix-btn');
if (autoFixBtn) {
    autoFixBtn.addEventListener('click', () => {
        if (!currentCrashDiagnosis || !currentCrashDiagnosis.autoFix) return;
        autoFixBtn.disabled = true;
        ipcRenderer.send('autofix-crash', {
            instanceId: currentActiveInstanceId,
            autoFix: currentCrashDiagnosis.autoFix,
            searchTerm: currentCrashDiagnosis.capturedGroup || ''
        });
    });
}

ipcRenderer.on('autofix-result', (event, res) => {
    const afBtn = document.getElementById('crash-autofix-btn');
    if (afBtn) afBtn.disabled = false;
    alert(res.message);
    if (res.success) {
        closeAllModals();
        ipcRenderer.send('get-installed-mods', currentActiveInstanceId);
    }
});

// ── Instance Snapshots (v2) UI ──────────────────────────────────────────────────────────────

async function openSnapshots() {
    openModal('snapshot-modal');
    document.getElementById('snapshot-list').innerHTML = '<div style="color: var(--text-muted); font-size: 12px;">Loading snapshots...</div>';
    ipcRenderer.send('snapshot-list', currentActiveInstanceId);
}

ipcRenderer.on('snapshot-list-result', (event, res) => {
    const listEl = document.getElementById('snapshot-list');
    if (!listEl) return;
    if (!res.ok) {
        listEl.innerHTML = `<div style="color: var(--text-muted); font-size: 12px;">${escapeHtml(res.error || 'Snapshots unavailable')}</div>`;
        return;
    }
    if (!res.snapshots.length) {
        listEl.innerHTML = '<div style="color: var(--text-muted); font-size: 12px;">No snapshots for this instance yet.</div>';
        return;
    }
    listEl.innerHTML = '';
    for (const snap of res.snapshots) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; align-items:center; justify-content:space-between; background: var(--bg-main); border:1px solid var(--border); border-radius:6px; padding:8px 10px; gap:8px;';
        const dt = new Date(snap.createdAt);
        row.innerHTML = `
            <div style="min-width:0;">
                <strong style="font-size:12px; color:var(--text);">${escapeHtml(snap.label)}</strong>
                <div style="font-size:10.5px; color:var(--text-muted);">${dt.toLocaleString()} — ${snap.fileCount} files — ${snap.id}</div>
            </div>
            <div style="display:flex; gap:6px;">
                <button class="btn-secondary snapshot-restore-btn" style="padding:6px 10px; font-size:11px;">⏪ Restore</button>
                <button class="close-btn snapshot-delete-btn" style="padding:6px 10px; margin-top:0; font-size:11px;">Delete</button>
            </div>`;
        row.querySelector('.snapshot-restore-btn').addEventListener('click', () => {
            if (!confirm(`Restore "${snap.label}"? Current mods/config will be snapshotted first (reversible).`)) return;
            ipcRenderer.send('snapshot-restore', { instanceId: currentActiveInstanceId, snapshotId: snap.id });
        });
        row.querySelector('.snapshot-delete-btn').addEventListener('click', () => {
            if (!confirm('Delete this snapshot?')) return;
            ipcRenderer.send('snapshot-delete', { instanceId: currentActiveInstanceId, snapshotId: snap.id });
        });
        listEl.appendChild(row);
    }
});

ipcRenderer.on('snapshot-created', (event, res) => {
    if (!res.ok) { alert(`Snapshot failed: ${res.error}`); return; }
    alert(`Snapshot "${res.manifest.label}" saved (${res.manifest.fileCount} files).`);
    openSnapshots();
});

ipcRenderer.on('snapshot-restored', (event, res) => {
    if (!res.ok) { alert(`Restore failed: ${res.error}`); return; }
    const pre = res.preRestoreNote ? ' (nothing to guard against — pre-restore skipped)' : (res.preRestoreId ? ' — auto pre-restore snapshot saved.' : '');
    alert(`Restored ${res.restored} files, removed ${res.removed} later mods${pre}`);
    ipcRenderer.send('get-installed-mods', currentActiveInstanceId);
    openSnapshots();
});

ipcRenderer.on('snapshot-deleted', (event, res) => {
    if (!res.ok) { alert(`Delete failed: ${res.error}`); return; }
    openSnapshots();
});

// ── Integrity Sweep UI ──────────────────────────────────────────────────────

let integrityEligible = [];

async function openIntegrity() {
    openModal('integrity-modal');
    document.getElementById('integrity-results').innerHTML = '<div style="color: var(--text-muted);">Loading versions...</div>';
    const sel = document.getElementById('integrity-version-select');
    sel.innerHTML = '';
    const res = await ipcRenderer.invoke('integrity-list-versions');
    if (!res.ok || !res.versions.length) {
        sel.innerHTML = '<option value="">—</option>';
        document.getElementById('integrity-results').innerHTML = `<div style="color: var(--text-muted);">${escapeHtml(res.error || 'No downloaded versions found yet. Launch a game once first.')}</div>`;
        return;
    }
    for (const v of res.versions) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.innerText = v;
        if (v === currentConfig.version) opt.selected = true;
        sel.appendChild(opt);
    }
    document.getElementById('integrity-results').innerHTML = '<div style="color: var(--text-muted);">Pick a version and press Verify.</div>';
    document.getElementById('integrity-repair-btn').style.display = 'none';
}

function renderIntegrityResults(data) {
    const box = document.getElementById('integrity-results');
    if (!data) return;
    const { total = 0, verified = 0, unchecked = 0, missing = [], corrupt = [] } = data;
    const bad = [...missing, ...corrupt];
    const summary = `<div style="margin-bottom:8px; color:var(--text);">
        <span style="color:#2ecc71;">✔ ${verified} verified</span> ·
        <span style="color:#e67e22;">· ${unchecked} unchecked</span> ·
        <span style="color:#e74c3c;">✖ ${missing.length} missing</span> ·
        <span style="color:#e74c3c;">✖ ${corrupt.length} corrupt</span>
        <span style="color:var(--text-muted);"> (of ${total} libraries)</span></div>`;
    if (!bad.length) {
        box.innerHTML = summary + '<div style="color:#2ecc71; font-size:12px;">Everything checks out. Your libraries are intact.</div>';
        document.getElementById('integrity-repair-btn').style.display = 'none';
        return;
    }
    box.innerHTML = summary + bad.map((b, i) => `<div style="padding:6px 8px; margin-bottom:4px; background:var(--bg-main); border:1px solid var(--border); border-radius:6px;">
        <div style="color:var(--text); word-break:break-all;">${escapeHtml(b.name)}</div>
        <div style="color:#e74c3c; font-size:10.5px;">${escapeHtml(b.reason || 'problem')} — ${escapeHtml(b.path || '')}</div>
    </div>`).join('');
    integrityEligible = bad.filter(b => b.url);
    const repairBtn = document.getElementById('integrity-repair-btn');
    if (integrityEligible.length) {
        repairBtn.style.display = 'block';
        repairBtn.innerText = `⬇ Redownload ${integrityEligible.length} problem jar${integrityEligible.length === 1 ? '' : 's'}`;
    } else {
        repairBtn.style.display = 'none';
        box.innerHTML += '<div style="color:#e67e22; font-size:11.5px; margin-top:6px;">These problems cannot be repaired automatically (no download source declared).</div>';
    }
}

async function runIntegrityScan() {
    const sel = document.getElementById('integrity-version-select');
    if (!sel.value) return;
    const btn = document.getElementById('integrity-scan-btn');
    btn.disabled = true;
    btn.innerText = 'Verifying...';
    document.getElementById('integrity-results').innerHTML = '<div style="color: var(--text-muted);">Hashing libraries (this can take a minute on big installs)...</div>';
    try {
        const res = await ipcRenderer.invoke('integrity-scan', sel.value);
        if (!res.ok) { alert(res.error); }
        else renderIntegrityResults(res);
    } catch (err) {
        alert(String(err.message || err));
    } finally {
        btn.disabled = false;
        btn.innerText = 'Verify';
    }
}

async function runIntegrityRepair() {
    const sel = document.getElementById('integrity-version-select');
    const btn = document.getElementById('integrity-repair-btn');
    btn.disabled = true;
    btn.innerText = 'Redownloading...';
    try {
        const res = await ipcRenderer.invoke('integrity-repair', { versionId: sel.value, entries: integrityEligible });
        if (!res.ok) {
            alert(res.error);
        } else {
            let msg = `${res.fixed.length} repaired.`;
            if (res.failed.length) msg += ` ${res.failed.length} failed:\n` + res.failed.map(f => `• ${f.name}: ${f.error}`).join('\n');
            alert(msg);
            if (res.after && res.after.ok !== false) renderIntegrityResults(res.after);
        }
    } catch (err) {
        alert(String(err.message || err));
    } finally {
        btn.disabled = false;
    }
}

// Wiring
const snapshotsBtn = document.getElementById('open-snapshots-btn');
if (snapshotsBtn) snapshotsBtn.addEventListener('click', openSnapshots);
const snapshotCreateBtn = document.getElementById('snapshot-create-btn');
if (snapshotCreateBtn) snapshotCreateBtn.addEventListener('click', () => {
    const label = document.getElementById('snapshot-label-input').value.trim();
    if (!label) { alert('Give the snapshot a label first.'); return; }
    ipcRenderer.send('snapshot-create', { instanceId: currentActiveInstanceId, label });
});
const integrityBtn = document.getElementById('open-integrity-btn');
if (integrityBtn) integrityBtn.addEventListener('click', openIntegrity);
const integrityScanBtn = document.getElementById('integrity-scan-btn');
if (integrityScanBtn) integrityScanBtn.addEventListener('click', runIntegrityScan);
const integrityRepairBtn = document.getElementById('integrity-repair-btn');
if (integrityRepairBtn) integrityRepairBtn.addEventListener('click', runIntegrityRepair);
