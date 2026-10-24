'use strict';
/**
 * InstanceManager v2 - rewritten from the ground up.
 *
 * Core rules:
 *   - There is NO implicit "default" instance. The legacy auto-created
 *     default is migrated once (folder renamed to a slug+hash id) and is
 *     thereafter a normal, deletable instance.
 *   - Instance ids are generated: slug(name)-<4 hex chars>, unique.
 *   - Every lookup is strict: invalid or unknown instance ids are errors,
 *     never silently replaced by a fallback.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const VALID_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

class InstanceManager {
    constructor(options = {}) {
        this.baseDir = options.baseDir || path.join(os.homedir(), '.devlauncher', 'instances');
        this.ensureBaseDirectory();
        // Migration runs in the constructor so the very first use is already
        // legacy-free. It is idempotent and cheap (one readdir).
        this.migrateLegacyDefault(options.snapshotDir || path.join(os.homedir(), '.devlauncher', 'snapshots'));
    }

    ensureBaseDirectory() {
        if (!fs.existsSync(this.baseDir)) fs.mkdirSync(this.baseDir, { recursive: true });
    }

    static isValidId(id) {
        return typeof id === 'string' && VALID_ID_RE.test(id) && id !== '.' && id !== '..';
    }

    /** Slug part of an id: lowercase latin/digits/dashes, max 20 chars. */
    static slugify(name) {
        const slug = String(name || '')
            .toLowerCase()
            .replace(/[ıİşŞçÇğĞüÜöÖ]/g, (c) => ({ 'ı': 'i', 'i': 'i', 'ş': 's', 'ç': 'c', 'ğ': 'g', 'ü': 'u', 'ö': 'o' }[c.toLowerCase()] || ''))
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 20);
        return slug || 'instance';
    }

    migrateLegacyDefault(snapshotDir) {
        const legacyPath = path.join(this.baseDir, 'default');
        if (!fs.existsSync(legacyPath)) return;
        const configFile = path.join(legacyPath, 'instance.json');
        if (!fs.existsSync(configFile)) return; // stray empty folder - ignore

        let legacyCfg = null;
        try { legacyCfg = JSON.parse(fs.readFileSync(configFile, 'utf-8')); } catch (_) { return; }

        // Historical quirk: a "fabric 1.21.1" with no loader version could never launch.
        if (legacyCfg.loaderType === 'fabric' && legacyCfg.version === '1.21.1' && legacyCfg.loaderVersion == null) {
            legacyCfg = { ...legacyCfg, loaderType: 'vanilla', loaderVersion: null };
        }

        const name = legacyCfg.name || 'My First Instance';
        const newId = `default-${crypto.randomBytes(2).toString('hex')}`;
        const dir = path.join(this.baseDir, newId);

        try {
            fs.renameSync(legacyPath, dir);
            const cfg = {
                ...legacyCfg,
                id: newId,
                migratedFrom: 'default',
                migratedAt: new Date().toISOString()
            };
            fs.writeFileSync(path.join(dir, 'instance.json'), JSON.stringify(cfg, null, 2));
            // Snapshot manifests are keyed by instance id next to the store.
            try {
                const snapFile = path.join(snapshotDir, 'default.json');
                if (fs.existsSync(snapFile)) fs.renameSync(snapFile, path.join(snapshotDir, `${newId}.json`));
            } catch (_) {}
            console.log(`[InstanceManager] Migrated legacy default instance to "${newId}" (${name})`);
        } catch (e) {
            console.error('[InstanceManager] legacy migration failed:', e.message);
        }
    }

    exists(id) {
        return InstanceManager.isValidId(id) && fs.existsSync(path.join(this.baseDir, id, 'instance.json'));
    }

    assertValid(id) {
        if (!InstanceManager.isValidId(id)) throw new Error(`Invalid instance id "${id}"`);
        if (!fs.existsSync(path.join(this.baseDir, id))) throw new Error(`Instance "${id}" does not exist`);
        return true;
    }

    _makeDirs(instancePath) {
        for (const sub of ['mods', 'saves', 'resourcepacks', 'config']) {
            fs.mkdirSync(path.join(instancePath, sub), { recursive: true });
        }
    }

    _generateId(name) {
        const slug = InstanceManager.slugify(name);
        let id = `${slug}-${crypto.randomBytes(2).toString('hex')}`;
        while (fs.existsSync(path.join(this.baseDir, id))) {
            id = `${slug}-${crypto.randomBytes(2).toString('hex')}`;
        }
        return id;
    }

    /**
     * Create an instance. Signature (v2): a single object —
     *   { name, mcVersion, loaderType, loaderVersion }
     * Returns the created config (with the generated id).
     */
    createInstance(opts = {}) {
        const name = String(opts.name || '').trim().slice(0, 60) || 'New Instance';
        const id = this._generateId(name);
        const instancePath = path.join(this.baseDir, id);

        fs.mkdirSync(instancePath, { recursive: true });
        this._makeDirs(instancePath);

        const config = {
            id,
            name,
            version: opts.mcVersion || '1.21.1',
            loaderType: ['vanilla', 'fabric', 'quilt', 'neoforge', 'forge'].includes(opts.loaderType) ? opts.loaderType : 'vanilla',
            loaderVersion: opts.loaderVersion || null,
            createdAt: new Date().toISOString(),
            lastPlayedAt: null,
            playtimeSeconds: 0
        };

        fs.writeFileSync(path.join(instancePath, 'instance.json'), JSON.stringify(config, null, 2));
        return config;
    }

    listInstances() {
        this.ensureBaseDirectory();
        const entries = fs.readdirSync(this.baseDir);
        const instances = [];
        for (const entry of entries) {
            if (!InstanceManager.isValidId(entry)) continue;
            const configFile = path.join(this.baseDir, entry, 'instance.json');
            if (!fs.existsSync(configFile)) continue;
            try {
                instances.push(JSON.parse(fs.readFileSync(configFile, 'utf-8')));
            } catch (e) {
                console.error(`Failed to read instance config for ${entry}:`, e.message);
            }
        }
        return instances;
    }

    getInstance(id) {
        if (!InstanceManager.isValidId(id)) return null;
        const configFile = path.join(this.baseDir, id, 'instance.json');
        if (fs.existsSync(configFile)) {
            try { return JSON.parse(fs.readFileSync(configFile, 'utf-8')); } catch (_) { return null; }
        }
        return null;
    }

    /** Strict: throws for invalid OR unknown ids (no silent fallbacks in v2). */
    getInstanceGameDir(id) {
        this.assertValid(id);
        return path.join(this.baseDir, id);
    }

    /** Same as getInstanceGameDir but tolerant about EXISTENCE (for setup flows). */
    getInstanceDirMaybe(id) {
        if (!InstanceManager.isValidId(id)) throw new Error(`Invalid instance id "${id}"`);
        return path.join(this.baseDir, id);
    }

    /**
     * Copy an entire instance folder (saves, mods, configs…) to a fresh id.
     */
    duplicateInstance(id, newName = '') {
        const sourceCfg = this.getInstance(id);
        if (!sourceCfg) throw new Error(`Instance "${id}" does not exist`);
        const name = String(newName || '').trim().slice(0, 60) || `${sourceCfg.name} (copy)`;
        const newId = this._generateId(name);
        const dest = path.join(this.baseDir, newId);

        fs.cpSync(path.join(this.baseDir, id), dest, { recursive: true });
        const cfg = {
            ...JSON.parse(fs.readFileSync(path.join(dest, 'instance.json'), 'utf-8')),
            id: newId,
            name,
            createdAt: new Date().toISOString(),
            duplicatedFrom: id
        };
        fs.writeFileSync(path.join(dest, 'instance.json'), JSON.stringify(cfg, null, 2));
        return cfg;
    }

    /** Rename changes the DISPLAY name only - the id is permanent. */
    renameInstance(id, newName) {
        const cfg = this.getInstance(id);
        if (!cfg) throw new Error(`Instance "${id}" does not exist`);
        cfg.name = String(newName || '').trim().slice(0, 60) || cfg.name;
        fs.writeFileSync(path.join(this.baseDir, id, 'instance.json'), JSON.stringify(cfg, null, 2));
        return cfg;
    }

    deleteInstance(id) {
        if (!InstanceManager.isValidId(id)) throw new Error(`Invalid instance id "${id}"`);
        const instancePath = path.join(this.baseDir, id);
        if (fs.existsSync(instancePath)) {
            fs.rmSync(instancePath, { recursive: true, force: true });
            return true;
        }
        return false;
    }
}

module.exports = InstanceManager;
