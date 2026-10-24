const fs = require('fs');
const path = require('path');
const https = require('https');

class OptimizerService {
    // Map of popular and essential optimization mods for Fabric / NeoForge / Forge
    static getRecommendedMods(loaderType, mcVersion) {
        const isFabricOrQuilt = loaderType === 'fabric' || loaderType === 'quilt';
        const isForge = loaderType === 'forge';
        const isNeoForge = loaderType === 'neoforge';

        if (isFabricOrQuilt) {
            return [
                { id: 'sodium', name: 'Sodium', slug: 'sodium', description: 'Modern rendering engine replacing OpenGL pipeline (+200% FPS)' },
                { id: 'lithium', name: 'Lithium', slug: 'lithium', description: 'General physics, chunk and mob ticking optimization' },
                { id: 'ferrite-core', name: 'FerriteCore', slug: 'ferrite-core', description: 'Reduces memory usage by up to 50%' },
                { id: 'entityculling', name: 'Entity Culling', slug: 'entityculling', description: 'Skips rendering blocks and entities hidden behind walls' }
            ];
        }

        if (isForge || isNeoForge) {
            return [
                { id: 'embeddium', name: 'Embeddium', slug: 'embeddium', description: 'Forge port of Sodium rendering engine' },
                { id: 'ferrite-core', name: 'FerriteCore', slug: 'ferrite-core', description: 'Memory usage reduction' },
                { id: 'entityculling', name: 'Entity Culling', slug: 'entityculling', description: 'Skips hidden entity rendering' }
            ];
        }

        return [];
    }

    static async installOptimizationMod(slug, mcVersion, loaderType, modsDir) {
        const url = `https://api.modrinth.com/v2/project/${slug}/version?loaders=["${loaderType}"]&game_versions=["${mcVersion}"]`;
        
        return new Promise((resolve, reject) => {
            const req = https.get(url, { headers: { 'User-Agent': `devLauncher/${require('../../package.json').version}` } }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const versions = JSON.parse(data);
                        if (!versions || !versions.length || !versions[0].files || !versions[0].files.length) {
                            return resolve({ success: false, reason: 'No compatible version found on Modrinth' });
                        }

                        const file = versions[0].files.find(f => f.primary) || versions[0].files[0];
                        // Same rules as main-process sanitizeModFilename — reject traversal
                        const baseName = file.filename.replace(/^.*[\\/]/, '');
                        if (!baseName || baseName.includes('..') || baseName !== file.filename) {
                            return resolve({ success: false, reason: `Unsafe filename: ${file.filename}` });
                        }
                        const downloadUrl = file.url;
                        const destPath = path.join(modsDir, baseName);

                        if (fs.existsSync(destPath)) {
                            return resolve({ success: true, filename: baseName, alreadyInstalled: true });
                        }

                        const fileStream = fs.createWriteStream(destPath);
                        https.get(downloadUrl, (dlRes) => {
                            dlRes.pipe(fileStream);
                            fileStream.on('finish', () => {
                                fileStream.close();
                                resolve({ success: true, filename: file.filename });
                            });
                        }).on('error', (err) => {
                            fs.unlink(destPath, () => {});
                            resolve({ success: false, reason: err.message });
                        });

                    } catch (e) {
                        resolve({ success: false, reason: e.message });
                    }
                });
            });

            req.on('error', (err) => resolve({ success: false, reason: err.message }));
        });
    }
}

module.exports = OptimizerService;
