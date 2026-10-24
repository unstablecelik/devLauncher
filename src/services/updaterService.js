const { autoUpdater } = require('electron-updater');

// ── Self-Update service ─────────────────────────────────────────────────────
// Electron-updater wrapper that broadcasts lifecycle events over an IPC channel.
// The renderer listens on 'update-status' and shows a badge; installing is a
// single button that calls `installUpdate()` (quit + install on next launch).

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours

class UpdaterService {
    constructor() {
        this.broadcast = null;
        this.checkTimer = null;
        this.availableVersion = null;
        this.downloaded = false;
    }

    init(broadcast) {
        this.broadcast = broadcast || (() => {});
        autoUpdater.autoDownload = true;
        autoUpdater.autoInstallOnAppQuit = true;

        autoUpdater.on('checking-for-update', () => {
            this.emit({ status: 'checking' });
        });
        autoUpdater.on('update-available', (info) => {
            this.availableVersion = info.version;
            this.emit({ status: 'downloading', version: info.version });
        });
        autoUpdater.on('update-not-available', () => {
            this.availableVersion = null;
            this.emit({ status: 'up-to-date' });
        });
        autoUpdater.on('download-progress', (progress) => {
            this.emit({
                status: 'downloading',
                version: this.availableVersion,
                percent: Math.round(progress.percent || 0),
                mbps: (progress.bytesPerSecond / 1024 / 1024).toFixed(1)
            });
        });
        autoUpdater.on('update-downloaded', (info) => {
            this.downloaded = true;
            this.emit({ status: 'ready', version: info.version });
        });
        autoUpdater.on('error', (err) => {
            // Silent in dev / offline environments; log for diagnosis
            console.error('[Updater] error:', err && err.message ? err.message : err);
            this.emit({ status: 'error', message: (err && err.message) || String(err) });
        });
    }

    emit(payload) {
        try {
            if (this.broadcast) this.broadcast('update-status', payload);
        } catch (_) {}
    }

    // Kick off first check after the UI has settled (avoids competing with
    // launcher startup downloads), then re-check periodically.
    startChecking(isDev) {
        if (isDev) {
            console.log('[Updater] disabled in dev (no app-update.yml)');
            this.emit({ status: 'dev-disabled' });
            return;
        }
        const run = () => {
            autoUpdater.checkForUpdates().catch(() => { /* error event already logged */ });
        };
        setTimeout(run, 15 * 1000);
        this.checkTimer = setInterval(run, CHECK_INTERVAL_MS);
    }

    // Manual check — works in dev too (useful for debugging the pipeline)
    checkNow() {
        autoUpdater.checkForUpdates().catch(() => {});
    }

    isUpdateDownloaded() {
        return this.downloaded;
    }

    installUpdate() {
        if (this.downloaded) {
            autoUpdater.quitAndInstall(false, true);
        }
    }

    dispose() {
        if (this.checkTimer) clearInterval(this.checkTimer);
        this.checkTimer = null;
    }
}

module.exports = UpdaterService;
