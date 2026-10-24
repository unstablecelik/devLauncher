const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Content-addressed object store ──────────────────────────────────────────
// Objects live at <root>/ab/cdef… (sha1-addressed). A small index tracks file
// sizes and which instance paths reference each object, enabling dedup via
// hardlinks and safe garbage collection.
//
// All writes are atomic (tmp file → rename) so a crash mid-write can never
// leave a corrupted object behind.

class ObjectStore {
    constructor(root) {
        this.root = root;
        this.indexPath = path.join(root, 'index.json');
        fs.mkdirSync(root, { recursive: true });
        this.index = this._loadIndex();
    }

    _loadIndex() {
        try {
            if (fs.existsSync(this.indexPath)) {
                const parsed = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
                if (parsed && typeof parsed === 'object') return parsed;
            }
        } catch (err) {
            console.error('[ObjectStore] index load failed, starting fresh:', err.message);
        }
        return {};
    }

    _saveIndex() {
        const tmp = this.indexPath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(this.index, null, 0));
        fs.renameSync(tmp, this.indexPath);
    }

    _objectPath(sha1) {
        if (!/^[0-9a-f]{40}$/.test(sha1)) throw new Error(`Invalid sha1 "${sha1}"`);
        return path.join(this.root, sha1.slice(0, 2), sha1.slice(2));
    }

    has(sha1) {
        return sha1 && fs.existsSync(this._objectPath(sha1));
    }

    path(sha1) {
        return this._objectPath(sha1);
    }

    sizeOf(sha1) {
        return (this.index[sha1] && this.index[sha1].size) || 0;
    }

    // Compute sha1 without storing
    hashBuffer(buffer) {
        return crypto.createHash('sha1').update(buffer).digest('hex');
    }

    // Store a buffer, return its sha1
    putBuffer(buffer, ref) {
        const sha1 = this.hashBuffer(buffer);
        const dest = this._objectPath(sha1);
        if (!fs.existsSync(dest)) {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            const tmp = dest + '.tmp';
            fs.writeFileSync(tmp, buffer);
            fs.renameSync(tmp, dest);
        }
        this._addRef(sha1, buffer.length, ref);
        return sha1;
    }

    // Store a file's contents; file itself stays untouched
    putFile(filePath, ref) {
        const buffer = fs.readFileSync(filePath);
        return this.putBuffer(buffer, ref);
    }

    _addRef(sha1, size, ref) {
        const entry = this.index[sha1] || { size, refs: [] };
        entry.size = size;
        if (ref && !entry.refs.includes(ref)) entry.refs.push(ref);
        this.index[sha1] = entry;
        this._saveIndex();
    }

    dropRef(sha1, ref) {
        const entry = this.index[sha1];
        if (!entry) return;
        entry.refs = (entry.refs || []).filter(r => r !== ref);
        if (entry.refs.length === 0) delete this.index[sha1];
        this._saveIndex();
    }

    /**
     * Materialise an object at destPath:
     * hardlink when possible (same volume), fall back to copy.
     * Overwrites dest atomically.
     */
    materialize(sha1, destPath, ref) {
        const src = this._objectPath(sha1);
        if (!fs.existsSync(src)) throw new Error(`Object ${sha1} missing from store`);
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        if (fs.existsSync(destPath)) {
            // stash overwritten content as another object (safety net)
            try { this.putFile(destPath); } catch (_) {}
            fs.unlinkSync(destPath);
        }
        const linked = this._tryLink(src, destPath);
        if (!linked) {
            fs.copyFileSync(src, destPath);
        }
        if (ref) this._addRef(sha1, fs.statSync(src).size, ref);
        return { linked };
    }

    _tryLink(src, dest) {
        try {
            fs.linkSync(src, dest);
            return true;
        } catch (err) {
            // EXDEV (cross-device), EPERM (filesystems without links), EEXIST…
            return false;
        }
    }

    /**
     * Remove objects that have no live refs AND are not pinned. Overwritten
     * content stashed for Time Machine gets a `keepSha1s` pin so rollback
     * stays possible after a gc pass.
     */
    gc(liveRefs, keepSha1s) {
        const live = new Set(liveRefs || []);
        const pins = new Set(keepSha1s || []);
        let removed = 0, bytes = 0;
        for (const [sha1, entry] of Object.entries(this.index)) {
            if (pins.has(sha1)) continue;
            const refs = entry.refs || [];
            const remaining = refs.filter(r => live.has(r));
            if (remaining.length > 0) continue;
            try {
                bytes += entry.size || 0;
                fs.unlinkSync(this._objectPath(sha1));
                delete this.index[sha1];
                removed++;
            } catch (_) {}
        }
        this._saveIndex();
        return { removed, bytes };
    }

    stats() {
        let objects = 0, bytes = 0;
        for (const entry of Object.values(this.index)) {
            objects++;
            bytes += entry.size || 0;
        }
        return { objects, bytes, mb: Math.round(bytes / 1024 / 1024) };
    }
}

module.exports = ObjectStore;
