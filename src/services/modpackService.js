const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

class ModpackService {
    static exportInstanceToZip(instanceDir, targetZipPath) {
        if (!fs.existsSync(instanceDir)) {
            throw new Error('Instance directory does not exist');
        }

        const zip = new AdmZip();
        zip.addLocalFolder(instanceDir);
        zip.writeZip(targetZipPath);
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
                        // Reject traversal / separator payloads from the API
                        const baseName = file.filename.replace(/^.*[\\/]/, '');
                        if (!baseName || baseName.includes('..') || baseName !== file.filename) {
                            throw new Error(`Unsafe filename: ${file.filename}`);
                        }
                        const fileRes = await fetch(file.url);
                        const arrayBuffer = await fileRes.arrayBuffer();
                        const buffer = Buffer.from(arrayBuffer);

                        const dest = path.join(modsDir, baseName);
                        fs.writeFileSync(dest, buffer);
                        installed.push(baseName);
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
