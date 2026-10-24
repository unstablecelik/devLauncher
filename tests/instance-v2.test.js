'use strict';
// InstanceManager v2 contract tests: slug+hash ids, strict validation,
// duplicate/rename/delete, legacy "default" migration, and the static
// guarantee that no `|| 'default'` fallback remains in the app code.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { check, tmpdir, finish } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const InstanceManager = require(`${ROOT}/src/services/instanceManager`);

const ID_RE = /^[a-z0-9-]+-[0-9a-f]{4}$/;

// helper to create a fresh manager in an isolated tree
function makeManager(name) {
    const base = path.join(tmpdir(name + '-'), 'instances');
    const snaps = path.join(tmpdir(name + 's-'), 'snapshots');
    fs.mkdirSync(snaps, { recursive: true });
    return { mgr: new InstanceManager({ baseDir: base, snapshotDir: snaps }), base, snaps };
}

// ── createInstance v2 object API ────────────────────────────────────────
{
    const { mgr } = makeManager('create');
    const cfg = mgr.createInstance({ name: 'Sky Factory', mcVersion: '1.21.1', loaderType: 'fabric', loaderVersion: '0.16.9' });
    check('id is slug+4hex', ID_RE.test(cfg.id), cfg.id);
    check('id slug prefix', cfg.id.startsWith('sky-factory-'), cfg.id);
    check('name preserved verbatim', cfg.name === 'Sky Factory');
    check('version + loader stored', cfg.version === '1.21.1' && cfg.loaderType === 'fabric' && cfg.loaderVersion === '0.16.9');
    check('createdAt present', typeof cfg.createdAt === 'string' && cfg.createdAt.length > 10);

    // dirs for content
    for (const sub of ['mods', 'saves', 'resourcepacks', 'config']) {
        check(`subdir ${sub} created`, fs.existsSync(path.join(mgr.baseDir, cfg.id, sub)));
    }
    check('instance.json written', JSON.parse(fs.readFileSync(path.join(mgr.baseDir, cfg.id, 'instance.json'), 'utf8')).id === cfg.id);

    const invalidLoader = mgr.createInstance({ name: 'X', mcVersion: '1.20.1', loaderType: 'not-real-loader' });
    check('unknown loader coerced vanilla', invalidLoader.loaderType === 'vanilla');
}

// ── unique ids even for identical names (collision handling) ────────────
{
    const { mgr } = makeManager('collide');
    const ids = new Set();
    for (let i = 0; i < 12; i++) ids.add(mgr.createInstance({ name: 'Same Name', mcVersion: '1.21.1' }).id);
    check('12 same-name creates = 12 unique ids', ids.size === 12);
}

// ── duplicate / rename / delete ─────────────────────────────────────────
{
    const { mgr } = makeManager('flavours');
    const src = mgr.createInstance({ name: 'Orig', mcVersion: '1.21.1' });
    fs.writeFileSync(path.join(mgr.baseDir, src.id, 'mods', 'phosphor.jar'), 'data');
    fs.mkdirSync(path.join(mgr.baseDir, src.id, 'saves', 'WorldA'), { recursive: true });
    fs.writeFileSync(path.join(mgr.baseDir, src.id, 'saves', 'WorldA', 'level.dat'), 'x');

    const dup = mgr.duplicateInstance(src.id, 'My Copy');
    check('duplicate new id', dup.id !== src.id && ID_RE.test(dup.id));
    check('duplicate name', dup.name === 'My Copy');
    check('duplicate copied mods content', fs.readFileSync(path.join(mgr.baseDir, dup.id, 'mods', 'phosphor.jar'), 'utf8') === 'data');
    check('duplicate copied saves', fs.existsSync(path.join(mgr.baseDir, dup.id, 'saves', 'WorldA', 'level.dat')));
    check('duplicate duplicatedFrom', dup.duplicatedFrom === src.id);
    check('duplicate default name copy', mgr.duplicateInstance(src.id, '').name.includes('copy'));

    const renamed = mgr.renameInstance(src.id, 'Renamed One');
    check('rename keeps id', renamed.id === src.id);
    check('rename updates name', renamed.name === 'Renamed One');
    check('rename persisted', JSON.parse(fs.readFileSync(path.join(mgr.baseDir, src.id, 'instance.json'), 'utf8')).name === 'Renamed One');

    check('deleteInstance removes dir', mgr.deleteInstance(dup.id) === true && !fs.existsSync(path.join(mgr.baseDir, dup.id)));
    check('double delete returns false', mgr.deleteInstance(dup.id) === false);
}

