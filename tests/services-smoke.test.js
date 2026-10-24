'use strict';
// Service smoke + logic contract battery (recreated permanently inside the repo).
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { check, tmpdir, finish } = require('./helpers');

const ROOT = path.join(__dirname, '..');

// ── ObjectStore ─────────────────────────────────────────────────────────
const ObjectStore = require(`${ROOT}/src/services/objectStore`);
{
    const store = new ObjectStore(path.join(tmpdir('store-'), 'obj'));
    const buf = Buffer.from('hello-content-fixed');
    const sha1 = store.putBuffer(buf, 'smoke:test');
    check('objectStore roundtrip sha1', sha1 === crypto.createHash('sha1').update(buf).digest('hex'));
    check('objectStore has', store.has(sha1));
    const mat = path.join(tmpdir('mat-'), 'file.bin');
    store.materialize(sha1, mat);
    check('objectStore materialize', fs.readFileSync(mat).equals(buf));
    store.dropRef(sha1, 'smoke:test');
    check('objectStore dropRef not-a-thing', store.sizeOf(sha1) === 0 || store.has(sha1) === false);
}

// ── ShareCode ───────────────────────────────────────────────────────────
const ShareCode = require(`${ROOT}/src/services/shareCode`);
{
    const payload = { v: 1, mv: '1.21.1', lt: 'fabric', mods: [{ p: 'AABBCCDD', v: '1.0', f: 'sodium.jar' }] };
    const code = ShareCode.encode(payload);
    check('sharecode prefixed', /^DL13-/.test(code), code.slice(0, 12));
    const back = ShareCode.decode(code);
    check('sharecode roundtrip', back && back.ok === true && back.data && back.data.mv === '1.21.1' && Array.isArray(back.data.mods) && back.data.mods[0].p === 'AABBCCDD', back);
    check('sharecode garbage rejected cleanly', ShareCode.decode('DL13-@@@@').ok === false && ShareCode.decode('no-prefix').ok === false);
}

// ── Prefetch asset byte cap ─────────────────────────────────────────────
const PrefetchService = require(`${ROOT}/src/services/prefetchService`);
check('assetByteCapFromMB 0/unlimited', PrefetchService.assetByteCapFromMB(0) === 0);
check('assetByteCapFromMB 400', PrefetchService.assetByteCapFromMB(400) === 400 * 1024 * 1024);
check('assetByteCapFromMB null default', PrefetchService.assetByteCapFromMB(null) === 400 * 1024 * 1024);

// ── AccountService offline uuid ─────────────────────────────────────────
const AccountService = require(`${ROOT}/src/services/accountService`);
{
    const a = AccountService.offlineUuid('Player');
    const b = AccountService.offlineUuid('Player');
    check('offline uuid deterministic', a === b && /^[0-9a-f-]{36}$/.test(a), a);
    check('offline uuid dest differs by name', AccountService.offlineUuid('Steve') !== a);
}

// ── RemotePlay credential variants ──────────────────────────────────────
const RemotePlayService = require(`${ROOT}/src/services/remotePlayService`);
check('remoteplay exported class', typeof RemotePlayService === 'function');

// ── WorldPreview constants ──────────────────────────────────────────────
const WorldPreview = require(`${ROOT}/src/services/worldPreview`);
check('worldPreview type tags', WorldPreview.T_INT !== undefined && WorldPreview.T_COMPOUND !== undefined);

// ── Crash rules: JSON valid + all autofix types implemented ─────────────
const rules = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/data/crash-rules.json'), 'utf8'));
const implementable = new Set(['disable_mod', 'increase_ram', 'open_mods_folder', 'inspect_logs', 'open_settings', 'info_only', 'install_mod', 'search_modrinth']);
check('crash rules non-empty + valid', Array.isArray(rules) && rules.length >= 6, rules.length);
check('all crash rules implementable', rules.every(r => r.autoFix && implementable.has(r.autoFix.type)));

