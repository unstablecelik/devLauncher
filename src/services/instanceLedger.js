const fs = require('fs');
const path = require('path');

// ── Instance ledger / Mod Time Machine ──────────────────────────────────────
// Every mod mutation (install / update / remove / enable / disable / crash
// autofix) is appended as one line of JSON to the instance ledger. Binary
// content from install/update is mirrored into the ObjectStore first so any
// change can be undone later even after the file itself is deleted.
//
// Entry shape:
//   { id, ts, txnId?: string, op, target: 'mods/…', sha1?: string,
//     prevSha1?: string, note?: string }
//
// Ops:
//   install  — file added            (sha1 = added version)
//   update   — file replaced        (sha1 = new, prevSha1 = old)
//   remove   — file deleted          (sha1 = removed version)
//   enable   — <.disabled> suffix cleared
//   disable  — <.disabled> suffix appended
//   autofix  — metadata for crash-based fixes (no file op of its own)

const OPS = ['install', 'update', 'remove', 'enable', 'disable', 'autofix'];

class InstanceLedger {
    constructor(objectStore) {
        this.objectStore = objectStore;
        this._seq = {}; // per-instance monotonic counters
    }

    ledgerPath(instanceDir) {
        return path.join(instanceDir, 'ledger.jsonl');
    }

    // ── Recording ───────────────────────────────────────────────────────────
    record(instanceId, instanceDir, op, target, { sha1, prevSha1, txnId, note } = {}) {
        if (!OPS.includes(op)) throw new Error(`Unknown ledger op "${op}"`);
        const entry = {
            id: this._nextId(instanceId),
            ts: new Date().toISOString(),
            op,
            target: String(target),
            sha1: sha1 || undefined,
            prevSha1: prevSha1 || undefined,
            txnId: txnId || undefined,
            note: note || undefined
        };
        this._appendEntry(this.ledgerPath(instanceDir), entry);
        return entry;
    }

    _nextId(instanceId) {
        const n = (this._seq[instanceId] || 0) + 1;
        this._seq[instanceId] = n;
        return `${instanceId}-${String(n).padStart(6, '0')}-${Date.now().toString(36)}`;
    }

    _appendEntry(ledgerFile, entry) {
        const dir = path.dirname(ledgerFile);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(ledgerFile, JSON.stringify(entry) + '\n');
    }

    // ── High-level flows (store + record together) ──────────────────────────
    // New jar appears. Stashes the content in the store.
    recordInstall(instanceId, instanceDir, modsDir, filename, { txnId, note } = {}) {
        const relative = this._modsRelative(filename);
        const abs = path.join(modsDir, filename);
        const sha1 = this.objectStore.putFile(abs, `${instanceId}:${relative}`);
        return this.record(instanceId, instanceDir, 'install', relative, { sha1, txnId, note });
    }

    /**
     * Call BEFORE overwriting an existing jar with a new build.
     * Returns the sha1 of the current content (the rollback target).
     */
    stashBeforeUpdate(instanceId, modsDir, filename) {
        const relative = this._modsRelative(filename);
        const abs = path.join(modsDir, filename);
        if (!fs.existsSync(abs)) return null;
        return this.objectStore.putFile(abs, `${instanceId}:${relative}`);
    }

    /**
     * Call AFTER the new jar is written. prevSha1 comes from stashBeforeUpdate.
     */
    recordUpdate(instanceId, instanceDir, modsDir, filename, { prevSha1, txnId, note } = {}) {
        const relative = this._modsRelative(filename);
        const abs = path.join(modsDir, filename);
        const sha1 = this.objectStore.putFile(abs, `${instanceId}:${relative}`);
        return this.record(instanceId, instanceDir, 'update', relative, {
            sha1, prevSha1: prevSha1 || undefined, txnId, note
        });
    }

    // File deletion, transactional: stash content into the store first, then
    // unlink, then record — so a removal is always recoverable.
    recordRemove(instanceId, instanceDir, modsDir, filename, { txnId, note } = {}) {
        const relative = this._modsRelative(filename);
        const abs = path.join(modsDir, filename);
        let sha1 = null;
        if (fs.existsSync(abs)) {
            sha1 = this.objectStore.putFile(abs, `${instanceId}:${relative}`);
            fs.unlinkSync(abs);
        }
        return this.record(instanceId, instanceDir, 'remove', relative, { sha1: sha1 || undefined, txnId, note });
    }

    /**
     * Toggle enable/disable, transactional. Performs the rename itself:
     *   'x.jar'          → 'x.jar.disabled'  (op: disable)
     *   'x.jar.disabled' → 'x.jar'           (op: enable)
     */
    recordToggle(instanceId, instanceDir, modsDir, filename, { txnId } = {}) {
        const relative = this._modsRelative(filename);
        const abs = path.join(modsDir, filename);
        if (!fs.existsSync(abs)) throw new Error(`File not found: ${filename}`);
        let op, to;
        if (filename.endsWith('.jar.disabled')) {
            op = 'enable'; to = filename.replace(/\.disabled$/, '');
        } else if (filename.endsWith('.jar')) {
            op = 'disable'; to = filename + '.disabled';
        } else {
            throw new Error(`Not a toggleable mod file: ${filename}`);
        }
        fs.renameSync(abs, path.join(modsDir, to));
        return this.record(instanceId, instanceDir, op, relative, { txnId });
    }

