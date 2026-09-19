#!/usr/bin/env node
// Build the front ends for a deploy.
//
// The deploy host builds a new version and only swaps the live symlink when
// the build succeeds. That makes `npm run build` all-or-nothing: anything that
// fails here pins the site to its previous version, silently. So the two
// clients are NOT equal here.
//
//   client    — the live UI. Must build. A failure fails the deploy, because
//               shipping without it would be worse than not shipping.
//   client-v2 — additive, served at /v2. Best-effort: it installs its own
//               dependencies if they are absent, and if it still cannot build,
//               that is reported loudly but does NOT fail the deploy. The
//               server answers /v2 with an explicit "not built" page, so the
//               failure stays visible without holding back everything else.
//
// This asymmetry is deliberate. A new, optional view must never be able to
// stop the main app from deploying.

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

function buildClient(name) {
  const cwd = join(root, name);
  if (!existsSync(join(cwd, 'package.json'))) {
    throw new Error(`${name}: no package.json`);
  }
  // vite is what the build actually invokes, so its presence is a better
  // signal than the node_modules directory existing.
  if (!existsSync(join(cwd, 'node_modules', 'vite'))) {
    console.log(`build: ${name} dependencies missing — installing`);
    run(npm, ['install', '--no-audit', '--no-fund'], cwd);
  }
  console.log(`build: ${name}`);
  run(npm, ['run', 'build'], cwd);
}

// Required.
buildClient('client');

// Optional.
try {
  buildClient('client-v2');
} catch (err) {
  console.error('');
  console.error('─'.repeat(64));
  console.error('build: client-v2 FAILED — continuing so the v1 deploy is not blocked.');
  console.error(`build: ${err.message}`);
  console.error('build: /v2 will report that it is not built until this is fixed.');
  console.error('─'.repeat(64));
  console.error('');
}

console.log('build: done');
