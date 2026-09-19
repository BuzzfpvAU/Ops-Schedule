#!/usr/bin/env node
// Build every front end, installing its dependencies first if they are absent.
//
// The root `postinstall` is not a reliable guarantee on the deploy host: it can
// cache node_modules and re-install only when the lockfile changes, so adding a
// client via package.json alone can leave that client's dependencies missing.
// A build that assumed they were present would then succeed locally and fail on
// the server — which is exactly how client-v2 shipped without a bundle.
//
// Checking here makes the build self-sufficient, and a failure in any client
// stops the whole build rather than producing a half-deployed tree.

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENTS = ['client', 'client-v2'];
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

for (const name of CLIENTS) {
  const cwd = join(root, name);
  if (!existsSync(join(cwd, 'package.json'))) {
    console.log(`build: skipping ${name} — no package.json`);
    continue;
  }

  // vite is the thing the build actually invokes, so its presence is a better
  // signal than the existence of a node_modules directory.
  if (!existsSync(join(cwd, 'node_modules', 'vite'))) {
    console.log(`build: ${name} dependencies missing — installing`);
    execFileSync(npm, ['install', '--no-audit', '--no-fund'], { cwd, stdio: 'inherit' });
  }

  console.log(`build: ${name}`);
  execFileSync(npm, ['run', 'build'], { cwd, stdio: 'inherit' });
}

console.log('build: all front ends built');
