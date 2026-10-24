const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const AdmZip = require('adm-zip');

class WorldService {
    static listWorlds(instanceDir) {
        const savesDir = path.join(instanceDir, 'saves');
        if (!fs.existsSync(savesDir)) {
            return [];
        }

        const entries = fs.readdirSync(savesDir, { withFileTypes: true });
        const worlds = [];

        for (const entry of entries) {
            if (entry.isDirectory()) {
                const worldDir = path.join(savesDir, entry.name);
                const levelDat = path.join(worldDir, 'level.dat');
                const iconPath = path.join(worldDir, 'icon.png');

                let worldInfo = {
                    folderName: entry.name,
                    displayName: entry.name,
                    lastPlayed: null,
                    gameType: 'Survival',
                    version: 'Unknown',
                    hasIcon: fs.existsSync(iconPath),
                    iconData: null,
                    sizeBytes: 0
                };

                if (fs.existsSync(iconPath)) {
                    try {
                        const iconBuf = fs.readFileSync(iconPath);
                        worldInfo.iconData = `data:image/png;base64,${iconBuf.toString('base64')}`;
                    } catch (e) {}
                }

                if (fs.existsSync(levelDat)) {
                    try {
                        const stat = fs.statSync(levelDat);
                        worldInfo.lastPlayed = stat.mtime;
                        
                        // Basic fast parse of uncompressed / gzip level.dat string markers
                        const buf = fs.readFileSync(levelDat);
                        let decompressed = buf;
                        try {
                            decompressed = zlib.gunzipSync(buf);
                        } catch (gzErr) {}

                        const str = decompressed.toString('binary');
                        const levelNameMatch = str.match(/LevelName[\x00-\x1f]+([a-zA-Z0-9_\- \(\)]+)/);
                        if (levelNameMatch && levelNameMatch[1]) {
                            worldInfo.displayName = levelNameMatch[1].trim();
                        }
                    } catch (err) {
                        console.error('Error reading level.dat:', err);
                    }
                }

                worlds.push(worldInfo);
            }
        }

        return worlds.sort((a, b) => (b.lastPlayed ? new Date(b.lastPlayed).getTime() : 0) - (a.lastPlayed ? new Date(a.lastPlayed).getTime() : 0));
    }

    static backupWorld(instanceDir, worldFolderName, targetZipPath) {
        // Defense-in-depth: never allow separators / traversal in the world folder name
        if (typeof worldFolderName !== 'string' || !worldFolderName ||
            worldFolderName === '.' || worldFolderName === '..' ||
            worldFolderName.includes('/') || worldFolderName.includes('\\') || worldFolderName.includes('..')) {
            throw new Error('Invalid world folder name');
        }
        const worldDir = path.join(instanceDir, 'saves', worldFolderName);
        if (!fs.existsSync(worldDir)) {
            throw new Error('World directory does not exist');
        }

        const zip = new AdmZip();
        zip.addLocalFolder(worldDir, worldFolderName);
        zip.writeZip(targetZipPath);
        return targetZipPath;
    }
}

module.exports = WorldService;
