const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── World Preview (v1) ──────────────────────────────────────────────────────
// Renders a simple top-down preview of the spawn area directly from the world's
// region data - no external libraries: .mca region header → chunk bytes (zlib)
// → minimal NBT walk (skipping huge block_states payloads) → 9-bit heightmap
// longs → 16x16 color grid. level.dat (gzip NBT) provides world stats.
// Honest limits: stylized heightmap colors (not biome-accurate), 1.14+ chunks.

const T_END = 0, T_BYTE = 1, T_SHORT = 2, T_INT = 3, T_LONG = 4, T_FLOAT = 5,
      T_DOUBLE = 6, T_BYTEARR = 7, T_STRING = 8, T_LIST = 9, T_COMPOUND = 10,
      T_INTARR = 11, T_LONGARR = 12;

class WorldPreview {
    // ── region file access ──────────────────────────────────────────────────
    static regionFileFor(regionDir, spawnX, spawnZ) {
        if (!fs.existsSync(regionDir)) return null;
        const files = fs.readdirSync(regionDir).filter(f => f.startsWith('r.') && f.endsWith('.mca'));
        if (files.length === 0) return null;
        if (spawnX != null && spawnZ != null) {
            const rx = Math.floor(spawnX / 512), rz = Math.floor(spawnZ / 512);
            const exact = files.find(f => f === `r.${rx}.${rz}.mca`);
            if (exact) return exact;
        }
        // newest region file wins otherwise (mtime)
        let best = files[0], bestM = -1;
        for (const f of files) {
            const m = fs.statSync(path.join(regionDir, f)).mtimeMs;
            if (m > bestM) { bestM = m; best = f; }
        }
        return best;
    }

    static chunkAt(buf, rx, rz, cx, cz) {
        const lx = cx & 31, lz = cz & 31;
        const idx = (lx + lz * 32) * 4;
        if (idx + 4 > 4096) return null;
        const b3 = buf.readUIntBE(idx, 3); // 24-bit sector offset (first 3 bytes)
        const sectorCount = buf.readUInt8(idx + 3);
        if (b3 === 0 || sectorCount === 0) return null;
        const off = b3 * 4096;
        if (off + 5 > buf.length) return null;
        const length = buf.readUInt32BE(off);
        const compression = buf.readUInt8(off + 4);
        const body = buf.slice(off + 5, off + 4 + length);
        if (compression === 1) return zlib.gunzipSync(body);
        if (compression === 2) return zlib.inflateSync(body);
        return compression === 3 ? body : null; // 3 = uncompressed
    }

    /** first chunk with data in a region buffer */
    static firstChunk(buf) {
        for (let i = 0; i < 1024; i++) {
            const off = buf.readUIntBE(i * 4, 3);
            if (off !== 0) {
                try {
                    if (buf.readUInt32BE(off * 4096) > 0) {
                        const length = buf.readUInt32BE(off * 4096);
                        const compression = buf.readUInt8(off * 4096 + 4);
                        const body = buf.slice(off * 4096 + 5, off * 4096 + 4 + length);
                        if (compression === 1) return zlib.gunzipSync(body);
                        if (compression === 2) return zlib.inflateSync(body);
                        if (compression === 3) return body;
                    }
                } catch (_) { /* try next */ }
            }
        }
        return null;
    }

