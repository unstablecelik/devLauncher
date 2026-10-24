'use strict';
/**
 * Pure-Node tar.gz extractor.
 *
 * The project keeps a no-shell-command posture: archives are unpacked without
 * spawning the `tar` binary. Streams the gunzip output and parses POSIX/GNU
 * tar headers directly.
 *
 * Supported entry types: regular files, directories, GNU long names ('L'),
 * and PAX/global extended headers ('x'/'g', skipped). Path entries containing
 * '..' are rejected to keep extraction inside targetDir.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function sanitizeName(rawName) {
    let name = String(rawName || '').replace(/\\/g, '/');
    while (name.startsWith('./')) name = name.slice(2);
    name = name.replace(/^\/+/, '');
    return name;
}

function partitionName(fullName, stripComponents) {
    const parts = fullName.split('/').filter((p) => p.length > 0);
    if (stripComponents >= parts.length) return null;
    return parts.slice(stripComponents).join('/');
}

function parseOctal(buf) {
    let value = 0;
    for (const byte of buf) {
        if (byte === 0 || byte === 0x20) {
            if (value > 0) break;
            continue;
        }
        if (byte < 0x30 || byte > 0x37) break;
        value = value * 8 + (byte - 0x30);
    }
    return value;
}

function isZeroBlock(buf) {
    for (const byte of buf) {
        if (byte !== 0) return false;
    }
    return true;
}

async function extractTarGz(archivePath, targetDir, opts = {}) {
    const stripComponents = opts.stripComponents || 0;
    fs.mkdirSync(targetDir, { recursive: true });

    const openWriters = [];
    let leftover = Buffer.alloc(0);
    let padSkip = 0;
    let entry = null; // { kind: 'file'|'skip'|'collect', size, bytesLeft, ws, collectId }
    let pendingLongName = null;
    let fatalError = null;

    const stream = fs.createReadStream(archivePath).pipe(zlib.createGunzip());

    function fail(message) {
        fatalError = fatalError || new Error(message);
        stream.destroy();
    }

    function finishEntry() {
        if (entry && entry.ws) {
            entry.ws.end();
        }
        entry = null;
    }

    function startSkip(size) {
        entry = { kind: 'skip', size, bytesLeft: size };
    }

    function startCollect(size, collectId) {
        entry = { kind: 'collect', size, bytesLeft: size, chunks: [], collectId };
    }

    function resolveEntryPath(name, mode) {
        const clean = sanitizeName(name);
        if (!clean) return null;
        const parts = clean.split('/');
        for (const part of parts) {
            if (part === '..') {
                fail(`Unsafe tar entry rejected: ${name}`);
                return null;
            }
        }
        const partitioned = partitionName(clean, stripComponents);
        if (!partitioned) return null;
        return path.join(targetDir, partitioned);
    }

    function parseHeader(header) {
        const nameBuf = header.subarray(0, 100);
        let name = sanitizeName(nameBuf.toString('utf8').replace(/\0.*$/, ''));
        const size = parseOctal(header.subarray(124, 136));
        const type = header.subarray(156, 157).toString('ascii');
        const prefix = sanitizeName(header.subarray(345, 500).toString('utf8').replace(/\0.*$/, ''));
        if (prefix) name = `${prefix}/${name}`;

        if (isZeroBlock(header)) return { type: 'eof', size: 0, name: '' };

        if (type === 'L') return { type: 'longname', size, name: '' };
        if (type === 'x' || type === 'g') return { type: 'skip', size, name: '' };
        if (type === '5') return { type: 'dir', size, name };
        if (type === '0' || type === '' || type === '\0') return { type: 'file', size, name };
        return { type: 'skip', size, name: '' };
    }

    function feed(buffer) {
        const buf = leftover.length ? Buffer.concat([leftover, buffer]) : buffer;
        let pos = 0;

        while (fatalError === null) {
            // Padding between entries.
            if (padSkip > 0) {
                const take = Math.min(padSkip, buf.length - pos);
                pos += take;
                padSkip -= take;
                if (pos >= buf.length) break;
                continue;
            }

            // Current entry payload.
            if (entry) {
                const take = Math.min(entry.bytesLeft, buf.length - pos);
                const slice = buf.subarray(pos, pos + take);
                pos += take;
                entry.bytesLeft -= take;
                if (entry.kind === 'file') {
                    entry.ws.write(slice);
                } else if (entry.kind === 'collect') {
                    entry.chunks.push(slice);
                }
                if (entry.bytesLeft === 0) {
                    let finishedSize = entry.size;
                    let finishedKind = entry.kind;
                    if (finishedKind === 'collect') {
                        const collected = Buffer.concat(entry.chunks);
                        if (entry.collectId === 'longname') {
                            pendingLongName = sanitizeName(collected.toString('utf8').replace(/\0.*$/, ''));
                        }
                        entry.chunks = null;
                    }
                    finishEntry();
                    padSkip = (512 - (finishedSize % 512)) % 512;
                    if (finishedKind === 'collect') continue;
                }
                if (pos >= buf.length) break;
                continue;
            }

            // Scanning for the next 512-byte header.
            if (buf.length - pos < 512) break;
            const parsed = parseHeader(buf.subarray(pos, pos + 512));
            pos += 512;

            if (parsed.type === 'eof') {
                // End-of-archive marker: consume everything after without
                // treating it as headers.
                pos = buf.length;
                break;
            }

            if (parsed.type === 'longname') {
                pendingLongName = null;
                startCollect(parsed.size, 'longname');
                continue;
            }

            const headerName = pendingLongName !== null ? pendingLongName : parsed.name;
            pendingLongName = null;

            if (parsed.type === 'skip') {
                startSkip(parsed.size);
                continue;
            }

            if (parsed.type === 'dir') {
                const dirPath = resolveEntryPath(headerName, null);
                if (dirPath) {
                    try { fs.mkdirSync(dirPath, { recursive: true }); } catch (e) { fail(e.message); }
                }
                continue;
            }

            if (parsed.type === 'file') {
                if (parsed.size === 0) continue;
                const filePath = resolveEntryPath(headerName, null);
                if (!filePath) {
                    startSkip(parsed.size);
                } else {
                    try {
                        fs.mkdirSync(path.dirname(filePath), { recursive: true });
                        const ws = fs.createWriteStream(filePath, { mode: 0o755 });
                        openWriters.push(ws);
                        entry = { kind: 'file', size: parsed.size, bytesLeft: parsed.size, ws };
                    } catch (e) {
                        fail(e.message);
                    }
                }
                continue;
            }
        }

        leftover = pos >= buf.length ? Buffer.alloc(0) : Buffer.from(buf.subarray(pos));
        if (fatalError) throw fatalError;
    }

    await new Promise((resolve, reject) => {
        stream.on('error', (e) => reject(e));
        stream.on('data', (chunk) => {
            try { feed(chunk); } catch (e) { reject(e); }
        });
        stream.on('end', () => resolve());
        stream.on('close', () => resolve());
    });

    // Flush any still-open file writers.
    await Promise.all(openWriters.map((ws) => new Promise((res) => {
        try { ws.end(res); } catch (_) { res(); }
    })));

    if (entry && entry.ws) {
        try { entry.ws.end(); } catch (_) {}
    }
    if (fatalError) throw fatalError;
}

module.exports = { extractTarGz };
