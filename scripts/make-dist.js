#!/usr/bin/env node
// Copies the game's web files into dist/ so the desktop bundle contains the
// game and nothing else (no docs, tests or build output). Runs on any OS.
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const include = ['index.html', 'css', 'js', 'assets'];

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist);
for (const name of include) {
    fs.cpSync(path.join(root, name), path.join(dist, name), {
        recursive: true,
        filter: (src) => path.basename(src) !== '.DS_Store',
    });
}
console.log('dist/ ready: ' + include.join(', '));