// ── strict lookups: throw, never fall back ──────────────────────────────
{
    const { mgr } = makeManager('strict');
    const cfg = mgr.createInstance({ name: 'Only One', mcVersion: '1.21.1' });

    check('getInstance unknown = null', mgr.getInstance('ghost') === null && mgr.getInstance(undefined) === null);
    check('getInstance known = cfg', mgr.getInstance(cfg.id).id === cfg.id);
    check('gameDir known', mgr.getInstanceGameDir(cfg.id) === path.join(mgr.baseDir, cfg.id));

    const throwsOn = (label, fn) => {
        let threw = null;
        try { fn(); } catch (e) { threw = e.message || String(e); }
        check(`strict throws: ${label}`, threw !== null, threw);
        return threw;
    };
    throwsOn('undefined id', () => mgr.getInstanceGameDir(undefined));
    throwsOn('empty id', () => mgr.getInstanceGameDir(''));
    throwsOn('dotted id', () => mgr.getInstanceGameDir('.'));
    throwsOn('double-dot id', () => mgr.getInstanceGameDir('..'));
    throwsOn('traversal id', () => mgr.getInstanceGameDir('../evil'));
    throwsOn('unknown but valid id', () => mgr.getInstanceGameDir('absent-x1'));
    check('deleteInstance invalid id throws', (() => { try { mgr.deleteInstance('../x'); return false; } catch (_) { return true; } })());
}

// ── legend migration: old auto-created 'default' ────────────────────────
{
    const baseRoot = path.join(tmpdir('migrate-'), 'la');
    const base = path.join(baseRoot, 'instances');
    const snaps = path.join(baseRoot, 'snapshots');
    mkdirp(snaps);

    // fixture: the legacy auto-created default (fabric 1.21.1 w/o loader version could never launch)
    mkdirp(path.join(base, 'default'));
    fs.writeFileSync(path.join(base, 'default', 'instance.json'), JSON.stringify({
        id: 'default', name: 'Default Instance', version: '1.21.1', loaderType: 'fabric', loaderVersion: null
    }, null, 2));
    fs.writeFileSync(path.join(base, 'default', 'options.txt'), 'fov:0.5');
    mkdirp(path.join(base, 'default', 'mods'));
    fs.writeFileSync(path.join(base, 'default', 'mods', 'optifine.jar'), 'v1');
    fs.writeFileSync(path.join(snaps, 'default.json'), JSON.stringify({ labels: [] }));

    const mgr = new InstanceManager({ baseDir: base, snapshotDir: snaps });

    const migrated = mgr.listInstances();
    check('migration produced exactly 1 instance', migrated.length === 1, migrated);
    const first = migrated[0];
    check('legacy folder gone', !fs.existsSync(path.join(base, 'default')));
    check('migrated id prefixed default-', first.id.startsWith('default-') && ID_RE.test(first.id), first.id);
    check('migratedFrom marker', first.migratedFrom === 'default');
    check('legacy fabric bug healed to vanilla', first.loaderType === 'vanilla' && first.loaderVersion === null, first.loaderType);
    check('content moved intact', fs.readFileSync(path.join(base, first.id, 'options.txt'), 'utf8') === 'fov:0.5');
    check('mods moved intact', fs.existsSync(path.join(base, first.id, 'mods', 'optifine.jar')));
    check('snapshot manifest followed', fs.existsSync(path.join(snaps, `${first.id}.json`)) && !fs.existsSync(path.join(snaps, 'default.json')));

    // idempotent: constructing again must not duplicate or re-migrate
    const again = new InstanceManager({ baseDir: base, snapshotDir: snaps });
    check('migration idempotent', again.listInstances().length === 1 && again.listInstances()[0].id === first.id);

    // migrated instance is a normal deletable one
    check('migrated instance deletable', again.deleteInstance(first.id) === true && again.listInstances().length === 0);
}

function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }

// ── listInstances skips garbage dirs ────────────────────────────────────
{
    const { mgr } = makeManager('garbage');
    mgr.createInstance({ name: 'Good', mcVersion: '1.21.1' });
    // broken dirs: hidden-ish name, no manifest, corrupt json
    mkdirp(path.join(mgr.baseDir, 'no-manifest'));
    mkdirp(path.join(mgr.baseDir, 'bad-json'));
    fs.writeFileSync(path.join(mgr.baseDir, 'bad-json', 'instance.json'), '{oops');
    mkdirp(path.join(mgr.baseDir, 'space dir'));
    const list = mgr.listInstances();
    check('garbage dirs skipped', list.length === 1 && list[0].name === 'Good', list.map(i => i.id));
}

// ── static audit: no ||  'default' fallback may come back ───────────────
{
    const bannedRe = /\|\|\s*'default'/;
    let offenders = [];
    for (const rel of ['main.js', 'renderer.js']) {
        for (const [idx, line] of fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n').entries()) {
            if (bannedRe.test(line)) offenders.push(`${rel}:${idx + 1}`);
        }
    }
    offenders = offenders.filter(f => true);
    check('no ||  default fallback remains', offenders.length === 0, offenders);

    const cfgSrc = fs.readFileSync(path.join(ROOT, 'src/services/configStore.js'), 'utf8');
    check('configStore selectedInstanceId default null', /selectedInstanceId:\s*null/.test(cfgSrc) && !/selectedInstanceId:\s*'default'/.test(cfgSrc));

    // old silent-fallback sanitize must be gone: it must THROW now
    const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    check('sanitizeInstanceId throwing shape', /function sanitizeInstanceId[\s\S]{0,400}throw new Error/.test(mainSrc));
}

finish('instance-v2');
