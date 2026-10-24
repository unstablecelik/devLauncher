'use strict';
// UI contract tests: element ids referenced by renderer must exist in index.html,
// and every modal must go through the central openModal() system.
const fs = require('fs');
const path = require('path');
const { check, finish } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf8');

// 1) every getElementById('x') in renderer must exist as id="x" in the HTML
const idRefRe = /getElementById\('([A-Za-z0-9_-]+)'\)/g;
const referenced = new Set();
let m;
while ((m = idRefRe.exec(renderer))) referenced.add(m[1]);
const defined = new Set();
const defRe = /id="([A-Za-z0-9_-]+)"/g;
while ((m = defRe.exec(html))) defined.add(m[1]);

let missing = [];
for (const id of referenced) {
    if (!defined.has(id)) missing.push(id);
    if (missing.length >= 5) break;
}
check('all renderer element ids exist in HTML', missing.length === 0, missing);

// renderer ids not present anywhere (proxied ids like create buttons are checked loosely)
// 2) modal contract: every .modal in HTML is referenced by openModal(...) at least once
//    (crash-modal / account flows use the same open path)
const modalIds = [...html.matchAll(/<div class="modal"(?:[^>]*)id="([a-z-]+)"/g)].map(x => x[1]);
const openCalls = new Set([...renderer.matchAll(/openModal\('([a-z-]+)'\)/g)].map(x => x[1]));
const neverOpened = modalIds.filter(id => !openCalls.has(id));
check('every modal opens via openModal()', neverOpened.length === 0, neverOpened);

// 3) no ad-hoc overlay writes outside the central helper
const manualOverlay = [...renderer.matchAll(/getElementById\('modal-overlay'\)\.style\.display = 'block'/g)].length;
check('no manual overlay.open outside openModal()', manualOverlay === 1, manualOverlay);

// 4) closeAllModals resets state, hide-all + overlay
check('closeAllModals hides everything', /function closeAllModals\(\)[\s\S]{0,400}querySelectorAll\('\.modal'\)\.forEach/.test(renderer));

// 5) firstrun can never show twice in one session
check('firstrun session guard', /let firstRunShownThisSession = false;[\s\S]{0,200}if \(firstRunShownThisSession\) return;/.test(renderer));

// 6) renderer syntax sanity: balanced big markers
check('openModal helper exists', /function openModal\(id\)/.test(renderer));
check('isModalOpen guard exists', /function isModalOpen\(id\)/.test(renderer));

console.log = console.log; // keep output shape
finish('ui-contract');
