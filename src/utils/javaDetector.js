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
        ? [path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Java'), JAVA_INSTALL_DIR]
        : (process.platform.startsWith('freebsd') || process.platform.startsWith('openbsd') || process.platform.startsWith('netbsd'))
            ? ['/usr/local', '/usr/local/lib', '/opt', JAVA_INSTALL_DIR]
            : ['/usr/lib/jvm', '/usr/lib64/jvm', '/opt', '/usr/local', JAVA_INSTALL_DIR];

    for (const searchPath of searchPaths) {
        if (!fs.existsSync(searchPath)) continue;
        try {
            const entries = fs.readdirSync(searchPath);
            for (const entry of entries) {
                const javaBin = path.join(searchPath, entry, 'bin', 'java');
                pushRuntime(runtimes, javaBin, entry);
            }
            // Also support flat installs such as /usr/local/bin/java
            const directJava = path.join(searchPath, 'bin', 'java');
            pushRuntime(runtimes, directJava, path.basename(searchPath));
        } catch (_) {}
    }

    // PATH fallback
    try {
        const javaOnPath = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['java'], { encoding: 'utf8' });
        const first = (javaOnPath.stdout || '').split(/\r?\n/)[0].trim();
        if (first) pushRuntime(runtimes, first, path.basename(first));
    } catch (_) {}

    return runtimes;
}

function isMusl() {
    try {
        if (process.platform !== 'linux') return false;
        if (fs.existsSync('/etc/alpine-release')) return true;
        const result = spawnSync('ldd', ['--version'], { encoding: 'utf8' });
        const output = `${result.stdout || ''}\n${result.stderr || ''}`;
        return /musl/i.test(output);
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
    const javaBin = path.join(targetDir, 'bin', 'java');
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

    return new Promise((resolve, reject) => {
        https.get(apiUrl, (res) => {
            if (res.statusCode === 302 || res.statusCode === 301) {
                const redirectUrl = res.headers.location;
                https.get(redirectUrl, (archiveRes) => {
                    const fileStream = fs.createWriteStream(archivePath);
                    archiveRes.pipe(fileStream);

                    fileStream.on('finish', () => {
                        fileStream.close();
                        try {
                            fs.mkdirSync(targetDir, { recursive: true });
                            if (isWindows) {
                                const AdmZip = require('adm-zip');
                                const zip = new AdmZip(archivePath);
                                zip.extractAllTo(targetDir, true);
                            } else {
                                const result = spawnSync('tar', ['-xzf', archivePath, '-C', targetDir, '--strip-components=1'], { encoding: 'utf8' });
                                if (result.status !== 0) {
                                    throw new Error(result.stderr || 'tar extraction failed');
                                }
                            }

                            fs.unlinkSync(archivePath);
                            const resolvedBin = fs.existsSync(javaBin) ? javaBin : (fs.existsSync(macJavaBin) ? macJavaBin : javaBin);
                            console.log(`[JavaInstaller] Java ${versionMajor} installed to ${resolvedBin}`);
                            resolve(resolvedBin);
                        } catch (extractErr) {
                            reject(extractErr);
                        }
                    });
                }).on('error', reject);
            } else {
                reject(new Error(`Failed to fetch Java ${versionMajor} binary (HTTP ${res.statusCode})`));
            }
        }).on('error', reject);
    });
}

module.exports = { getInstalledJavaRuntimes, downloadAndInstallJava };
