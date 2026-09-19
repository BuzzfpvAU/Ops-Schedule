#!/usr/bin/env node
// Restore the executable bit on build binaries.
//
// Git does not reliably preserve the +x bit on the VPS, and when vite's shim
// or esbuild's native binary loses it the production build dies with a
// spawn EACCES that looks nothing like a permissions problem. This has been a
// recurring manual `chmod` step on every deploy (see .agent-status.md); doing
// it here makes the build self-healing instead.
//
// Never fails the build: a missing file just means that tool is not installed
// in this tree, which is not an error worth stopping a deploy for.

import { chmodSync, existsSync, readdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2] || '.';
const base = join(root, target, 'node_modules');

const fixed = [];

function makeExecutable(file) {
  try {
    if (!existsSync(file)) return;
    const mode = statSync(file).mode;
    // Mirror the read bits into the execute bits: 0o111 for anyone who can read.
    chmodSync(file, mode | 0o111);
    fixed.push(file.slice(root.length + 1));
  } catch {
    // Read-only mount, foreign owner — not worth failing a deploy over.
  }
}

makeExecutable(join(base, 'vite', 'bin', 'vite.js'));

// @esbuild/<platform>-<arch>/bin/esbuild — the folder name varies per host,
// so discover it rather than hardcoding linux-x64.
const esbuildScope = join(base, '@esbuild');
if (existsSync(esbuildScope)) {
  for (const pkg of readdirSync(esbuildScope)) {
    makeExecutable(join(esbuildScope, pkg, 'bin', 'esbuild'));
  }
}

if (fixed.length) console.log(`fix-bin-perms: +x on ${fixed.join(', ')}`);
