const crypto = require('crypto');

// ── Account service ─────────────────────────────────────────────────────────
// Multi-account hub: Microsoft (msmc) + offline profiles, stored in the main
// config. Microsoft auth payloads are encrypted with Electron's safeStorage
// (OS keychain) when available, with a documented plain-text fallback when it
// is not (e.g. headless Linux without keyring).
//
// Account record shape (kept inside configStore under the "accounts" key):
//   { id, type: 'microsoft'|'offline', username, uuid, createdAt,
//     enc?: '<safeStorage base64 of payload>',      // encrypted path
//     plain?: '<json string>' }                     // fallback path
// Payload: { mclc: <token.mclc() result>, save: <token.save() result|null> }

class AccountService {
    constructor(configStore, safeStorage) {
        this.config = configStore;
        this.safeStorage = safeStorage || null;
        this.encryptionAvailable = !!(this.safeStorage && typeof this.safeStorage.isEncryptionAvailable === 'function' && this.safeStorage.isEncryptionAvailable());
        if (this.safeStorage && !this.encryptionAvailable) {
            console.warn('[Accounts] safeStorage unavailable — Microsoft tokens will be stored UNENCRYPTED in the local config.');
        }
        this.migrateLegacy();
    }

    // Mojang offline UUIDs: name-based MD5 (UUID v3) over "OfflinePlayer:" + name
    static offlineUuid(name) {
        const hash = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
        hash[6] = (hash[6] & 0x0f) | 0x30; // UUID version 3
        hash[8] = (hash[8] & 0x3f) | 0x80; // RFC 4122 variant
        const hex = hash.toString('hex');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }

    _accounts() {
        const raw = this.config.get('accounts');
        return Array.isArray(raw) ? raw : [];
    }

    _writeAccounts(list) {
        this.config.set('accounts', list);
    }

