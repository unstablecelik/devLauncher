const fs = require('fs');
const path = require('path');

class ModpackService {
    static exportInstanceToZip(instanceDir, targetZipPath) {
        if (!fs.existsSync(instanceDir)) {
            throw new Error('Instance directory does not exist');
        }

        // Lightweight zip export helper
        function writeZipHeader(filename, fileData) {
            const nameBuffer = Buffer.from(filename);
            const header = Buffer.alloc(30 + nameBuffer.length);
            header.writeUInt32LE(0x04034b50, 0);
            header.writeUInt16LE(20, 4);
            header.writeUInt16LE(0, 6);
            header.writeUInt16LE(0, 8);
            header.writeUInt16LE(0, 10);
            header.writeUInt16LE(0, 12);
            header.writeUInt32LE(0, 14);
            header.writeUInt32LE(fileData.length, 18);
            header.writeUInt32LE(fileData.length, 22);
            header.writeUInt16LE(nameBuffer.length, 26);
            header.writeUInt16LE(0, 28);
            nameBuffer.copy(header, 30);
            return Buffer.concat([header, fileData]);
        }

        const zipBuffers = [];

        function collectFiles(dir, relativePath = '') {
            const entries = fs.readdirSync(dir);
            for (const entry of entries) {
                const fullPath = path.join(dir, entry);
                const rel = relativePath ? `${relativePath}/${entry}` : entry;
                const stat = fs.statSync(fullPath);

                if (stat.isDirectory()) {
                    collectFiles(fullPath, rel);
                } else {
                    const content = fs.readFileSync(fullPath);
                    zipBuffers.push(writeZipHeader(rel, content));
                }
            }
        }

        collectFiles(instanceDir);
        fs.writeFileSync(targetZipPath, Buffer.concat(zipBuffers));
        return targetZipPath;
    }

    static async installPerformancePack(instanceDir, mcVersion, loader = 'fabric') {
        const modsDir = path.join(instanceDir, 'mods');
        if (!fs.existsSync(modsDir)) {
            fs.mkdirSync(modsDir, { recursive: true });
        }

        // Essential Performance Mod List (Sodium, Lithium, FerriteCore, Indium, Krypton, Entity Culling)
        const perfModSlugs = ['sodium', 'lithium', 'ferrite-core', 'indium', 'krypton', 'entityculling'];
        const installed = [];

        for (const slug of perfModSlugs) {
            try {
                const url = `https://api.modrinth.com/v2/project/${slug}/version`;
                const response = await fetch(url, { headers: { 'User-Agent': 'devLauncher/1.0.0' } });

                if (response.ok) {
                    const versions = await response.json();
                    const match = versions.find(v => {
                        const gameMatch = !mcVersion || v.game_versions.includes(mcVersion);
                        const loaderMatch = !loader || v.loaders.includes(loader);
                        return gameMatch && loaderMatch;
                    }) || versions[0];

                    if (match && match.files && match.files.length > 0) {
                        const file = match.files.find(f => f.primary) || match.files[0];
                        const fileRes = await fetch(file.url);
                        const arrayBuffer = await fileRes.arrayBuffer();
                        const buffer = Buffer.from(arrayBuffer);

                        const dest = path.join(modsDir, file.filename);
                        fs.writeFileSync(dest, buffer);
                        installed.push(file.filename);
                    }
                }
            } catch (err) {
                console.error(`Failed to download performance mod ${slug}:`, err);
            }
        }

        return installed;
    }
}

module.exports = ModpackService;
