import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Production runs the root index.js (`npm start`), not server/src/index.js.
// A route file that is not imported and mounted there answers 404 on the live
// app even though its own tests pass, so every route module must be wired in.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const entry = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const routeFiles = fs.readdirSync(path.join(root, 'server', 'src', 'routes')).filter((f) => f.endsWith('.js'));

for (const file of routeFiles) {
  test(`root index.js mounts routes/${file}`, () => {
    assert.ok(
      entry.includes(`./server/src/routes/${file}`),
      `${file} is not imported by index.js, the file production runs`,
    );
  });
}

test('the certificate routes are mounted under /api/certs', () => {
  assert.match(entry, /app\.use\('\/api\/certs', requireAuth, certRoutes\)/);
});
