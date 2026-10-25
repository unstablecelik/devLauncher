'use strict';
// Unit tests for src/utils/appUpdate.js — the pure self-update helpers:
// version compare, release asset selection, SHA256SUMS parsing, update-mode
// resolution and the generated Inno/portable update commands.
const path = require('path');
const { check, finish } = require('./helpers');
const A = require(path.join(__dirname, '..', 'src', 'utils', 'appUpdate'));

// ── compareVersions ─────────────────────────────────────────────────────
check('semver: patch diff', A.compareVersions('1.2.13', '1.2.3') === 1);
check('semver: minor diff', A.compareVersions('1.9.9', '1.10.0') === -1);
check('semver: equal (string input)', A.compareVersions('0.13.0', '0.13.0') === 0);
check('semver: more segments wins', A.compareVersions('0.13.0.1', '0.13.0') === 1);
check('semver: empty input is 0', A.compareVersions('', '0.13.0') === -1);

// ── stripTag ────────────────────────────────────────────────────────────
check('stripTag: v prefix', A.stripTag('v1.2.3') === '1.2.3');
check('stripTag: uppercase V', A.stripTag('V2.0.1') === '2.0.1');
check('stripTag: bare version', A.stripTag('0.13.0') === '0.13.0');

// ── artifact naming ────────────────────────────────────────────────────
check('zip name: x64 has no suffix', A.zipArtifactName('devLauncher', '0.13.0', 'x64') === 'devLauncher-0.13.0-win.zip');
check('zip name: ia32 suffix', A.zipArtifactName('devLauncher', '0.13.0', 'ia32') === 'devLauncher-0.13.0-ia32-win.zip');
check('zip name: arm64 suffix', A.zipArtifactName('devLauncher', '0.13.0', 'arm64') === 'devLauncher-0.13.0-arm64-win.zip');
check('setup name pattern', A.setupArtifactName('devLauncher', '0.13.0') === 'devLauncher-Setup-0.13.0.exe');

// ── pickAsset / assetUrl ────────────────────────────────────────────────
const assets = [
    { name: 'unrelated.zip', browser_download_url: 'https://x/unrelated.zip' },
    { name: 'devLauncher-Setup-0.13.0.exe', browser_download_url: 'https://x/setup.exe' }
];
check('pickAsset: exact name match', A.pickAsset(assets, 'devLauncher-Setup-0.13.0.exe').browser_download_url === 'https://x/setup.exe');
check('pickAsset: miss returns null', A.pickAsset(assets, 'nope.exe') === null);
check('pickAsset: null list safe', A.pickAsset(null, 'x') === null);
check('assetUrl: empty asset null', A.assetUrl(null) === null);
check('assetUrl: no url null', A.assetUrl({ name: 'a' }) === null);

// ── parseSha256Sums ─────────────────────────────────────────────────────
const H1 = 'a'.repeat(64).replace(/^/, '');
const H2 = 'b'.repeat(64);
const H3 = 'c'.repeat(64);
const sums = A.parseSha256Sums(
    H1 + '  devLauncher-Setup-0.13.0.exe\n' +
    H2 + '  devLauncher-Setup-0.13.0.exe.blockmap\n' +
    H3 + ' *devLauncher-0.13.0-win.zip\n' +
    'not-a-hash-line\n'
);
check('sums: plain filename', sums['devLauncher-Setup-0.13.0.exe'] === H1);
check('sums: dashed blockmap', sums['devLauncher-Setup-0.13.0.exe.blockmap'] === H2);
check('sums: binary marker (*)', sums['devLauncher-0.13.0-win.zip'] === H3);
const upper = A.parseSha256Sums('ABCDABCDABCDABCDABCDABCDABCDABCDABCDABCDABCDABCDABCDABCDABCDABCD  f.zip');
check('sums: uppercase hex accepted + lowercased', upper['f.zip'] === 'abcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcd');

// ── resolveUpdateMode ───────────────────────────────────────────────────
const dirJoin = (parts) => parts.join('/');
const mode = (opts) => A.resolveUpdateMode(Object.assign({ exeDir: dirJoin(['C:', 'app']), envFlag: undefined, fileExists: () => false }, opts));
check('mode: default installed', mode({}) === 'installed');
check('mode: marker file wins', mode({ fileExists: (p) => p === dirJoin(['C:', 'app', 'portable.marker']) }) === 'portable');
check('mode: env flag wins', mode({ envFlag: '1' }) === 'portable');
check('mode: env true flag', mode({ envFlag: 'true' }) === 'portable');

// ── buildInnoUpdateArgs ────────────────────────────────────────────────
const innoArgs = A.buildInnoUpdateArgs('C:\\tmp\\setup.exe');
check('inno args: silent', innoArgs.includes('/VERYSILENT'));
check('inno args: no dialogs', innoArgs.includes('/SUPPRESSMSGBOXES'));
check('inno args: restart via Restart Manager', innoArgs.includes('/RESTARTAPPLICATIONS'));
check('inno args: force close lingering', innoArgs.includes('/CLOSEAPPLICATIONS'));

finish('app-update');
