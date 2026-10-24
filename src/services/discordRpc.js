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
        this.reconnectInterval = null;
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

    setEnabled(enabled) {
        const wasEnabled = this.enabled;
        this.enabled = !!enabled;
        if (!this.enabled && wasEnabled) {
            if (this.reconnectInterval) {
                clearInterval(this.reconnectInterval);
                this.reconnectInterval = null;
            }
            this.clearActivity();
            this.disconnect();
            console.log('[DiscordRPC] Disabled by user.');
        }
    }

    init() {
        this.connect();
        if (!this.reconnectInterval) {
            this.reconnectInterval = setInterval(() => {
                if (!this.connected && this.enabled) {
                    this.connect();
                }
            }, 10000); // Retry every 10 seconds automatically if Discord opens late
        }
    }

    disconnect() {
        if (this.socket) {
            try { this.socket.destroy(); } catch (e) {}
            this.socket = null;
            this.connected = false;
        }
    }

    getIpcPath() {
        // win32 uses named pipes directly (see connect()); unix sockets are searched here
        const uid = process.getuid ? process.getuid() : 1000;
        const searchDirs = [
            `/run/user/${uid}`,
            process.env.XDG_RUNTIME_DIR,
            process.env.TMPDIR,
            process.env.TMP,
            process.env.TEMP,
            path.join(os.homedir(), '.var/app/com.discordapp.Discord/config'),
            path.join(os.homedir(), '.var/app/com.discordapp.Vesktop/config'),
            '/tmp'
        ].filter(Boolean);

        for (const dir of searchDirs) {
            for (let i = 0; i < 10; i++) {
                const testPath = path.join(dir, `discord-ipc-${i}`);
                if (fs.existsSync(testPath)) return testPath;
            }
        }

        return '/tmp/discord-ipc-0';
    }

    connect() {
        if (this.connected || !this.enabled) return;

        if (process.platform === 'win32') {
            const pipes = Array.from({ length: 10 }, (_, i) => `\\\\.\\pipe\\discord-ipc-${i}`);
            const tryPipe = (index) => {
                if (index >= pipes.length || this.connected || !this.enabled) return;
                try {
                    this.socket = net.createConnection(pipes[index], () => {
                        this.connected = true;
                        this.sendHandshake();
                    });

                    this.socket.on('error', () => {
                        this.connected = false;
                        if (this.socket) { try { this.socket.destroy(); } catch (_) {} }
                        this.socket = null;
                        tryPipe(index + 1);
                    });

                    this.socket.on('close', () => {
                        this.connected = false;
                        this.socket = null;
                    });
                } catch (err) {
                    this.connected = false;
                    this.socket = null;
                    tryPipe(index + 1);
                }
            };
            tryPipe(0);
            return;
        }

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