    _modsRelative(filename) {
        return `mods/${path.basename(String(filename))}`;
    }

    // ── History & rollback ──────────────────────────────────────────────────
    history(instanceDir, limit = 100) {
        const file = this.ledgerPath(instanceDir);
        if (!fs.existsSync(file)) return [];
        const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
        const entries = lines.map(l => {
            try { return JSON.parse(l); } catch (_) { return null; }
        }).filter(Boolean);
        // latest first
        return entries.reverse().slice(0, limit);
    }

    findEntry(instanceDir, entryIdOrTxnId) {
        const head = this.history(instanceDir, 5000);
        return head.find(e => e.id === entryIdOrTxnId || e.txnId === entryIdOrTxnId) || null;
    }

    /**
     * Undo a single entry by id. `modsDir` is the instance mods directory.
     * Returns a human-readable result; new committed entries are made for any
     * file mutation so the timeline stays truthful (and re-dittable).
     */
    rollbackEntry(instanceId, instanceDir, entryId) {
        const entry = this.findEntry(instanceDir, entryId);
        if (!entry) return { success: false, error: 'Entry not found (already rolled back or too old)' };

        const modsDir = path.join(instanceDir, 'mods');
        const plainName = path.basename(entry.target).replace(/\.disabled$/, '');
        const plainPath = path.join(modsDir, plainName);
        const disabledPath = plainPath + '.disabled';
        const activeName = fs.existsSync(plainPath) ? plainName
            : (fs.existsSync(disabledPath) ? plainName + '.disabled' : null);

        switch (entry.op) {
            case 'install':
            case 'update': {
                // Remove the added/new content, restore previous version if known
                if (activeName) fs.unlinkSync(path.join(modsDir, activeName));
                if (entry.sha1) this.objectStore.dropRef(entry.sha1, `${instanceId}:${entry.target}`);
                if (entry.prevSha1 && this.objectStore.has(entry.prevSha1)) {
                    this.objectStore.materialize(entry.prevSha1, plainPath, `${instanceId}:${entry.target}`);
                    this.record(instanceId, instanceDir, 'update', entry.target, {
                        sha1: entry.prevSha1, prevSha1: entry.sha1, note: `rollback of ${entry.id}`
                    });
                    return { success: true, action: 'reverted-to-previous', file: plainName };
                }
                this.record(instanceId, instanceDir, 'remove', entry.target, { note: `rollback of ${entry.id}` });
                return { success: true, action: 'removed', file: plainName };
            }
            case 'remove': {
                if (activeName) return { success: false, error: `"${plainName}" still exists on disk` };
                if (!entry.sha1 || !this.objectStore.has(entry.sha1)) {
                    return { success: false, error: 'Original content not retained (deleted before it was backed up)' };
                }
                this.objectStore.materialize(entry.sha1, plainPath, `${instanceId}:${entry.target}`);
                this.record(instanceId, instanceDir, 'install', entry.target, { sha1: entry.sha1, note: `rollback of ${entry.id}` });
                return { success: true, action: 'restored', file: plainName };
            }
            case 'enable': {
                if (activeName !== plainName) return { success: false, error: `"${plainName}" is not currently present as-is` };
                fs.renameSync(plainPath, disabledPath);
                this.record(instanceId, instanceDir, 'disable', entry.target, { note: `undo of ${entry.id}` });
                return { success: true, action: 'disabled', file: plainName };
            }
            case 'disable': {
                if (activeName !== plainName + '.disabled') return { success: false, error: `"${plainName}" is not currently in the disabled state` };
                fs.renameSync(disabledPath, plainPath);
                this.record(instanceId, instanceDir, 'enable', entry.target, { note: `undo of ${entry.id}` });
                return { success: true, action: 'enabled', file: plainName };
            }
            case 'autofix':
            default:
                return { success: false, error: `Op "${entry.op}" has no file-level undo` };
        }
    }

    // Undo an entire transaction (e.g. a Performance Pack or one "update all")
    rollbackTxn(instanceId, instanceDir, txnId) {
        const head = this.history(instanceDir, 5000);
        const txnEntries = head.filter(e => e.txnId === txnId);
        if (txnEntries.length === 0) return { success: false, error: 'Transaction not found' };
        const results = [];
        // newest-first, so a multi-file txn yields the same state as before
        for (const entry of txnEntries) {
            const r = this.rollbackEntry(instanceId, instanceDir, entry.id);
            results.push({ id: entry.id, ...r });
        }
        return {
            success: true,
            rolledBack: results.filter(r => r.success).length,
            failed: results.filter(r => !r.success),
            results
        };
    }
}
module.exports = InstanceLedger;
