const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class ConfigStore {
    /**
     * options.targetDir allows tests/tools to point at an isolated config
     * location; in the app itself the electron userData path is used.
     */
    constructor(options = {}) {
        const baseDir = (options && typeof options.targetDir === 'string')
            ? options.targetDir
            : app.getPath('userData');
        this.configPath = path.join(baseDir, 'devlauncher_config.json');
        this.defaultConfig = {
            accountType: 'offline', // 'offline' | 'microsoft'
            username: 'Player',
            microsoftAuthData: null,
            selectedVersion: '1.21.1',
            selectedInstanceId: null,
            minRam: '2G',
            maxRam: '4G',
            javaPath: '',
            customSkinPath: '',
            enableJVMBoost: true,
            gcMode: 'g1gc', // 'g1gc' | 'zgc'
            customJvmArgs: '',
            proxyMode: 'system', // 'system' | 'off' | 'custom'
            proxyUrl: '',
            proxyUser: '',
            proxyPass: '',
            theme: 'dark',
            customThemeData: null,
            enableDiscordRpc: true,
            discordClientId: '1342000000000000000' // devLauncher Application Client ID
        };
        this.config = this.load();
    }

    load() {
        try {
            if (fs.existsSync(this.configPath)) {
                const raw = fs.readFileSync(this.configPath, 'utf-8');
                return { ...this.defaultConfig, ...JSON.parse(raw) };
            }
        } catch (err) {
            console.error('Failed to load config, using defaults:', err);
        }
        return { ...this.defaultConfig };
    }

    save() {
        try {
            const dir = path.dirname(this.configPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
        } catch (err) {
            console.error('Failed to save config:', err);
        }
    }

    get(key) {
        return this.config[key];
    }

    set(key, value) {
        this.config[key] = value;
        this.save();
    }

    getAll() {
        return { ...this.config };
    }

    update(partialConfig) {
        this.config = { ...this.config, ...partialConfig };
        this.save();
    }
}

module.exports = ConfigStore;