    // ── NBT (minimal, slotted for huge chunk payloads) ───────────────────────
    /** Generic NBT parse. Long arrays stay raw unless parent name === captureParent. */
    static parseNbtBytes(buf) {
        const L = buf.length;
        const names = [];
        let pos = 0;
        const u8 = () => buf.readUInt8(pos++);
        const s2 = (p) => buf.readInt16BE(p);
        const s4 = (p) => buf.readInt32BE(p);
        const sd4 = (p) => buf.readFloatBE(p);
        const s8d = (p) => buf.readDoubleBE(p);

        function str() {
            const len = s2(pos); pos += 2;
            if (len < 0 || pos + len > L) throw new Error('NBT: bad string length');
            const s = buf.slice(pos, pos + len).toString('utf8'); pos += len;
            return s;
        }
        function skipArray(count, width) { pos += count * width; }
        function skipPayload(type, parentName) {
            switch (type) {
                case T_BYTE: pos += 1; break;
                case T_SHORT: pos += 2; break;
                case T_INT: case T_FLOAT: pos += 4; break;
                case T_LONG: case T_DOUBLE: pos += 8; break;
                case T_BYTEARR: { const n = s4(pos); pos += 4 + n; break; }
                case T_STRING: str(); break;
                case T_LIST: {
                    const item = u8(); const n = s4(pos); pos += 4;
                    if (n > 0 && item !== T_END) for (let i = 0; i < n; i++) skipPayload(item, parentName);
                    break;
                }
                case T_COMPOUND: {
                    for (;;) {
                        const t = u8();
                        if (t === T_END) break;
                        const name = str();
                        skipPayload(t, name);
                    }
                    break;
                }
                case T_INTARR: { const n = s4(pos); pos += 4 + n * 4; break; }
                case T_LONGARR: { const n = s4(pos); pos += 4 + n * 8; break; }
                default: throw new Error(`NBT: unknown tag ${type}`);
            }
        }
        // Capture-enabled payload: returns value or null when purely skipped
        function payload(type, parentName, captureParent) {
            if (type === T_LONGARR && captureParent) {
                const n = s4(pos); pos += 4;
                if (n > L) throw new Error('NBT: bad long array');
                const data = new Uint32Array(n * 2); // [hi, lo] per long
                for (let i = 0; i < n; i++) {
                    data[i * 2] = buf.readUInt32BE(pos);
                    data[i * 2 + 1] = buf.readUInt32BE(pos + 4);
                    pos += 8;
                }
                return { type: T_LONGARR, count: n, data };
            }
            const before = pos;
            skipPayload(type, parentName);
            const span = { start: before, end: pos };
            switch (type) {
                case T_BYTE: return { type, value: buf[before] };
                case T_SHORT: return { type, value: s2(before) };
                case T_INT: return { type, value: s4(before) };
                case T_LONG: return { type, value: null };
                case T_FLOAT: return { type, value: sd4(before) };
                case T_DOUBLE: return { type, value: s8d(before) };
                case T_STRING: {
                    pos = before; // replay decode after skip
                    return { type, value: str() };
                }
                case T_BYTEARR: case T_INTARR: return { type, value: null };
                default: return { type, span, value: null };
            }
        }
        function compound(parentName) {
            const obj = {};
            for (;;) {
                const t = u8();
                if (t === T_END) break;
                const name = str();
                if (t === T_COMPOUND) {
                    obj[name] = compound(name);
                } else {
                    obj[name] = payload(t, name, parentName === 'Heightmaps');
                }
            }
            return obj;
        }
        const rootType = u8();
        if (rootType !== T_COMPOUND) throw new Error('NBT: root must be a compound');
        str(); // root empty name
        return compound(null);
    }

    /** 9-bit-packed heightmap (256 entries, contiguous across longs) from a captured long array. */
    static unpackHeightmap(longArray) {
        if (!longArray || longArray.type !== T_LONGARR) return null;
        const n = longArray.count;
        // Flatten [hi,lo] big-endian longs into one byte stream; MC packs bits
        // LSB-first per long and lets entries span across long boundaries.
        const bytes = new Uint8Array(n * 8);
        for (let i = 0; i < n; i++) {
            const hi = longArray.data[i * 2], lo = longArray.data[i * 2 + 1];
            bytes[i * 8] = (hi >>> 24) & 0xff;
            bytes[i * 8 + 1] = (hi >>> 16) & 0xff;
            bytes[i * 8 + 2] = (hi >>> 8) & 0xff;
            bytes[i * 8 + 3] = hi & 0xff;
            bytes[i * 8 + 4] = (lo >>> 24) & 0xff;
            bytes[i * 8 + 5] = (lo >>> 16) & 0xff;
            bytes[i * 8 + 6] = (lo >>> 8) & 0xff;
            bytes[i * 8 + 7] = lo & 0xff;
        }
        const out = new Uint16Array(256);
        let bitPos = 0;
        const readBits = (width) => {
            let v = 0;
            for (let k = 0; k < width; k++) {
                v |= (((bytes[bitPos >> 3] >>> (bitPos & 7)) & 1) << k);
                bitPos++;
            }
            return v;
        };
        for (let i = 0; i < 256; i++) out[i] = readBits(9);
        return out;
    }

