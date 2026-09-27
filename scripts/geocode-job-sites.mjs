// One-off: give existing jobs a map position from their site address.
// Run on the server: node scripts/geocode-job-sites.mjs   (1 lookup/second)
import { initDb } from '../server/src/db.js';
import { geocodeAddress } from '../server/src/services/geocodeSite.js';

const db = initDb();
const jobs = db.prepare(`
  SELECT id, code, site_address FROM jobs
  WHERE TRIM(COALESCE(site_address, '')) != '' AND site_lat IS NULL
`).all();
let found = 0;
for (const j of jobs) {
  const pos = await geocodeAddress(j.site_address);
  if (pos) {
    db.prepare('UPDATE jobs SET site_lat = ?, site_lng = ?, site_geocoded_address = ? WHERE id = ?')
      .run(pos.lat, pos.lng, j.site_address.trim(), j.id);
    found += 1;
  }
  console.log(`${j.code}: ${pos ? `${pos.lat.toFixed(3)}, ${pos.lng.toFixed(3)}` : 'not found'}`);
  await new Promise((r) => setTimeout(r, 1000));
}
console.log(`${found}/${jobs.length} jobs located`);