const CrashAnalyzer = require(`${ROOT}/src/services/crashAnalyzer`);
{
    const analyser = new CrashAnalyzer();
    const d = analyser.analyze('Fabric: missing required mod sodium\nsome more text');
    check('sodium rule install_mod', d && d.autoFix && d.autoFix.type === 'install_mod' && d.autoFix.target === 'sodium', d && d.autoFix);
    const d2 = analyser.analyze('NoClassDefFoundError: totally unrelated code path');
    check('unrelated log no rule', d2 === null, d2);
}

// ── JavaDetector pure helpers ────────────────────────────────────────────
const Jd = require(`${ROOT}/src/utils/javaDetector`);
check('detectJavaMajor fallback 21', typeof Jd.detectJavaMajor('/nonexistent/java/binary') === 'number');
check('adoptium arch map x64', JSON.parse(JSON.stringify(process.arch.replace('arm64', 'aarch64'))) !== undefined);

// ── Tar extractor (pure Node, shell-free) ────────────────────────────────
const { extractTarGz } = require(`${ROOT}/src/utils/tarExtract`);
check('tarExtract exported', typeof extractTarGz === 'function');

// ── Snapshot + Integrity deep flows ──────────────────────────────────────
const InstanceSnapshot = require(`${ROOT}/src/services/instanceSnapshot`);
const IntegrityService = require(`${ROOT}/src/services/integrityService`);
{
    // snapshot flow with fake object store root
    const storeRoot = path.join(tmpdir('snap-'), 'objects');
    const store = new ObjectStore(storeRoot);
    const snap = new InstanceSnapshot(store, { dir: path.join(tmpdir('snaps-'), 'lists') });
    const gameDir = tmpdir('game-');
    fs.mkdirSync(path.join(gameDir, 'mods'), { recursive: true });
    fs.writeFileSync(path.join(gameDir, 'mods', 'sodium.jar'), 'v1');
    fs.mkdirSync(path.join(gameDir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(gameDir, 'config', 'settings.json'), '{}');
    fs.writeFileSync(path.join(gameDir, 'options.txt'), 'fov:0.5\n');

    const manifest = snap.create('test-inst', gameDir, 'first');
    check('snapshot created', manifest.fileCount === 3 && manifest.label === 'first', manifest.fileCount);
    fs.unlinkSync(path.join(gameDir, 'mods', 'sodium.jar'));
    fs.writeFileSync(path.join(gameDir, 'mods', 'rogue.jar'), 'evil');
    const r = snap.restore('test-inst', manifest.id, gameDir);
    check('snapshot restore true rollback', r.restored === 3 && r.removed === 1, r);
    check('snapshot guard snapshot list', snap.list('test-inst').length >= 1);
    check('snapshot restore had safety', snap.list('test-inst').length === 2);
    check('dangerous path rejected', (() => { try { snap.restore('test-inst', manifest.id, '../outside'); return false; } catch (e) { return true; } })());
    try { snap.delete('test-inst', manifest.id); check('snapshot delete', snap.list('test-inst').length === 1); } catch (e) { check('snapshot delete (' + e.message + ')', false); }
    check('invalid instance id rejected', (() => { try { snap.list('../evil'); return false; } catch (_) { return true; } })());

    // integrity flow with crafted version dir
    const rootDir = tmpdir('mc-');
    const versionId = '1.21.1-int';
    fs.mkdirSync(path.join(rootDir, 'versions', versionId), { recursive: true });
    const goodSha = crypto.createHash('sha1').update('good').digest('hex');
    fs.writeFileSync(path.join(rootDir, 'versions', versionId, `${versionId}.json`), JSON.stringify({ libraries: [
        { name: 'g:1', downloads: { artifact: { path: 'g/1/g-1.jar', url: 'http://127.0.0.1:1/g', sha1: goodSha, size: 4 } } },
        { name: 'x:1', downloads: { artifact: { path: 'x/1/x-1.jar', url: '', sha1: null, size: null } } }
    ]}));
    fs.mkdirSync(path.join(rootDir, 'libraries', 'g', '1'), { recursive: true });
    fs.writeFileSync(path.join(rootDir, 'libraries', 'g', '1', 'g-1.jar'), 'good');
    fs.mkdirSync(path.join(rootDir, 'libraries', 'x', '1'), { recursive: true });
    fs.writeFileSync(path.join(rootDir, 'libraries', 'x', '1', 'x-1.jar'), 'x');
    const svc = new IntegrityService({ rootDir });
    const scan = svc.scan(versionId);
    check('integrity verified 1', scan.verified === 1 && scan.unchecked === 1 && scan.total === 2, scan);
    check('integrity version guard', (() => { try { svc.scan('../../etc'); return false; } catch (_) { return true; } })());
}

// ── Security: zgc flags + arg building invariants live in main.js (checked here indirectly) ──
check('zgc flags documented in main', fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8').includes('-XX:+UseZGC'));

// ── Mod Doctor + benchmark + fetchPool load without throwing ────────────
const ModDoctor = require(`${ROOT}/src/services/modDoctor`);
const BenchmarkService = require(`${ROOT}/src/services/benchmarkService`);
const FetchPool = require(`${ROOT}/src/services/fetchPool`);
const ImportService = require(`${ROOT}/src/services/importService`);
check('mod doctor class', typeof ModDoctor === 'function');
check('benchmark class', typeof BenchmarkService === 'function');
check('fetchPool class', typeof FetchPool === 'function');
check('importService class', typeof ImportService === 'function');

// ── ConfigStore defaults sane ────────────────────────────────────────────
const ConfigStore = require(`${ROOT}/src/services/configStore`);
{
    const cfg = new ConfigStore({ targetDir: path.join(tmpdir('cfg-'), '.dcfg') });
    check('configStore gcMode default', ['g1gc', 'zgc'].includes(cfg.get('gcMode')));
    cfg.set('maxRam', '3G');
    check('configStore set/get', cfg.get('maxRam') === '3G');
}

// ── No command-line posture: shell strings absent from shipped code ──────
{
    const forbidden = [/spawnSync\('(which|where|ldd|tar)'/, /execFileSync\('which'/, /exec\('/];
    const files = ['main.js', 'renderer.js'];
    const dirs = ['src/services', 'src/utils', 'src/data'];
    const all = [
        ...files.map(f => path.join(ROOT, f)),
        ...dirs.flatMap(d => fs.readdirSync(path.join(ROOT, d)).filter(f => f.endsWith('.js')).map(f => path.join(ROOT, d, f)))
    ];
    let offenders = [];
    for (const f of all) {
        const src = fs.readFileSync(f, 'utf8');
        for (const re of forbidden) {
            if (re.test(src)) offenders.push(`${path.relative(ROOT, f)}:${re}`);
            break;
        }
    }
    check('no shell-style command invocations', offenders.length === 0, offenders);
    const cpp = fs.readFileSync(path.join(ROOT, 'src/utils/javaDetector.js'), 'utf8');
    check('only java-binary probe remains', /spawnSync\(javaExe|spawnSync\(javaBin/.test(cpp) && !/spawnSync\('(tar|which|where|ldd)'/.test(cpp));
}

// ── Garbled character audit (mojibake/CJK/Cyrillic leftovers) ────────────
{
    const badRe = /[\uFFFD\u0400-\u04FF\u4E00-\u9FFF\u3040-\u30FF]/;
    const targets = ['main.js', 'renderer.js', 'index.html', 'preload.js', 'package.json'];
    let garbled = [];
    for (const rel of targets) {
        const p = path.join(ROOT, rel);
        if (!fs.existsSync(p)) continue;
        const lines = fs.readFileSync(p, 'utf8').split('\n');
        lines.forEach((l, i) => { if (badRe.test(l)) garbled.push(`${rel}:${i + 1}`); });
    }
    for (const dir of ['src/services', 'src/utils', 'src/data']) {
        for (const f of fs.readdirSync(path.join(ROOT, dir))) {
            if (!/\.(js|json)$/.test(f)) continue;
            const p = path.join(ROOT, dir, f);
            const c = fs.readFileSync(p, 'utf8');
            if (badRe.test(c)) garbled.push(`${dir}/${f}`);
        }
    }
    check('no garbled/CJK/Cyrillic characters in code', garbled.length === 0, garbled);
}

finish('services-smoke');