    _id(type) {
        return `${type === 'microsoft' ? 'ms' : 'off'}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    }

    _encrypt(payload) {
        const json = JSON.stringify(payload);
        if (this.encryptionAvailable) {
            return { enc: this.safeStorage.encryptString(json).toString('base64') };
        }
        return { plain: json };
    }

    _decrypt(account) {
        try {
            if (account.enc) {
                if (!this.encryptionAvailable) return null;
                return JSON.parse(this.safeStorage.decryptString(Buffer.from(account.enc, 'base64')));
            }
            if (account.plain) return JSON.parse(account.plain);
        } catch (err) {
            console.error('[Accounts] decrypt failed:', err.message);
            return null;
        }
        return null;
    }

    // Public, secret-free view for the UI
    list() {
        return this._accounts().map(a => ({
            id: a.id,
            type: a.type,
            username: a.username,
            uuid: a.uuid,
            createdAt: a.createdAt,
            encrypted: !!a.enc,
            refreshTokenSaved: !!(this._decrypt(a) || {}).save
        }));
    }

    activeId() {
        return this.config.get('activeAccountId') || null;
    }

    _find(id) {
        return this._accounts().find(a => a.id === id) || null;
    }

    addMicrosoft(mclcAuth, rawSave) {
        if (!mclcAuth || !mclcAuth.name) throw new Error('Invalid Microsoft auth payload');
        const account = {
            id: this._id('microsoft'),
            type: 'microsoft',
            username: mclcAuth.name,
            uuid: mclcAuth.uuid || null,
            createdAt: new Date().toISOString(),
            ...this._encrypt({ mclc: mclcAuth, save: rawSave || null })
        };
        const list = this._accounts();
        // Replace an existing account for the exact same Minecraft UUID
        const dupeIndex = list.findIndex(a => a.uuid && a.uuid === account.uuid);
        if (dupeIndex >= 0) {
            account.id = list[dupeIndex].id; // keep stable id on re-login
            list[dupeIndex] = account;
        } else {
            list.push(account);
        }
        this._writeAccounts(list);
        return account.id;
    }

    addOffline(username, customUuid) {
        const name = String(username || '').trim();
        if (!name) throw new Error('Username is required');
        const uuid = customUuid || AccountService.offlineUuid(name);
        const list = this._accounts();
        const existing = list.find(a => a.type === 'offline' && a.username === name);
        if (existing) return existing.id; // idempotent
        const account = {
            id: this._id('offline'),
            type: 'offline',
            username: name,
            uuid,
            createdAt: new Date().toISOString()
        };
        list.push(account);
        this._writeAccounts(list);
        return account.id;
    }

    remove(id) {
        const list = this._accounts().filter(a => a.id !== id);
        this._writeAccounts(list);
        if (this.activeId() === id) {
            this.setActive(list.length ? list[list.length - 1].id : null);
        }
    }

    setActive(id) {
        const account = id ? this._find(id) : null;
        this.config.set('activeAccountId', account ? account.id : null);
        if (account) {
            // Keep legacy single-account fields coherent for older code paths
            this.config.set('accountType', account.type === 'microsoft' ? 'microsoft' : 'offline');
            this.config.set('username', account.username);
        }
        return account ? account.id : null;
    }

    getActive() {
        const id = this.activeId();
        if (id) {
            const found = this._find(id);
            if (found) return found;
        }
        // No (valid) active selection → use the first account (legacy/migrated
        // MS account lands here automatically)
        const list = this._accounts();
        return list.length ? list[0] : null;
    }

    /**
     * Resolve the MCLC auth object for a launch. `instanceConfig` may carry a
     * per-instance account binding (accountId). Falls back to the active
     * account, then the legacy single-account fields, then null (caller
     * applies its default offline behaviour).
     */
    resolveForLaunch(instanceConfig) {
        let account = null;
        if (instanceConfig && instanceConfig.accountId) {
            account = this._find(instanceConfig.accountId) || this.getActive() || null;
        } else {
            account = this.getActive();
        }
        if (account) return this._toAuth(account);
        return null;
    }

    _toAuth(account) {
        if (!account) return null;
        if (account.type === 'offline') {
            return {
                name: account.username,
                uuid: account.uuid || AccountService.offlineUuid(account.username),
                // Standard MCLC offline token
                access_token: '0',
                meta: { type: 'Mojang' }
            };
        }
        // microsoft
        const payload = this._decrypt(account);
        const auth = payload && payload.mclc;
        if (auth && auth.name) return auth;
        // Legacy column fallback
        const legacy = this.config.get('microsoftAuthData');
        if (legacy && legacy.name) return legacy;
        return null;
    }

    /**
     * Best-effort Microsoft token refresh via msmc. `Auth` here is the msmc
     * constructor (exported by msmc). Returns the fresh MCLC auth or null on
     * failure — launchers should then ask the user to log in again.
     */
    async refreshMicrosoft(AuthCtor, accountId) {
        const account = this._find(accountId) || this.getActive();
        if (!account || account.type !== 'microsoft') return null;
        const payload = this._decrypt(account);
        if (!payload || !payload.save) return null;
        try {
            const authManager = new AuthCtor('select_account');
            const xbox = await authManager.refresh(payload.save);
            const token = await xbox.getMinecraft();
            const mclc = token.mclc();
            const save = token.save ? token.save() : payload.save;
            const id = this.addMicrosoft(mclc, save);
            this.setActive(id);
            return mclc;
        } catch (err) {
            console.error('[Accounts] refresh failed:', err.message || err);
            return null;
        }
    }

    // Legacy installs carry microsoftAuthData/accountType but no accounts[].
    // Pull that into the hub once so the old login keeps working.
    migrateLegacy() {
        const legacy = this.config.get('microsoftAuthData');
        if (legacy && this._accounts().length === 0) {
            try {
                const id = this.addMicrosoft(legacy, null);
                if (this.config.get('accountType') === 'microsoft') this.setActive(id);
            } catch (err) {
                console.error('[Accounts] legacy migration failed:', err.message);
            }
        }
    }
}

module.exports = AccountService;
