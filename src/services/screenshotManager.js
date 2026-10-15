const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

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

        // Lightweight zip writer using standard PK zip format headers
        const zipBuffers = [];

        function writeZipHeader(filename, fileData) {
            const nameBuffer = Buffer.from(filename);
            const header = Buffer.alloc(30 + nameBuffer.length);
            header.writeUInt32LE(0x04034b50, 0); // Local file header signature
            header.writeUInt16LE(20, 4); // Version needed to extract
            header.writeUInt16LE(0, 6); // General purpose bit flag
            header.writeUInt16LE(0, 8); // Compression method (0 = store)
            header.writeUInt16LE(0, 10); // Last mod file time
            header.writeUInt16LE(0, 12); // Last mod file date
            header.writeUInt32LE(0, 14); // CRC-32 (0 for simple store)
            header.writeUInt32LE(fileData.length, 18); // Compressed size
            header.writeUInt32LE(fileData.length, 22); // Uncompressed size
            header.writeUInt16LE(nameBuffer.length, 26); // Filename length
            header.writeUInt16LE(0, 28); // Extra field length
            nameBuffer.copy(header, 30);
            return Buffer.concat([header, fileData]);
        }

        for (const file of files) {
            const filePath = path.join(screenshotsDir, file);
            const content = fs.readFileSync(filePath);
            zipBuffers.push(writeZipHeader(file, content));
        }

        fs.writeFileSync(targetZipPath, Buffer.concat(zipBuffers));
        return targetZipPath;
    }
}

module.exports = ScreenshotManager;
