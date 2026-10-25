'use strict';
// ── Portable in-place swap (pure fs, no shell helpers) ──────────────────────
// Runs in a detached second copy of the launcher launched with
// `devLauncher.exe --apply-update`. It waits until the running launcher's exe
// is no longer locked, then moves the freshly extracted `.update-staging`
// tree over the app directory one top-level entry at a time. Every old entry
// is first parked inside `.update-backup`, so any mid-swap failure rolls the
// previous version back instead of leaving a half-replaced folder.
//
// Preserved across the swap: portable marker, the whole `data` user folder,
// staging and backup themselves. Everything else is replaced.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PRESERVED = new Set(['.update-staging', '.update-backup', 'portable.marker', 'data']);
const EXE_NAME = 'devLauncher.exe';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Default lock probe for painted Windows semantics: a running exe cannot be
 * renamed (EPERM), so rename → rename-back is a cheap free test. Returns
 * true while the launcher exe is still running. Conservative: unknown
 * errors also count as "still locked", the wait loop handles it.
 */
function defaultProbeLock(appDir, exeName) {
    const exe = path.join(appDir, exeName);
    if (!fs.existsSync(exe)) return false;
    const probe = exe + '.lck';
    try {
        fs.renameSync(exe, probe);
        fs.renameSync(probe, exe);
        return false;
    } catch (_) {
        return true;
    }
}

/**
 * Perform the swap. All side-effectful knobs are injectable so the routine
 * is unit-testable: probeLock (lock state), rename (entry moves), relaunch
 * (process spawn), stepMs/maxWaitMs (wait loop timing).
 */
async function runPortableSwap(options) {
    const appDir = options.appDir;
    const stagingDir = options.stagingDir || path.join(appDir, '.update-staging');
    const backupDir = options.backupDir || path.join(appDir, '.update-backup');
    const exeName = options.exeName || EXE_NAME;
    const probeLock = options.probeLock || defaultProbeLock;
    const rename = options.rename || ((from, to) => fs.renameSync(from, to));
    const maxWaitMs = options.maxWaitMs != null ? options.maxWaitMs : 90 * 1000;
    const stepMs = options.stepMs != null ? options.stepMs : 1500;
    const relaunch = options.relaunch || ((exePath) => {
        spawn(exePath, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    });

    if (!fs.existsSync(stagingDir)) {
        return { ok: false, reason: 'no staging dir (nothing to apply)' };
    }

    // 1. Wait for the running launcher to release the exe lock.
    let waitedMs = 0;
    while (probeLock(appDir, exeName)) {
        if (waitedMs >= maxWaitMs) return { ok: false, reason: 'timeout waiting for the launcher to exit' };
        await sleep(stepMs);
        waitedMs += stepMs;
    }

    const restore = (moved) => {
        for (const name of moved) {
            try { rename(path.join(backupDir, name), path.join(appDir, name)); }
            catch (err) { console.error('[UpdateSwap] rollback failed for', name, err.message); }
        }
    };

    try {
        // 2. Fresh backup pocket.
        fs.rmSync(backupDir, { recursive: true, force: true });
        fs.mkdirSync(backupDir, { recursive: true });
    } catch (err) {
        return { ok: false, reason: `backup pocket failed: ${err.message}` };
    }

    // 3. Park every old top-level entry away from the app dir.
    const parkedOld = [];
    try {
        for (const name of fs.readdirSync(appDir)) {
            if (PRESERVED.has(name)) continue;
            rename(path.join(appDir, name), path.join(backupDir, name));
            parkedOld.push(name);
        }
    } catch (err) {
        restore(parkedOld);
        fs.rmSync(backupDir, { recursive: true, force: true });
        return { ok: false, reason: `parking old files failed: ${err.message}` };
    }

    // 4. Move the new tree in. On any failure the new entries already
    //    moved go back to staging first, then the old ones come back.
    const movedNew = [];
    try {
        for (const name of fs.readdirSync(stagingDir)) {
            const from = path.join(stagingDir, name);
            if (!fs.existsSync(from)) continue;
            rename(from, path.join(appDir, name));
            movedNew.push(name);
        }
    } catch (err) {
        for (const backOut of movedNew) {
            try { rename(path.join(appDir, backOut), path.join(stagingDir, backOut)); }
            catch (err2) { console.error('[UpdateSwap] unstaging failed for', backOut, err2.message); }
        }
        restore(parkedOld);
        fs.rmSync(backupDir, { recursive: true, force: true });
        return { ok: false, reason: `swap failed: ${err.message}` };
    }

    // 5. Clean the scaffolding and relaunch the new launcher.
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.rmSync(backupDir, { recursive: true, force: true });
    const newExe = path.join(appDir, exeName);
    if (fs.existsSync(newExe)) relaunch(newExe);
    return { ok: true, swapped: movedNew };
}

module.exports = { runPortableSwap, defaultProbeLock, PRESERVED, EXE_NAME, sleep };
