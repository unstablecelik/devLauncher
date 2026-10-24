const localtunnel = require('localtunnel');
const { EventEmitter } = require('events');

class P2PService extends EventEmitter {
    constructor() {
        super();
        this.tunnel = null;
        this.activeRoom = null;
    }

    /**
     * Start sharing a local LAN port (e.g. 25565 or LAN opened port) over P2P Tunnel
     */
    async hostWorld(port = 25565, customSubdomain = null) {
        if (this.tunnel) {
            await this.stopHost();
        }

        const portNum = parseInt(port, 10);
        if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
            throw new Error(`Invalid local port: ${port} (must be 1-65535)`);
        }

        let roomCode = customSubdomain || null;
        if (roomCode) {
            roomCode = String(roomCode).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32);
            if (!roomCode) roomCode = null;
        }
        if (!roomCode) {
            roomCode = `dev-${Math.random().toString(36).substring(2, 8)}`;
        }
        
        try {
            console.log(`[P2P] Starting Tunnel on local port ${port}...`);
            this.tunnel = await localtunnel({ 
                port: portNum,
                subdomain: roomCode
            });

            const tunnelUrl = this.tunnel.url; // e.g. https://dev-abc123.loca.lt
            const cleanHost = tunnelUrl.replace(/^https?:\/\//, '');

            this.activeRoom = {
                code: roomCode,
                port: port,
                url: tunnelUrl,
                connectAddress: cleanHost,
                createdAt: new Date().toISOString()
            };

            this.tunnel.on('close', () => {
                console.log('[P2P] Tunnel closed');
                this.activeRoom = null;
                this.emit('host-stopped');
            });

            this.tunnel.on('error', (err) => {
                console.error('[P2P] Tunnel error:', err);
                this.emit('tunnel-error', err.message || err);
            });

            console.log(`[P2P] World Hosted Successfully! Address: ${cleanHost}`);
            return this.activeRoom;

        } catch (err) {
            console.error('[P2P] Failed to start tunnel:', err);
            throw err;
        }
    }

    async stopHost() {
        if (this.tunnel) {
            try { this.tunnel.close(); } catch (_) {}
            this.tunnel = null;
            this.activeRoom = null;
            console.log('[P2P] Host session stopped.');
        }
    }

    getActiveRoom() {
        return this.activeRoom;
    }
}

module.exports = P2PService;
