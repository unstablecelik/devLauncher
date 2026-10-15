const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');

class DiscordRpcService {
    constructor() {
        this.clientId = '1342000000000000000'; // Default devLauncher Client ID
        this.socket = null;
        this.connected = false;
        this.enabled = true;
    }

    setClientId(id) {
        if (id && id !== this.clientId) {
            this.clientId = id;
            if (this.connected) {
                this.disconnect();
                this.connect();
            }
        }
    }

    init() {
        this.connect();
    }

    disconnect() {
        if (this.socket) {
            try { this.socket.destroy(); } catch (e) {}
            this.socket = null;
            this.connected = false;
        }
    }

    getIpcPath() {
        if (process.platform === 'win32') {
            return '\\\\.\\pipe\\discord-ipc-0';
        }

        const uid = process.getuid ? process.getuid() : 1000;
        const runUserPath = `/run/user/${uid}/discord-ipc-0`;
        if (fs.existsSync(runUserPath)) return runUserPath;
        
        const envs = ['XDG_RUNTIME_DIR', 'TMPDIR', 'TMP', 'TEMP'];
        for (const env of envs) {
            if (process.env[env]) {
                const testPath = path.join(process.env[env], 'discord-ipc-0');
                if (fs.existsSync(testPath)) return testPath;
            }
        }
        
        const flatpakPath = path.join(os.homedir(), '.var/app/com.discordapp.Discord/config/discord-ipc-0');
        if (fs.existsSync(flatpakPath)) return flatpakPath;

        return '/tmp/discord-ipc-0';
    }

    connect() {
        if (this.connected || !this.enabled) return;

        const ipcPath = this.getIpcPath();
        try {
            this.socket = net.createConnection(ipcPath, () => {
                this.connected = true;
                this.sendHandshake();
            });

            this.socket.on('error', () => {
                this.connected = false;
                this.socket = null;
            });

            this.socket.on('close', () => {
                this.connected = false;
                this.socket = null;
            });
        } catch (err) {
            this.connected = false;
        }
    }

    sendPacket(opcode, payload) {
        if (!this.socket || !this.connected) return;
        const jsonStr = JSON.stringify(payload);
        const jsonLen = Buffer.byteLength(jsonStr);

        const packet = Buffer.alloc(8 + jsonLen);
        packet.writeUInt32LE(opcode, 0);
        packet.writeUInt32LE(jsonLen, 4);
        packet.write(jsonStr, 8, jsonLen, 'utf-8');

        try {
            this.socket.write(packet);
        } catch (e) {
            this.connected = false;
        }
    }

    sendHandshake() {
        this.sendPacket(0, { v: 1, client_id: this.clientId });
    }

    updateActivity(details, state) {
        if (!this.enabled) return;
        if (!this.connected) {
            this.connect();
        }

        setTimeout(() => {
            const cleanDetails = (details || 'devLauncher').replace(/ 2\.0/g, '');
            const cleanState = (state || 'Browsing Dashboard').replace(/ 2\.0/g, '');

            const activity = {
                cmd: 'SET_ACTIVITY',
                args: {
                    pid: process.pid,
                    activity: {
                        details: cleanDetails,
                        state: cleanState,
                        timestamps: { start: Math.floor(Date.now() / 1000) },
                        assets: {
                            large_image: 'devlauncher_logo',
                            large_text: 'devLauncher'
                        }
                    }
                },
                nonce: Math.random().toString(36).substring(7)
            };

            this.sendPacket(1, activity);
        }, 300);
    }

    clearActivity() {
        if (!this.connected) return;
        const clearPayload = {
            cmd: 'SET_ACTIVITY',
            args: {
                pid: process.pid,
                activity: null
            },
            nonce: Math.random().toString(36).substring(7)
        };
        this.sendPacket(1, clearPayload);
    }
}

module.exports = new DiscordRpcService();
