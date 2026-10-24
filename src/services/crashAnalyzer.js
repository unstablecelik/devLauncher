const fs = require('fs');
const path = require('path');

class CrashAnalyzer {
    constructor() {
        this.rules = [];
        this.loadRules();
    }

    loadRules() {
        try {
            const rulesPath = path.join(__dirname, '..', 'data', 'crash-rules.json');
            if (fs.existsSync(rulesPath)) {
                this.rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
            }
        } catch (e) {
            console.error('Failed to load crash rules:', e);
            this.rules = [];
        }
    }

    analyze(logText) {
        if (!logText || typeof logText !== 'string') {
            return null;
        }

        for (const rule of this.rules) {
            try {
                const regex = new RegExp(rule.pattern, 'im');
                const match = logText.match(regex);
                if (match) {
                    return {
                        id: rule.id,
                        name: rule.name,
                        cause: rule.cause,
                        solution: rule.solution,
                        autoFix: rule.autoFix,
                        matchedSnippet: match[0],
                        capturedGroup: match[1] || null
                    };
                }
            } catch (err) {
                console.error(`Regex error in rule ${rule.id}:`, err);
            }
        }

        return null;
    }

    static getLatestLog(instanceDir) {
        const logPath = path.join(instanceDir, 'logs', 'latest.log');
        if (fs.existsSync(logPath)) {
            try {
                return fs.readFileSync(logPath, 'utf8');
            } catch (e) {
                return null;
            }
        }
        return null;
    }

    static getLatestCrashReport(instanceDir) {
        const crashDir = path.join(instanceDir, 'crash-reports');
        if (!fs.existsSync(crashDir)) return null;

        try {
            const files = fs.readdirSync(crashDir)
                .filter(f => f.startsWith('crash-') && f.endsWith('.txt'))
                .map(f => ({ name: f, time: fs.statSync(path.join(crashDir, f)).mtimeMs }))
                .sort((a, b) => b.time - a.time);

            if (files.length > 0) {
                return fs.readFileSync(path.join(crashDir, files[0].name), 'utf8');
            }
        } catch (e) {
            return null;
        }
        return null;
    }
}

module.exports = CrashAnalyzer;
