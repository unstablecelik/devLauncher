const fs = require('fs');
const path = require('path');

class ModrinthService {
    constructor() {
        this.baseUrl = 'https://api.modrinth.com/v2';
    }

    async searchMods(query, gameVersion, loader = 'fabric') {
        const facets = JSON.stringify([
            [`versions:${gameVersion}`],
            [`categories:${loader}`],
            ['project_type:mod']
        ]);

        const url = `${this.baseUrl}/search?query=${encodeURIComponent(query)}&facets=${encodeURIComponent(facets)}`;
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error('Failed to fetch mods from Modrinth');
        }

        const data = await response.json();
        return data.hits;
    }

    async downloadModVersion(projectSlug, gameVersion, targetModsDir) {
        const url = `${this.baseUrl}/project/${projectSlug}/version`;
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error('Failed to fetch mod versions');
        }

        const versions = await response.json();
        const compatibleVersion = versions.find(v => v.game_versions.includes(gameVersion));

        if (!compatibleVersion || !compatibleVersion.files.length) {
            throw new Error('No compatible version found');
        }

        const primaryFile = compatibleVersion.files.find(f => f.primary) || compatibleVersion.files[0];
        const fileResponse = await fetch(primaryFile.url);
        const arrayBuffer = await fileResponse.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        const destPath = path.join(targetModsDir, primaryFile.filename);
        fs.writeFileSync(destPath, buffer);

        return destPath;
    }
}

module.exports = ModrinthService;
