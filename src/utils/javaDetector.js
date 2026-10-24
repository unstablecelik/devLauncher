const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { spawnSync } = require('child_process');

const JAVA_INSTALL_DIR = path.join(os.homedir(), '.devlauncher', 'java_runtimes');

function ensureJavaDir() {
    if (!fs.existsSync(JAVA_INSTALL_DIR)) {
        fs.mkdirSync(JAVA_INSTALL_DIR, { recursive: true });
    }
}

function normalizeJavaMajor(versionString) {
    const match = String(versionString || '').match(/(\d+(?:\.\d+)?)/);
    let major = match ? match[1] : 'Unknown';
    if (major.startsWith('1.')) major = major.split('.')[1];
    const parsed = parseInt(major, 10);
    return Number.isNaN(parsed) ? major : String(parsed);
}

/**
 * Probe a java executable's major version by running `java -version` on it.
 * This launches the java binary itself (never a shell) and is the single
 * spot in the project that does so.
 */
function detectJavaMajor(javaExe) {
    try {
        const result = spawnSync(javaExe, ['-version'], { encoding: 'utf8' });
        const output = `${result.stdout || ''}\n${result.stderr || ''}`;
        const match = output.match(/version\s+"?(\d+(?:\.\d+)?)/);
        if (match) {
            const normalized = normalizeJavaMajor(match[1]);
            return parseInt(normalized, 10) || 21;
        }
    } catch (_) {}
    return 21;
}

function pushRuntime(runtimes, javaBin, nameFallback) {
    if (!fs.existsSync(javaBin)) return;
    let version = 'Unknown';
    try {
        const result = spawnSync(javaBin, ['-version'], { encoding: 'utf8' });
        const output = `${result.stdout || ''}\n${result.stderr || ''}`;
        const match = output.match(/version\s+"?(\d+(?:\.\d+)?)/);
        if (match) version = normalizeJavaMajor(match[1]);
    } catch (e) {}

    runtimes.push({
        name: nameFallback || path.basename(path.dirname(path.dirname(javaBin))),
        path: javaBin,
        version: version
    });
}

function getInstalledJavaRuntimes() {
    ensureJavaDir();
    const runtimes = [];
    const exe = process.platform === 'win32' ? 'java.exe' : 'java';

    if (process.platform === 'darwin') {
        const searchPaths = [
            '/Library/Java/JavaVirtualMachines',
            path.join(os.homedir(), 'Library', 'Java', 'JavaVirtualMachines'),
            JAVA_INSTALL_DIR
        ];

        for (const searchPath of searchPaths) {
            if (!fs.existsSync(searchPath)) continue;
            try {
                const entries = fs.readdirSync(searchPath);
                for (const entry of entries) {
                    const homeBin = path.join(searchPath, entry, 'Contents', 'Home', 'bin', 'java');
                    const directBin = path.join(searchPath, entry, 'bin', 'java');
                    pushRuntime(runtimes, homeBin, entry);
                    pushRuntime(runtimes, directBin, entry);
                }
            } catch (_) {}
        }
        return runtimes;
    }

    const searchPaths = (process.platform === 'win32')
        ? [
            path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Java'),
            path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Eclipse Adoptium'),
            process.env['JAVA_HOME'] || null,
            JAVA_INSTALL_DIR
          ].filter(Boolean)
        : (isBsd())
            ? ['/usr/local', '/usr/local/lib', '/opt', JAVA_INSTALL_DIR]
            : ['/usr/lib/jvm', '/usr/lib64/jvm', '/opt', '/usr/local', JAVA_INSTALL_DIR];

    for (const searchPath of searchPaths) {
        if (!fs.existsSync(searchPath)) continue;
        try {
            const entries = fs.readdirSync(searchPath);
            for (const entry of entries) {
                const javaBin = path.join(searchPath, entry, 'bin', exe);
                pushRuntime(runtimes, javaBin, entry);
            }
            // Also support flat installs such as /usr/local/bin/java
            const directJava = path.join(searchPath, 'bin', exe);
            pushRuntime(runtimes, directJava, path.basename(searchPath));
        } catch (_) {}
    }

    // PATH fallback - pure filesystem scan of process.env.PATH (no shell).
    try {
        const dirs = String(process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':');
        for (const dir of dirs) {
            try {
                if (!dir) continue;
                const candidate = path.join(dir, exe);
                if (fs.existsSync(candidate)) {
                    pushRuntime(runtimes, candidate, path.basename(candidate));
                    break;
                }
            } catch (_) {}
        }
    } catch (_) {}

    return runtimes;
}

function isMusl() {
    try {
        if (process.platform !== 'linux') return false;
        if (fs.existsSync('/etc/alpine-release')) return true;
        // Pure-filesystem musl probe: the loader lives at
        // /lib/ld-musl-<arch>.so.1 (also /lib64 and /usr/lib on some distros).
        const archAliases = {
            x64: ['x86_64'],
            arm64: ['aarch64'],
            arm: ['armhf', 'arm'],
            ia32: ['i386'],
            x32: ['i386'],
            riscv64: ['riscv64'],
            s390x: ['s390x'],
            ppc64le: ['powerpc64le'],
            ppc64: ['powerpc64']
        };
        const names = archAliases[process.arch] || [];
        const roots = ['/lib', '/lib64', '/usr/lib'];
        for (const name of names) {
            for (const root of roots) {
                try {
                    if (fs.existsSync(`${root}/ld-musl-${name}.so.1`)) return true;
                } catch (_) {}
            }
        }
        return false;
    } catch (_) {
        return false;
    }
}

function isBsd() {
    return process.platform === 'freebsd' || process.platform === 'openbsd' || process.platform === 'netbsd';
}

function getAdoptiumOs() {
    if (process.platform === 'win32') return 'windows';
    if (process.platform === 'darwin') return 'mac';
    if (isBsd()) return null; // Eclipse Adoptium has no BSD builds; rely on system JDK.
    return isMusl() ? 'alpine-linux' : 'linux';
}

function getAdoptiumArch() {
    switch (process.arch) {
        case 'arm64': return 'aarch64';
        case 'arm': return 'arm';
        case 'ia32':
        case 'x86':
        case 'x32': return 'x86';
        case 'x64': return 'x64';
        case 'ppc64':
        case 'ppc64le': return 'ppc64le';
        case 's390x': return 's390x';
        case 'riscv64': return 'riscv64';
        default: return 'x64';
    }
}

async function downloadAndInstallJava(versionMajor = 21) {
    ensureJavaDir();
    const targetDir = path.join(JAVA_INSTALL_DIR, `openjdk-${versionMajor}`);
    const exe = process.platform === 'win32' ? 'java.exe' : 'java';
    const javaBin = path.join(targetDir, 'bin', exe);
    const macJavaBin = path.join(targetDir, 'Contents', 'Home', 'bin', 'java');

    if (fs.existsSync(javaBin)) return javaBin;
    if (fs.existsSync(macJavaBin)) return macJavaBin;

    const arch = getAdoptiumArch();
    const osType = getAdoptiumOs();
    if (!osType) {
        throw new Error('Automatic OpenJDK installation is not available on this platform. Please install a JDK manually (BSD systems are not supported by the auto-installer).');
    }
    const isWindows = process.platform === 'win32';
    const archivePath = path.join(JAVA_INSTALL_DIR, isWindows ? `java-${versionMajor}.zip` : `java-${versionMajor}.tar.gz`);

    const apiUrl = `https://api.adoptium.net/v3/binary/latest/${versionMajor}/ga/${osType}/${arch}/jdk/hotspot/normal/eclipse`;

    console.log(`[JavaInstaller] Downloading OpenJDK ${versionMajor} for ${osType}-${arch}...`);

    // Follow the full redirect chain (Adoptium API -> GitHub -> objects.githubusercontent.com)
    // and verify the final status code before writing the body.
    const download = (currentUrl, redirectCount) => new Promise((resolveDownload, rejectDownload) => {
        if (redirectCount > 5) return rejectDownload(new Error('Too many redirects while downloading OpenJDK'));
        https.get(currentUrl, (res) => {
            const status = res.statusCode || 0;
            if ((status === 301 || status === 302 || status === 303 || status === 307 || status === 308) && res.headers.location) {
                res.resume();
                return resolveDownload(download(new URL(res.headers.location, currentUrl).toString(), redirectCount + 1));
            }
            if (status !== 200) {
                res.resume();
                const hint = status === 404 ? ` (no Temurin build for ${osType}/${arch} Java ${versionMajor})` : '';
                return rejectDownload(new Error(`Failed to fetch Java ${versionMajor} binary (HTTP ${status})${hint}`));
            }
            const fileStream = fs.createWriteStream(archivePath);
            res.pipe(fileStream);
            fileStream.on('finish', () => resolveDownload());
            fileStream.on('error', rejectDownload);
        }).on('error', (e) => rejectDownload(new Error(`Network error while downloading OpenJDK: ${e.message}`)));
    });

    try {
        await download(apiUrl, 0);

        fs.mkdirSync(targetDir, { recursive: true });
        if (isWindows) {
            const AdmZip = require('adm-zip');
            const zip = new AdmZip(archivePath);
            zip.extractAllTo(targetDir, true);
        } else {
            // Pure-Node extraction (no tar binary spawn).
            await extractTarGz(archivePath, targetDir, { stripComponents: 1 });
        }
    } catch (err) {
        // Never leave a broken / partial archive behind
        try { if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath); } catch (_) {}
        throw err;
    }

    try { fs.unlinkSync(archivePath); } catch (_) {}

    const resolvedBin = fs.existsSync(javaBin) ? javaBin : (fs.existsSync(macJavaBin) ? macJavaBin : null);
    if (!resolvedBin) {
        throw new Error(`OpenJDK ${versionMajor} archive extracted but no ${exe} binary found inside.`);
    }
    console.log(`[JavaInstaller] Java ${versionMajor} installed to ${resolvedBin}`);
    return resolvedBin;
}

module.exports = { getInstalledJavaRuntimes, downloadAndInstallJava, detectJavaMajor };
