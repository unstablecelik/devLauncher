'use strict';
// Tiny test helpers shared by all tests/ files.
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, extra) {
    if (cond) {
        passed++;
    } else {
        failed++;
        failures.push(`${name}${extra !== undefined ? ` (got: ${JSON.stringify(extra).slice(0, 200)})` : ''}`);
        console.error(`FAIL: ${name}${extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 200) : ''}`);
    }
}

function tmpdir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'dltest-'));
}

function finish(name) {
    console.log(`${name}: ${passed} passed, ${failed} failed`);
    if (failures.length) process.exitCode = 1;
    return failed === 0;
}

module.exports = { check, tmpdir, finish };
