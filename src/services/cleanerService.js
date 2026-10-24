const fs = require('fs');
const path = require('path');

class CleanerService {
    static scanGarbage(baseDir) {
        let totalBytes = 0;
        let filesCount = 0;
        const details = {
            logs: 0,
            crashes: 0,
            cache: 0
        };

        const scanRecursive = (dir, isLogOrCrash) => {
            if (!fs.existsSync(dir)) return;
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const full = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        if (entry.name === 'logs' || entry.name === 'crash-reports' || entry.name === '.cache') {
                            scanRecursive(full, true);
                        } else if (!isLogOrCrash) {
                            scanRecursive(full, false);
                        }
                    } else if (entry.isFile()) {
                        const isOldLog = entry.name.endsWith('.log.gz') || (entry.name.endsWith('.log') && entry.name !== 'latest.log');
                        const isCrash = entry.name.startsWith('crash-') && entry.name.endsWith('.txt');
                        const isCache = entry.name.endsWith('.tmp') || entry.name.endsWith('.cache');

                        if (isLogOrCrash || isOldLog || isCrash || isCache) {
                            const stat = fs.statSync(full);
                            totalBytes += stat.size;
                            filesCount++;
                            if (isCrash) details.crashes += stat.size;
                            else if (isOldLog) details.logs += stat.size;
                            else details.cache += stat.size;
                        }
                    }
                }
            } catch (e) {
                console.error('Scan error:', e);
            }
        };

        scanRecursive(baseDir, false);

        return {
            totalBytes,
            totalMB: (totalBytes / (1024 * 1024)).toFixed(2),
            filesCount,
            details
        };
    }

    static cleanGarbage(baseDir) {
        let deletedBytes = 0;
        let deletedCount = 0;

        const cleanRecursive = (dir, isLogOrCrash) => {
            if (!fs.existsSync(dir)) return;
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const full = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        if (entry.name === 'logs' || entry.name === 'crash-reports' || entry.name === '.cache') {
                            cleanRecursive(full, true);
                        } else if (!isLogOrCrash) {
                            cleanRecursive(full, false);
                        }
                    } else if (entry.isFile()) {
                        const isOldLog = entry.name.endsWith('.log.gz') || (entry.name.endsWith('.log') && entry.name !== 'latest.log');
                        const isCrash = entry.name.startsWith('crash-') && entry.name.endsWith('.txt');
                        const isCache = entry.name.endsWith('.tmp') || entry.name.endsWith('.cache');

                        if (isLogOrCrash || isOldLog || isCrash || isCache) {
                            try {
                                const size = fs.statSync(full).size;
                                fs.unlinkSync(full);
                                deletedBytes += size;
                                deletedCount++;
                            } catch (err) {}
                        }
                    }
                }
            } catch (e) {
                console.error('Clean error:', e);
            }
        };

        cleanRecursive(baseDir, false);

        return {
            deletedBytes,
            deletedMB: (deletedBytes / (1024 * 1024)).toFixed(2),
            deletedCount
        };
    }
}

module.exports = CleanerService;
