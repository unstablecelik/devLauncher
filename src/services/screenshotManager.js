const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

class ScreenshotManager {
    static getScreenshots(instanceDir) {
        const screenshotsDir = path.join(instanceDir, 'screenshots');
        if (!fs.existsSync(screenshotsDir)) {
            return [];
        }

        const files = fs.readdirSync(screenshotsDir);
        return files
            .filter(f => f.endsWith('.png') || f.endsWith('.jpg'))
            .map(f => {
                const fullPath = path.join(screenshotsDir, f);
                const stat = fs.statSync(fullPath);
                return {
                    filename: f,
                    path: fullPath,
                    size: stat.size,
                    mtime: stat.mtime
                };
            })
            .sort((a, b) => b.mtime - a.mtime);
    }

    static exportScreenshotsToZip(instanceDir, targetZipPath) {
        const screenshotsDir = path.join(instanceDir, 'screenshots');
        if (!fs.existsSync(screenshotsDir)) {
            throw new Error('No screenshots folder found in instance');
        }

        const files = fs.readdirSync(screenshotsDir).filter(f => f.endsWith('.png') || f.endsWith('.jpg'));
        if (files.length === 0) {
            throw new Error('No screenshot images to export');
        }

        const zip = new AdmZip();
        files.forEach(file => {
            zip.addLocalFile(path.join(screenshotsDir, file));
        });
        zip.writeZip(targetZipPath);
        return targetZipPath;
    }
}

module.exports = ScreenshotManager;
