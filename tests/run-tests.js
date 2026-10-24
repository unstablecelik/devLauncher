'use strict';
// Runner: executes every tests/*.test.js in its own process, aggregates results.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const here = __dirname;
const files = fs.readdirSync(here).filter(f => f.endsWith('.test.js'));
const runnerRe = /spawnSync\('(which|where|ldd|tar)'/; // never used - self-audit below

let failed = 0;
for (const f of files) {
    const res = spawnSync(process.execPath, [path.join(here, f)], { encoding: 'utf8', timeout: 180000 });
    const out = (res.stdout || '').trim().split('\n').filter(Boolean);
    const last = out[out.length - 1] || `(exit ${res.status})`;
    console.log(`── ${f}`);
    console.log(last.indexOf('passed') >= 0 ? last : `CRASH ${last}`);
    if (res.status !== 0) failed++;
}

// self-scan: the runner itself must stay shell-free (tests may run in child processes only node)
if (runnerRe.test(fs.readFileSync(path.join(here, 'run-tests.js'), 'utf8'))) failed++;
console.log(failed === 0 ? `\nALL SUITES PASSED` : `\n${failed} SUITE(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