    static colorsFromHeights(heights) {
        const stops = WorldPreview.STOPS;
        return Array.from(heights, h => {
            if (h <= stops[0].h) return stops[0].c;
            for (let i = 0; i < stops.length - 1; i++) {
                const a = stops[i], b = stops[i + 1];
                if (h <= b.h) {
                    return a.c; // step colors (fast, stylized); gradients reserved for canvas renderer
                }
            }
            return stops[stops.length - 1].c;
        });
    }
    static get STOPS() {
        return [
            { h: 45, c: '#1d3f66' },   // deep water / valleys
            { h: 62, c: '#2d5f8a' },   // water surface in world coords
            { h: 70, c: '#24543a' },   // shore / grass
            { h: 90, c: '#3b7a3f' },   // lowlands
            { h: 115, c: '#56663c' },  // hills
            { h: 145, c: '#8b8a6a' },  // highlands
            { h: 190, c: '#a9a89b' },  // mountains
            { h: 400, c: '#eef3f4' }   // peaks
        ];
    }

    /** Spawn-area 16x16 preview heights + colors from a world's region dir. */
    static previewSpawn(worldDir) {
        const regionDir = path.join(worldDir, 'region');
        const level = WorldPreview.readLevelDat(worldDir);
        const spawnX = level && level.SpawnX != null ? level.SpawnX : null;
        const spawnZ = level && level.SpawnZ != null ? level.SpawnZ : null;
        const regionFile = WorldPreview.regionFileFor(regionDir, spawnX, spawnZ);
        if (!regionFile) return { ok: false, error: 'No region files found in this world (it may have never been saved/opened an area).' };
        let buf;
        try { buf = fs.readFileSync(path.join(regionDir, regionFile)); } catch (err) { return { ok: false, error: err.message }; }
        let chunk;
        if (spawnX != null && spawnZ != null) {
            chunk = WorldPreview.chunkAt(buf, Math.floor(spawnX / 512), Math.floor(spawnZ / 512), Math.floor(spawnX / 16), Math.floor(spawnZ / 16));
        }
        if (!chunk) chunk = WorldPreview.firstChunk(buf);
        if (!chunk) return { ok: false, error: 'No stored chunks in the target region yet.' };
        try {
            const tree = WorldPreview.parseNbtBytes(chunk);
            const hm = tree && tree.Heightmaps;
            const motion = WorldPreview.unpackHeightmap(hm && hm.MOTION_BLOCKING);
            const surface = WorldPreview.unpackHeightmap(hm && hm.WORLD_SURFACE);
            const heights = motion || surface;
            if (!heights) return { ok: false, error: 'This chunk predates 1.14 heightmaps - preview unavailable.' };
            return { ok: true, regionFile, heights: Array.from(heights), colors: WorldPreview.colorsFromHeights(heights), stats: level };
        } catch (err) {
            return { ok: false, error: `NBT parse failed: ${err.message}` };
        }
    }

    // ── level.dat stats ─────────────────────────────────────────────────────
    static readLevelDat(worldDir) {
        const p = path.join(worldDir, 'level.dat');
        if (!fs.existsSync(p)) return null;
        try {
            const raw = zlib.gunzipSync(fs.readFileSync(p));
            const tree = WorldPreview.parseNbtBytes(raw);
            const data = tree && tree.Data;
            if (!data) return null;
            const intValue = (x) => x && x.type === T_INT ? x.value : null;
            return {
                LevelName: data.LevelName && data.LevelName.value != null ? data.LevelName.value : null,
                GameType: intValue(data.GameType),
                SpawnX: intValue(data.SpawnX),
                SpawnY: intValue(data.SpawnY),
                SpawnZ: intValue(data.SpawnZ),
                Difficulty: data.Difficulty && data.Difficulty.value != null ? data.Difficulty.value : null,
                version: data.Version && data.Version.Name && data.Version.Name.value ? data.Version.Name.value : null
            };
        } catch (_) {
            return null;
        }
    }

    /** List playable worlds for an instance. */
    static listWorlds(savesDir) {
        if (!fs.existsSync(savesDir)) return [];
        return fs.readdirSync(savesDir).filter(name =>
            fs.existsSync(path.join(savesDir, name, 'level.dat')) && fs.statSync(path.join(savesDir, name)).isDirectory()
        ).map(name => {
            let dirSize = 0;
            try {
                dirSize = fs.readdirSync(path.join(savesDir, name)).reduce((acc, f) => {
                    try { return acc + fs.statSync(path.join(savesDir, name, f)).size; } catch (_) { return acc; }
                }, 0);
            } catch (_) {}
            return { name, dirSize, stats: WorldPreview.readLevelDat(path.join(savesDir, name)) };
        });
    }
}

module.exports = WorldPreview;
module.exports.T_INT = T_INT;
module.exports.T_STRING = T_STRING;
module.exports.T_LONGARR = T_LONGARR;
module.exports.T_COMPOUND = T_COMPOUND;
