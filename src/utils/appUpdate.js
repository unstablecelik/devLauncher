'use strict';
// ── App self-update helpers (pure, no Electron) ─────────────────────────────
// Shared logic between the updater service and the test suite:
// version comparison, release asset selection, SHA256SUMS parsing and the
// portable-vs-installed decision. All inputs are plain values/strings.

/**
 * Compare dotted version strings ("1.2.13" vs "1.3.0"). Numeric-aware so
 * "1.10.0" > "1.9.9". Unknown/invalid shapes are treated as equal.
 */
function compareVersions(a, b) {
    const pa = String(a || '').split('.');
    const pb = String(b || '').split('.');
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const na = parseInt(pa[i], 10) || 0;
        const nb = parseInt(pb[i], 10) || 0;
        if (na > nb) return 1;
        if (na < nb) return -1;
    }
    return 0;
}

/** "v1.2.3" / "1.2.3" → "1.2.3" */
function stripTag(tag) {
    return String(tag || '').trim().replace(/^v/i, '');
}

/** electron arch → suffix used by electron-builder zip artifact names */
function zipSuffixForArch(arch) {
    if (arch === 'ia32') return '-ia32';
    if (arch === 'arm64') return '-arm64';
    return '';
}

/** Artifact file names produced by the build for a launcher version. */
function zipArtifactName(productName, version, arch) {
    return `${productName}-${version}${zipSuffixForArch(arch)}-win.zip`;
}

function setupArtifactName(productName, version) {
    return `${productName}-Setup-${version}.exe`;
}

/** Find a release asset by exact name. Returns the asset object or null. */
function pickAsset(assets, name) {
    if (!Array.isArray(assets)) return null;
    return assets.find((a) => a && a.name === name) || null;
}

/** Best download URL for an asset (browser_download_url). */
function assetUrl(asset) {
    return asset && asset.browser_download_url ? asset.browser_download_url : null;
}

/**
 * Parse a SHA256SUMS file into { "file name": "hex" }. Handles the
 * "<hash>  <name>" format including names with spaces (dashed variants).
 */
function parseSha256Sums(text) {
    const map = {};
    for (const line of String(text || '').split(/\r?\n/)) {
        const m = line.match(/^([0-9a-fA-F]{64})\s*\*?\s*(.+)$/);
        if (m) map[m[2].trim()] = m[1].toLowerCase();
    }
    return map;
}

/**
 * Decide the update channel. Portable = a `portable.marker` file sits next to
 * the launcher exe (or DEVLAUNCHER_PORTABLE=1 is set); everything else is an
 * Inno Setup installation. `fileExists` is injectable for tests.
 */
function resolveUpdateMode({ exeDir, envFlag, fileExists }) {
    if (envFlag === '1' || envFlag === 'true') return 'portable';
    try {
        if (typeof fileExists === 'function' &&
            fileExists(require('path').join(exeDir || '', 'portable.marker'))) return 'portable';
    } catch (_) { /* treat as installed */ }
    return 'installed';
}

/**
 * Inno Setup command line used by the updater after downloading the new
 * Setup exe. RestartApplications lets Windows' Restart Manager close the
 * still-running launcher and relaunch it after the files were replaced.
 */
function buildInnoUpdateArgs(setupPath) {
    void setupPath;
    return ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS', '/RESTARTAPPLICATIONS'];
}

module.exports = {
    compareVersions,
    stripTag,
    zipSuffixForArch,
    zipArtifactName,
    setupArtifactName,
    pickAsset,
    assetUrl,
    parseSha256Sums,
    resolveUpdateMode,
    buildInnoUpdateArgs
};
