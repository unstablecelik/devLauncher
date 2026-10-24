'use strict';
// Packaging contract tests: Inno Setup script, electron-builder win targets,
// self-hosted updater wiring and repository identity (no stale upstream refs).
const fs = require('fs');
const path = require('path');
const { check, finish } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const readFile = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const pkg = require(path.join(ROOT, 'package.json'));
const iss = readFile('installer.iss');
const updaterSrc = readFile(path.join('src', 'services', 'updaterService.js'));
const appUpdateSrc = readFile(path.join('src', 'utils', 'appUpdate.js'));

// ── installer.iss contract ──────────────────────────────────────────────
check('iss: version matches package.json', iss.includes(`#define MyAppVersion "${pkg.version}"`));
check('iss: per-user install (no admin)', /PrivilegesRequired\s*=\s*lowest/.test(iss));
check('iss: per-user default dir', iss.includes('DefaultDirName={autopf}\\{#MyAppName}'));
check('iss: dedicated installer icon', iss.includes('SetupIconFile=assets\\icons\\installer.ico'));
check('iss: uninstall shows app icon', iss.includes('UninstallDisplayIcon={app}\\{#MyAppExeName}'));
check('iss: output named with version', iss.includes('OutputBaseFilename=devLauncher-Setup-{#MyAppVersion}'));
check('iss: publisher is repo owner', iss.includes('#define MyAppPublisher "unstablecelik"') && iss.includes('unstablecelik/devLauncher'));
check('iss: Rest Manager restart supported', iss.includes('RestartApplications=yes'));
check('iss: files come from win-unpacked', iss.includes('Source: "dist\\win-unpacked\\{#MyAppExeName}"'));

// ── electron-builder win targets ────────────────────────────────────────
const targets = (pkg.build.win.target || []).map(t => (typeof t === 'string' ? t : t.target));
check('win: no NSIS target', !targets.includes('nsis'));
check('win: zip target present', targets.includes('zip'));
const winArchs = (pkg.build.win.target || [])
    .filter(t => (typeof t === 'string' ? t : t.target) === 'zip')
    .flatMap(t => t.arch || []);
check('win: x64 zip built', winArchs.includes('x64'));
check('win: ia32 zip built (legacy school PC)', winArchs.includes('ia32'));

// ── packaging scripts ───────────────────────────────────────────────────
check('scripts: inno build exists', /"build:inno":\s*"iscc installer\.iss"/.test(JSON.stringify(pkg.scripts)));
check('scripts: inno wine fallback exists', /build:inno:wine/.test(JSON.stringify(pkg.scripts)));

// ── updater is self-hosted now ──────────────────────────────────────────
check('updater: electron-updater no longer required', !updaterSrc.includes('electron-updater'));
check('updater: uses appUpdate helpers', updaterSrc.includes("require('../utils/appUpdate')"));
check('updater: portable marker support', updaterSrc.includes('portable.marker') || appUpdateSrc.includes('portable.marker'));
check('updater: portable wait-and-swap cmd', updaterSrc.includes('update.cmd'));
check('updater: inno silent install path', updaterSrc.includes('buildInnoUpdateArgs'));
check('deps: electron-updater removed from dependencies', !(pkg.dependencies || {}).electron_updater && !(pkg.dependencies || {})['electron-updater']);

// ── repository identity ────────────────────────────────────────────────
check('package.json: no stale upstream author', !JSON.stringify(pkg).includes('fedevoral'));
check('renderer: repo link points here', !readFile('renderer.js').includes('github.com/fedevoral'));
check('index.html: no stale upstream mentions', !readFile('index.html').includes('fedevoral'));
const pkgbuild = readFile('PKGBUILD');
check('PKGBUILD: correct repo url', !pkgbuild.includes('fedevoral'));
check('PKGBUILD: GPL licence', pkgbuild.includes('GPL-3.0-only'));
check('SCHOOL-2PC guide exists', fs.existsSync(path.join(ROOT, 'docs', 'SCHOOL-2PC.md')));

finish('installer');
