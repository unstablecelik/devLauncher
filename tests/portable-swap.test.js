'use strict';
// Integration tests for src/utils/portableSwap.js — the pure-fs portable
// update swap: lock waiting, entry-by-entry replacement, rollback safety and
// the preserved user-data set. All side effects are injected (probeLock,
// rename, relaunch) so no real launcher process is spawned here.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { check, finish } = require('./helpers');
const S = require(path.join(__dirname, '..', 'src', 'utils', 'portableSwap'));

const NEW_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-swap-'));
const roots = [];

// ── fixture builder ─────────────────────────────────────────────────────
function write(p, content) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
}
function makeAppDir(name, { withStaging }) {
    const root = fs.mkdtempSync(path.join(NEW_ROOT, name + '-'));
    roots.push(root);
    const appDir = path.join(root, 'app');
    fs.mkdirSync(appDir);
    write(path.join(appDir, 'devLauncher.exe'), 'OLD-EXE');
    write(path.join(appDir, 'resources', 'app.asar'), 'OLD-ASAR');
    write(path.join(appDir, 'stale.dll'), 'OLD-STALE');
    write(path.join(appDir, 'portable.marker'), 'M');
    write(path.join(appDir, 'data', 'user.json'), '{"keep":true}');
    if (withStaging) {
        const staging = path.join(appDir, '.update-staging');
        write(path.join(staging, 'devLauncher.exe'), 'NEW-EXE');
        write(path.join(staging, 'resources', 'app.asar'), 'NEW-ASAR');
        write(path.join(staging, 'brandnew.dll'), 'NEW-FILE');
    }
    return appDir;
}

