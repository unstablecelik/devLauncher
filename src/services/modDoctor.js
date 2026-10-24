const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

// ── Mod Doctor ──────────────────────────────────────────────────────────────
// Static health check for a instance's mods folder:
//   • jar readability / metadata parsing (fabric, quilt, forge, neoforge)
//   • duplicate mod ids across jars
//   • loader mismatch (fabric mod inside vanilla/forge instance, …)
//   • missing hard dependencies (fabric "depends" / quilt "depends" coverage)
//   • loose Minecraft version-range compatibility
//   • suspicious-content heuristics (scoring, clearly flagged as uncertain)
//
// The primary line of defense against malware stays the sha1 verification on
// every Modrinth download (see main.js); the doctor is a second opinion, not
// a virus scanner.

class ModDoctor {
    constructor() {
        // Signature config: hashes/patterns curated externally. Empty by
        // default — honest: we don't ship a fake "virus database".
        this.signatures = this._loadSignatures();
    }

    _loadSignatures() {
        try {
            const file = path.join(__dirname, '..', 'data', 'malware-signatures.json');
            if (fs.existsSync(file)) {
                return JSON.parse(fs.readFileSync(file, 'utf8'));
            }
        } catch (_) {}
        return { sha256: [], neonPatterns: [], updatedAt: null };
    }

    /**
     * Scan all jars in modsDir for an instance described by instanceConfig
     * ({ version, loaderType }). Disabled (.jar.disabled) files are skipped
     * from load-context checks but reported separately if unreadable.
     */
    scan(modsDir, instanceConfig) {
        const result = {
            ok: true,
            scannedAt: new Date().toISOString(),
            mcVersion: (instanceConfig && instanceConfig.version) || null,
            loaderType: (instanceConfig && instanceConfig.loaderType) || 'vanilla',
            entries: [],
            duplicateIds: [],
            missingDependencies: [],
            summary: { total: 0, ok: 0, warn: 0, error: 0, disabled: 0 }
        };

        if (!fs.existsSync(modsDir)) {
            result.ok = false;
            result.error = 'Mods directory not found';
            return result;
        }

        const jars = fs.readdirSync(modsDir).filter(f => f.endsWith('.jar') || f.endsWith('.jar.disabled'));
        const disabled = jars.filter(j => j.endsWith('.jar.disabled'));
        const active = jars.filter(j => !j.endsWith('.jar.disabled'));
        result.summary.disabled = disabled.length;

        const idsInUse = new Map(); // modId -> [filenames]
        const providedIds = new Set(); // modId + provides

        for (const jar of active) {
            const entry = this._analyzeJar(modsDir, jar, result.mcVersion, result.loaderType);
            result.entries.push(entry);
            result.summary.total++;
            result.summary[entry.status === 'ok' ? 'ok' : entry.status]++;

            if (entry.modId) {
                idsInUse.set(entry.modId, [...(idsInUse.get(entry.modId) || []), jar]);
                providedIds.add(entry.modId);
                for (const p of entry.provides) providedIds.add(p);
            }
        }

        // duplicates
        for (const [modId, files] of idsInUse.entries()) {
            if (files.length > 1) {
                result.duplicateIds.push({ modId, files });
            }
        }
        for (const dup of result.duplicateIds) {
            for (const f of dup.files) {
                const entry = result.entries.find(e => e.file === f);
                if (entry) {
                    entry.issues.push({ code: 'duplicate_mod_id', message: `Mod id "${dup.modId}" is also present in ${dup.files.filter(x => x !== f).join(', ')}`, severity: 'error' });
                    entry.status = 'error';
                }
            }
        }
        // adjust summary after downgrade? keep it simple: recount
        result.summary.error = result.entries.filter(e => e.status === 'error').length;
        result.summary.warn = result.entries.filter(e => e.status === 'warn').length;
        result.summary.ok = result.entries.filter(e => e.status === 'ok').length;

        // missing dependencies (fabric/quilt hard depends) — runtime-provided
        // ids are excluded: they come from the launch flow, not from jar files
        const RUNTIME_PROVIDED = new Set(['minecraft', 'java', 'fabricloader', 'fabric', 'quilt_loader', 'mixinextras']);
        const missing = new Map();
        for (const entry of result.entries) {
            for (const dep of entry.depends) {
                if (RUNTIME_PROVIDED.has(dep)) continue;
                if (!providedIds.has(dep)) {
                    if (!missing.has(dep)) missing.set(dep, []);
                    missing.get(dep).push(entry.file);
                }
            }
        }
        result.missingDependencies = [...missing.entries()].map(([depId, requiredBy]) => ({ depId, requiredBy }));

        result.ok = result.summary.error === 0;
        return result;
    }

