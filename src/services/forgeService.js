const https = require('https');

class ForgeService {
    static getForgeVersions(mcVersion) {
        return new Promise((resolve) => {
            const url = `https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json`;
            https.get(url, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        const promos = json.promos || {};
                        const matching = [];

                        const recommended = promos[`${mcVersion}-recommended`];
                        const latest = promos[`${mcVersion}-latest`];

                        if (recommended) matching.push({ version: recommended, type: 'recommended' });
                        if (latest && latest !== recommended) matching.push({ version: latest, type: 'latest' });

                        resolve(matching);
                    } catch (err) {
                        resolve([]);
                    }
                });
            }).on('error', () => resolve([]));
        });
    }
}

module.exports = ForgeService;
