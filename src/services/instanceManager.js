const fs = require('fs');
const path = require('path');
const os = require('os');

class InstanceManager {
    constructor() {
        this.baseDir = path.join(os.homedir(), '.devlauncher', 'instances');
        this.ensureBaseDirectory();
        this.ensureDefaultInstance();
    }

    ensureBaseDirectory() {
        if (!fs.existsSync(this.baseDir)) {
            fs.mkdirSync(this.baseDir, { recursive: true });
        }
    }

    ensureDefaultInstance() {
        const defaultPath = path.join(this.baseDir, 'default');
        if (!fs.existsSync(defaultPath)) {
            this.createInstance('default', 'Default Instance', '1.21.1', 'fabric');
        }
    }

    createInstance(id, name, version, loaderType = 'vanilla', loaderVersion = null) {
        const instanceId = id || name.toLowerCase().replace(/[^a-z0-9]/g, '-');
        const instancePath = path.join(this.baseDir, instanceId);

        if (fs.existsSync(instancePath) && id !== 'default') {
            throw new Error(`Instance "${name}" already exists`);
        }

        fs.mkdirSync(instancePath, { recursive: true });
        fs.mkdirSync(path.join(instancePath, 'mods'), { recursive: true });
        fs.mkdirSync(path.join(instancePath, 'saves'), { recursive: true });
        fs.mkdirSync(path.join(instancePath, 'resourcepacks'), { recursive: true });
        fs.mkdirSync(path.join(instancePath, 'config'), { recursive: true });

        const config = {
            id: instanceId,
            name: name || instanceId,
            version: version || '1.21.1',
            loaderType: loaderType || 'vanilla',
            loaderVersion: loaderVersion || null,
            created: new Date().toISOString()
        };

        fs.writeFileSync(
            path.join(instancePath, 'instance.json'),
            JSON.stringify(config, null, 2)
        );

        return config;
    }

    listInstances() {
        if (!fs.existsSync(this.baseDir)) {
            return [];
        }

        const entries = fs.readdirSync(this.baseDir);
        const instances = [];

        for (const entry of entries) {
            const configFile = path.join(this.baseDir, entry, 'instance.json');
            if (fs.existsSync(configFile)) {
                try {
                    const data = fs.readFileSync(configFile, 'utf-8');
                    instances.push(JSON.parse(data));
                } catch (e) {
                    console.error(`Failed to read instance config for ${entry}:`, e);
                }
            }
        }

        return instances;
    }

    getInstance(id) {
        const configFile = path.join(this.baseDir, id, 'instance.json');
        if (fs.existsSync(configFile)) {
            return JSON.parse(fs.readFileSync(configFile, 'utf-8'));
        }
        return null;
    }

    getInstanceGameDir(id) {
        return path.join(this.baseDir, id || 'default');
    }

    deleteInstance(id) {
        if (id === 'default') {
            throw new Error('Cannot delete default instance');
        }
        const instancePath = path.join(this.baseDir, id);
        if (fs.existsSync(instancePath)) {
            fs.rmSync(instancePath, { recursive: true, force: true });
            return true;
        }
        return false;
    }
}

module.exports = InstanceManager;