(async () => {
    // ── 1. happy path: wait for lock, full swap, relaunch new exe ────────
    {
        const appDir = makeAppDir('happy', { withStaging: true });
        const lockCalls = [];
        const relaunched = [];
        const res = await S.runPortableSwap({
            appDir,
            stepMs: 1,
            maxWaitMs: 50,
            probeLock: () => (lockCalls.push(1), lockCalls.length < 2), // locked once, then free
            relaunch: (exePath) => relaunched.push(exePath)
        });

        check('happy: swap reported ok', res.ok === true);
        check('happy: swapped entries include exe', Array.isArray(res.swapped) && res.swapped.includes('devLauncher.exe'));
        check('happy: lock probed until free', lockCalls.length === 2);
        check('happy: new exe content in place', fs.readFileSync(path.join(appDir, 'devLauncher.exe'), 'utf8') === 'NEW-EXE');
        check('happy: new resources replaced old', fs.readFileSync(path.join(appDir, 'resources', 'app.asar'), 'utf8') === 'NEW-ASAR');
        check('happy: brandnew file arrived', fs.readFileSync(path.join(appDir, 'brandnew.dll'), 'utf8') === 'NEW-FILE');
        check('happy: stale old entry removed', !fs.existsSync(path.join(appDir, 'stale.dll')));
        check('happy: portable marker preserved', fs.readFileSync(path.join(appDir, 'portable.marker'), 'utf8') === 'M');
        check('happy: user data preserved', fs.readFileSync(path.join(appDir, 'data', 'user.json'), 'utf8') === '{"keep":true}');
        check('happy: staging dir cleaned', !fs.existsSync(path.join(appDir, '.update-staging')));
        check('happy: backup dir cleaned', !fs.existsSync(path.join(appDir, '.update-backup')));
        check('happy: relaunched new exe', relaunched.length === 1 && relaunched[0] === path.join(appDir, 'devLauncher.exe'));
    }

    // ── 2. no staging dir: nothing to apply, no relaunch, no writes ──────
    {
        const appDir = makeAppDir('nostage', { withStaging: false });
        const relaunched = [];
        const res = await S.runPortableSwap({ appDir, stepMs: 1, maxWaitMs: 20, probeLock: () => false, relaunch: (p) => relaunched.push(p) });

        check('no-stage: fails cleanly', res.ok === false && /staging/i.test(res.reason));
        check('no-stage: nothing relaunched', relaunched.length === 0);
        check('no-stage: old exe untouched', fs.readFileSync(path.join(appDir, 'devLauncher.exe'), 'utf8') === 'OLD-EXE');
        check('no-stage: no backup pocket left', !fs.existsSync(path.join(appDir, '.update-backup')));
    }

    // ── 3. timeout while exe stays locked: abort before touching disk ────
    {
        const appDir = makeAppDir('timeout', { withStaging: true });
        let relaunchCalls = 0;
        const res = await S.runPortableSwap({ appDir, stepMs: 2, maxWaitMs: 6, probeLock: () => true, relaunch: () => relaunchCalls++ });

        check('timeout: aborted', res.ok === false && /timeout/i.test(res.reason));
        check('timeout: no relaunch', relaunchCalls === 0);
        check('timeout: backup not created', !fs.existsSync(path.join(appDir, '.update-backup')));
        check('timeout: old files intact', fs.readFileSync(path.join(appDir, 'stale.dll'), 'utf8') === 'OLD-STALE');
        check('timeout: staging still there', fs.existsSync(path.join(appDir, '.update-staging')));
    }

    // ── 4. park-phase failure: rollback puts every old entry back ────────
    {
        const appDir = makeAppDir('parkfail', { withStaging: true });
        const relaunched = [];
        const rename = (from, to) => {
            if (from.endsWith(path.join(appDir, 'locked.dll'))) throw new Error('simulated EPERM');
            fs.renameSync(from, to);
        };
        fs.renameSync(path.join(appDir, 'stale.dll'), path.join(appDir, 'locked.dll')); // rename fixture, then lock it
        const res = await S.runPortableSwap({ appDir, stepMs: 1, maxWaitMs: 20, probeLock: () => false, rename, relaunch: (p) => relaunched.push(p) });

        check('park-fail: reported failure', res.ok === false && /parking old files failed: simulated EPERM/.test(res.reason));
        check('park-fail: parked entry restored', fs.existsSync(path.join(appDir, 'locked.dll')));
        check('park-fail: untouched entries intact', fs.readFileSync(path.join(appDir, 'devLauncher.exe'), 'utf8') === 'OLD-EXE');
        check('park-fail: staging untouched', fs.readFileSync(path.join(appDir, '.update-staging', 'brandnew.dll'), 'utf8') === 'NEW-FILE');
        check('park-fail: rollback cleaned backup', !fs.existsSync(path.join(appDir, '.update-backup')));
        check('park-fail: no relaunch', relaunched.length === 0);
    }

    // ── 5. move-new failure: new entries unstaged, old entries restored ──
    {
        const appDir = makeAppDir('movefail', { withStaging: true });
        const relaunched = [];
        const rename = (from, to) => {
            if (from.endsWith('brandnew.dll') && to.startsWith(appDir + path.sep)) throw new Error('simulated disk full');
            fs.renameSync(from, to);
        };
        const res = await S.runPortableSwap({ appDir, stepMs: 1, maxWaitMs: 20, probeLock: () => false, rename, relaunch: (p) => relaunched.push(p) });

        check('move-fail: reported failure', res.ok === false && /swap failed: simulated disk full/.test(res.reason));
        check('move-fail: partially moved exe unstaged back', fs.readFileSync(path.join(appDir, '.update-staging', 'devLauncher.exe'), 'utf8') === 'NEW-EXE');
        check('move-fail: old exe restored', fs.readFileSync(path.join(appDir, 'devLauncher.exe'), 'utf8') === 'OLD-EXE');
        check('move-fail: old resources restored', fs.readFileSync(path.join(appDir, 'resources', 'app.asar'), 'utf8') === 'OLD-ASAR');
        check('move-fail: rollback cleaned backup', !fs.existsSync(path.join(appDir, '.update-backup')));
        check('move-fail: no relaunch', relaunched.length === 0);
    }

    // ── 6. default lock probe sanity (Linux: no real exe lock) ───────────
    {
        const appDir = makeAppDir('probe', { withStaging: false });
        // rename-based probe on a file nobody holds open reports "not locked"
        check('probe: free exe reports unlocked', S.defaultProbeLock(appDir, 'devLauncher.exe') === false);
        // missing exe cannot be locked either
        check('probe: missing exe reports unlocked', S.defaultProbeLock(appDir, 'nope.exe') === false);
    }

    roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true }));
    fs.rmSync(NEW_ROOT, { recursive: true, force: true });
    finish('portable-swap');
})().catch((err) => {
    console.error('portable-swap suite crashed:', err);
    process.exit(1);
});
