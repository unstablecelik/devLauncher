const fs = require('fs');

// ── Skin / profile service ──────────────────────────────────────────────────
// Wraps the official Mojang profile APIs (documented, Bearer-token based):
//   GET  /minecraft/profile        → skins + capes for the account
//   PUT  /minecraft/profile/skins  → upload a replacesment skin
// Rendering happens in the renderer (isometric head via canvas); the main
// process fetches the raw texture and returns it as a data URL to avoid
// CORS issues from the file:// page.

const PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';
const SKINS_URL = 'https://api.minecraftservices.com/minecraft/profile/skins';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class SkinService {
    // ── PNG validation (no image deps: parse the IHDR chunk directly) ───────
    static validateSkinPng(buffer) {
        if (!buffer || buffer.length < 33 || !buffer.slice(0, 8).equals(PNG_SIGNATURE)) {
            return { ok: false, error: 'Not a PNG file' };
        }
        if (buffer.readUInt32BE(12) !== 0x49484452) { // "IHDR"
            return { ok: false, error: 'Invalid PNG (missing IHDR chunk)' };
        }
        const width = buffer.readUInt32BE(16);
        const height = buffer.readUInt32BE(20);
        if (width !== 64 || (height !== 32 && height !== 64)) {
            return {
                ok: false,
                error: `Unsupported skin size ${width}x${height} — Minecraft skins must be 64x64 (or legacy 64x32)`
            };
        }
        return { ok: true, width, height };
    }

    /**
     * Fetch the Mojang profile for an access token.
     * Returns { ok, name, skin: {url, variant, state}, skinDataUrl, error }
     */
    async getProfile(accessToken) {
        if (!accessToken) return { ok: false, error: 'Not signed in with Microsoft' };
        const res = await fetch(PROFILE_URL, {
            headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'devLauncher/1.0.0' }
        });
        if (!res.ok) {
            const hint = res.status === 401 ? ' (access token expired — re-login or refresh)' : '';
            return { ok: false, error: `Profile fetch failed (HTTP ${res.status})${hint}` };
        }
        const data = await res.json();
        const skin = (data.skins || []).find(s => s.state === 'ACTIVE') || (data.skins || [])[0] || null;
        let skinDataUrl = null;
        if (skin && skin.url) {
            try {
                const imgRes = await fetch(skin.url, { headers: { 'User-Agent': 'devLauncher/1.0.0' } });
                if (imgRes.ok) {
                    const buf = Buffer.from(await imgRes.arrayBuffer());
                    if (this.constructor.validateSkinPng(buf).ok) {
                        skinDataUrl = `data:image/png;base64,${buf.toString('base64')}`;
                    }
                }
            } catch (_) { /* texture fetch is best-effort */ }
        }
        return {
            ok: true,
            name: data.name,
            skin: skin ? { url: skin.url, variant: skin.variant, state: skin.state } : null,
            skinDataUrl,
            capes: (data.capes || []).map(c => ({ id: c.alias || c.id, url: c.url }))
        };
    }

    /**
     * Upload a new skin for the account.
     * @param {string} accessToken
     * @param {string} filePath path to a 64x64 (or 64x32) PNG
     * @param {'classic'|'slim'} variant
     */
    async uploadSkin(accessToken, filePath, variant) {
        if (!accessToken) return { ok: false, error: 'Not signed in with Microsoft' };
        if (variant !== 'classic' && variant !== 'slim') {
            return { ok: false, error: `Invalid variant "${variant}" (classic or slim)` };
        }
        let buffer;
        try {
            buffer = fs.readFileSync(filePath);
        } catch (err) {
            return { ok: false, error: `Cannot read skin file: ${err.message}` };
        }
        const validation = this.constructor.validateSkinPng(buffer);
        if (!validation.ok) return { ok: false, error: validation.error };

        const body = {
            variant,
            file: `data:image/png;base64,${buffer.toString('base64')}`
        };
        let res;
        try {
            res = await fetch(SKINS_URL, {
                method: 'PUT',
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    'User-Agent': 'devLauncher/1.0.0'
                },
                body: JSON.stringify(body)
            });
        } catch (err) {
            return { ok: false, error: `Network error: ${err.message}` };
        }
        if (!res.ok) {
            if (res.status === 429) return { ok: false, error: 'Rate limited by Mojang — wait a few seconds and try again.' };
            return { ok: false, error: `Skin upload failed (HTTP ${res.status})` };
        }
        return { ok: true };
    }
}

module.exports = SkinService;
