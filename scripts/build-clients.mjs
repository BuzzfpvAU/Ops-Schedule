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
import { existsSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// Where a client-v2 failure is recorded. The deploy host's build log is not
// reachable from the running app, so the error is written next to the client
// and surfaced on the /v2 page instead — otherwise a best-effort build that
// fails is indistinguishable from one that never ran.
const V2_ERROR_LOG = join(root, 'client-v2', '.build-error.log');

// Captured rather than inherited so a failure can be written to the log as
// well as printed. Output is still echoed, so the host's build log is unchanged.
function run(cmd, args, cwd) {
  const out = execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (out) process.stdout.write(out);
  return out;
}

function outputOf(err) {
  return [err.stdout, err.stderr, err.message].filter(Boolean).join('\n').trim();
}

function buildClient(name) {
  const cwd = join(root, name);
  if (!existsSync(join(cwd, 'package.json'))) {
    throw new Error(`${name}: no package.json at ${cwd}`);
  }
  // vite is what the build actually invokes, so its presence is a better
  // signal than the node_modules directory existing.
  if (!existsSync(join(cwd, 'node_modules', 'vite'))) {
    console.log(`build: ${name} dependencies missing — installing`);
    // --include=dev because the deploy host installs production-only (it runs
    // with NODE_ENV=production), which silently skips devDependencies and
    // leaves the build with no bundler. Build tooling is a build-time need
    // regardless of which section of package.json it is listed under.
    run(npm, ['install', '--no-audit', '--no-fund', '--include=dev'], cwd);
  }
  console.log(`build: ${name}`);
  run(npm, ['run', 'build'], cwd);
}

// Required.
buildClient('client');

// Optional.
try {
  buildClient('client-v2');
  // Clear any error from a previous deploy so the page never shows a stale one.
  rmSync(V2_ERROR_LOG, { force: true });
} catch (err) {
  const detail = outputOf(err);
  console.error('');
  console.error('─'.repeat(64));
  console.error('build: client-v2 FAILED — continuing so the v1 deploy is not blocked.');
  console.error(detail);
  console.error('build: /v2 will report that it is not built until this is fixed.');
  console.error('─'.repeat(64));
  console.error('');
  try {
    writeFileSync(V2_ERROR_LOG, `${new Date().toISOString()}\nnode ${process.version} on ${process.platform}\n\n${detail}\n`);
  } catch {
    // Read-only tree — the console output above is still the record.
  }
}

console.log('build: done');