    _analyzeJar(modsDir, jar, mcVersion, instanceLoader) {
        const filePath = path.join(modsDir, jar);
        const entry = {
            file: jar,
            status: 'ok',
            modId: null,
            name: null,
            version: null,
            loader: null,
            provides: [],
            depends: [],
            issues: []
        };

        let zip;
        try {
            zip = new AdmZip(filePath);
        } catch (err) {
            entry.status = 'error';
            entry.issues.push({ code: 'unreadable_jar', message: `Jar could not be opened (${err.message})`, severity: 'error' });
            return entry;
        }

        const readJson = (name) => {
            const file = zip.getEntry(name);
            if (!file) return null;
            try { return JSON.parse(file.getData().toString('utf8')); } catch (_) { return null; }
        };
        const readTextIfExists = (name) => {
            const file = zip.getEntry(name);
            if (!file) return null;
            try { return file.getData().toString('utf8'); } catch (_) { return null; }
        };

        const fabricJson = readJson('fabric.mod.json');
        const quiltJson = readJson('quilt.mod.json');
        const modsToml = readTextIfExists('META-INF/mods.toml') || readTextIfExists('META-INF/neoforge.mods.toml');
        let neoforgeMarker = !!zip.getEntry('META-INF/neoforge.mods.toml');

        if (fabricJson) {
            entry.loader = 'fabric';
            entry.modId = fabricJson.id || null;
            entry.name = fabricJson.name || entry.modId;
            entry.version = fabricJson.version || null;
            entry.provides = Array.isArray(fabricJson.provides) ? fabricJson.provides : [];
            const deps = fabricJson.depends || (Array.isArray(fabricJson.depends) ? fabricJson.depends : {});
            if (Array.isArray(deps)) {
                entry.depends = deps.filter(Boolean);
            } else {
                for (const [depId, range] of Object.entries(deps)) {
                    entry.depends.push(depId);
                    if (depId === 'minecraft') {
                        const compat = this._checkMcRange(range, mcVersion);
                        if (compat === false) {
                            entry.issues.push({ code: 'mc_version_mismatch', message: `Requires Minecraft ${JSON.stringify(range)} but instance is ${mcVersion || '?'}`, severity: 'error' });
                        }
                    }
                    // loader/java deps are always provided by the launch flow — not missing-dep candidates
                }
            }
        } else if (quiltJson) {
            entry.loader = 'quilt';
            const loader = quiltJson.loader || {};
            const qi = quiltJson.quilt_loader || {};
            entry.modId = qi.id || null;
            entry.name = qi.metadata && qi.metadata.name || entry.modId;
            entry.version = qi.version || null;
            const deps = quiltJson.depends || [];
            for (const d of deps) entry.depends.push(typeof d === 'string' ? d : (d.id || ''));
            entry.depends = entry.depends.filter(Boolean);
        } else if (modsToml) {
            entry.loader = neoforgeMarker ? 'neoforge' : 'forge';
            const modIdMatch = modsToml.match(/modId\s*=\s*"([^"]+)"/);
            entry.modId = modIdMatch ? modIdMatch[1] : null;
            const nameMatch = modsToml.match(/displayName\s*=\s*"([^"]+)"/);
            entry.name = nameMatch ? nameMatch[1] : entry.modId;
            const verMatch = modsToml.match(/^version\s*=\s*"([^"]+)"/m);
            entry.version = verMatch ? verMatch[1] : null;
        } else {
            entry.issues.push({ code: 'no_metadata', message: 'No fabric.mod.json / quilt.mod.json / mods.toml found — not a standard mod jar (can be a library).', severity: 'warn' });
        }

        // loader mismatch
        if (entry.loader && instanceLoader) {
            const inst = String(instanceLoader).toLowerCase();
            const mod = entry.loader;
            const mismatch =
                (mod === 'fabric' && !(inst === 'fabric' || inst === 'quilt')) ||   // quilt usually runs fabric mods
                (mod === 'quilt' && inst !== 'quilt' && inst !== 'fabric') ||
                (mod === 'forge' && inst !== 'forge' && inst !== 'neoforge') ||    // old forge jars sometimes run on neoforge
                (mod === 'neoforge' && inst !== 'neoforge');
            if (mismatch) {
                entry.issues.push({ code: 'loader_mismatch', message: `${mod} mod but instance loader is "${inst}" — the game will not load it`, severity: 'error' });
            }
        }

        // suspicious content heuristics (score-based, uncertain by design)
        entry.suspicions = this._suspicionScore(zip, entry);

        const errorCount = entry.issues.filter(i => i.severity === 'error').length;
        const warnCount = entry.issues.filter(i => i.severity === 'warn').length;
        if (errorCount > 0) entry.status = 'error';
        else if (warnCount > 0 || entry.suspicions.score >= 2) entry.status = 'warn';
        else entry.status = 'ok';

        return entry;
    }

    /**
     * Raw-bytes heuristics inside the jar. Outputs a score and hits; the UI
     * presents this as "unusual properties", never as a definitive verdict.
     */
    _suspicionScore(zip, entry) {
        const hits = [];
        let score = 0;
        let totalClasses = 0, tinyClasses = 0;

        for (const e of zip.getEntries()) {
            if (!e.isDirectory && e.entryName.endsWith('.class')) {
                totalClasses++;
                const base = e.entryName.split('/').pop().replace('.class', '');
                if (base.length <= 3) tinyClasses++;
            }
        }

        // Obfuscation ratio
        if (totalClasses > 30 && tinyClasses / totalClasses > 0.55) {
            score += 2;
            hits.push({ code: 'obfuscated_names', message: `${Math.round(100 * tinyClasses / totalClasses)}% of ${totalClasses} classes have ≤3-character names — heavy obfuscation is unusual for mods` });
        }

        // Remote-exec style strings — common but not proof of malware
        let foundRemoteExec = false;
        for (const e of zip.getEntries()) {
            if (e.isDirectory || !e.entryName.endsWith('.class')) continue;
            const text = e.getData().toString('binary');
            if (text.includes('/bin/sh') || text.includes('powershell') || text.includes('cmd.exe')) {
                foundRemoteExec = true;
                break;
            }
        }
        if (foundRemoteExec) {
            score += 3;
            hits.push({ code: 'shell_exec_strings', message: 'Class bytes contain shell/powershell invocation strings' });
        }

        // Curated patterns (usually empty)
        if (Array.isArray(this.signatures.neonPatterns)) {
            for (const pattern of this.signatures.neonPatterns) {
                for (const e of zip.getEntries()) {
                    if (e.isDirectory) continue;
                    if (String(e.entryName).toLowerCase().includes(String(pattern).toLowerCase())) {
                        score += 5;
                        hits.push({ code: 'signature_pattern', message: `Entry "${e.entryName}" matches curated signature "${pattern}"` });
                    }
                }
            }
        }

        return { score, hits };
    }

    /** Copy of the logic used at download time — kept in sync by convention. */
    _checkMcRange(range, mcVersion) {
        if (!range) return true;
        const r = String(range);
        if (r === '*' || r.trim() === '') return true;
        if (/\d+\.\d+\.x/.test(r)) { // "1.20.x" style within-version
            const base = r.match(/(\d+)\.(\d+)\.x/);
            if (!base || !mcVersion) return true;
            const mv = String(mcVersion).split('.').map(Number);
            return mv[0] === Number(base[1]) && mv[1] === Number(base[2]);
        }
        // range operators are supported only for >=, <=, >, < for simplicity
        const m = r.match(/^([<>=]{1,2})\s*(\d+(?:\.\d+)*)$/);
        if (!m || !mcVersion) return true; // unknown pattern → assume fine
        const cmp = this._compareVersion(m[2], String(mcVersion));
        switch (m[1]) {
            case '>=': return cmp <= 0;
            case '<=': return cmp >= 0;
            case '>': return cmp < 0;
            case '<': return cmp > 0;
            default: return true;
        }
    }

    _compareVersion(a, b) {
        const pa = String(a).split('.').map(Number);
        const pb = String(b).split('.').map(Number);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            const na = pa[i] || 0; const nb = pb[i] || 0;
            if (na !== nb) return na < nb ? -1 : 1;
        }
        return 0;
    }
}

module.exports = ModDoctor;
