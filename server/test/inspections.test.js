import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import express from 'express';
import cookieParser from 'cookie-parser';
import { initDb } from '../src/db.js';
import { signToken, requireAuth } from '../src/middleware/auth.js';
import inspectionRoutes from '../src/routes/inspections.js';
import { getTemplate, templateForCategory } from '../src/services/inspectionTemplates.js';
import { inspectionsDir, removeStalePhotos, reportFilename } from '../src/services/inspections.js';

let db, server, base, dbPath, admin, member, viewer;

// A real (tiny) PNG, so the PDF has an image it can embed.
function png(w = 4, h = 3) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x80)])));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

before(async () => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-test-')), 'test.db');
  process.env.DATABASE_PATH = dbPath;
  db = initDb();
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use((req, res, next) => { req.db = db; next(); });
  app.use('/api/inspections', requireAuth, inspectionRoutes);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/inspections`;
});

after(() => {
  server?.close();
  db?.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

beforeEach(() => {
  db.exec('DELETE FROM equipment_inspection_photos; DELETE FROM equipment_inspections;');
  db.exec("DELETE FROM team_members WHERE id IN ('m1','m2','v1','d1','p1')");
  db.prepare("INSERT INTO team_members (id, name, is_admin, active) VALUES ('m1','Alex',1,1)").run();
  db.prepare("INSERT INTO team_members (id, name, is_admin, active) VALUES ('m2','Sam',0,1)").run();
  db.prepare("INSERT INTO team_members (id, name, is_viewer, active) VALUES ('v1','Viewer',1,1)").run();
  db.prepare(`INSERT INTO team_members (id, name, is_equipment, equipment_category, serial_number, serviceable, active)
    VALUES ('d1','DJI M4T',1,'Drones','1581F7K3C24C600A0RZP',1,1)`).run();
  db.prepare("INSERT INTO team_members (id, name, is_equipment, active) VALUES ('p1','Not kit',0,1)").run();
  admin = `auth_token=${signToken('m1', true)}`;
  member = `auth_token=${signToken('m2', false)}`;
  viewer = `auth_token=${signToken('v1', false)}`;
});

const json = (url, method, body, cookie = member) => fetch(`${base}${url}`, {
  method, headers: { 'Content-Type': 'application/json', cookie }, body: body && JSON.stringify(body),
});
const upload = async (cookie = member) => {
  const res = await fetch(`${base}/photos`, { method: 'POST', headers: { 'Content-Type': 'image/png', cookie }, body: png() });
  return { res, body: await res.json() };
};

// A complete drone submission: one photo per area, all "No".
async function droneSubmission(overrides = {}) {
  const t = getTemplate('drone-basic');
  const answers = {};
  for (const a of t.areas) answers[a.key] = { defects: 'no', notes: '', photos: [(await upload()).body.id] };
  return {
    equipment_id: 'd1', template_id: 'drone-basic',
    details: { assignment: 'Hire – JamieH', reason: 'Scheduled maintenance', inspection_type: '100 hr' },
    answers, ...overrides,
  };
}

test('templates are served, with drones on the drone form and other kit on a fallback', async () => {
  const res = await json('/templates', 'GET');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.byCategory.Drones, 'drone-basic');
  assert.equal(body.byCategory.Vehicles, 'vehicle');
  assert.equal(templateForCategory('Something new').id, body.fallback);
  assert.equal(getTemplate('drone-basic').areas.length, 11, 'the drone form keeps the Microsoft Form’s eleven areas');
});

test('a staff member can submit an inspection and download its PDF', async () => {
  const res = await json('/', 'POST', await droneSubmission({ comments: 'All good' }));
  assert.equal(res.status, 201);
  const saved = await res.json();
  assert.equal(saved.number, 44, 'numbering carries on from the Microsoft Forms responses');
  assert.equal(saved.defect_count, 0);
  assert.equal(saved.inspected_by_name, 'Sam');

  const list = await (await json('/?equipment_id=d1', 'GET')).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].photo_count, 11);

  const pdf = await fetch(`${base}/${saved.id}/pdf`, { headers: { cookie: member } });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.match(pdf.headers.get('content-disposition'), /AUAV_Inspection_DJI-M4T_1581F7K3C24C600A0RZP_\d{4}-\d{2}-\d{2}\.pdf/);
  const buf = Buffer.from(await pdf.arrayBuffer());
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(fs.existsSync(path.join(inspectionsDir(db), 'reports', `${saved.id}.pdf`)), 'the PDF is kept on file');
});

test('report numbers run on across items', async () => {
  await json('/', 'POST', await droneSubmission());
  const second = await (await json('/', 'POST', await droneSubmission())).json();
  assert.equal(second.number, 45);
});

test('answering Yes needs a note, and can mark the item unserviceable', async () => {
  const sub = await droneSubmission({ mark_unserviceable: true });
  sub.answers.motor_1 = { ...sub.answers.motor_1, defects: 'yes', notes: '' };
  let res = await json('/', 'POST', sub);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Motor 1.*describe the defect/);

  sub.answers.motor_1.notes = 'Bearing noise';
  res = await json('/', 'POST', sub);
  assert.equal(res.status, 201);
  const saved = await res.json();
  assert.equal(saved.defect_count, 1);
  assert.equal(saved.marked_unserviceable, true);
  assert.equal(db.prepare("SELECT serviceable FROM team_members WHERE id = 'd1'").get().serviceable, 0);
});

test('a clean inspection does not change serviceability, even if asked to', async () => {
  db.prepare("UPDATE team_members SET serviceable = 0 WHERE id = 'd1'").run();
  const res = await json('/', 'POST', await droneSubmission({ mark_unserviceable: true }));
  assert.equal((await res.json()).marked_unserviceable, false);
  assert.equal(db.prepare("SELECT serviceable FROM team_members WHERE id = 'd1'").get().serviceable, 0,
    'releasing kit back to service stays a manual decision');
});

test('missing answers, photos and required details are refused', async () => {
  const sub = await droneSubmission();
  delete sub.answers.prop_4;
  sub.answers.prop_3.photos = [];
  sub.details.reason = 'Because';
  const res = await json('/', 'POST', sub);
  assert.equal(res.status, 400);
  const { errors } = await res.json();
  assert.ok(errors.some((e) => /Propeller 4.*defects/.test(e)));
  assert.ok(errors.some((e) => /Propeller 3.*photo/.test(e)));
  assert.ok(errors.some((e) => /Reason for inspection/.test(e)));
});

test('a photo cannot be used by someone else, or twice', async () => {
  const theirs = (await upload(admin)).body.id;
  const sub = await droneSubmission();
  sub.answers.motor_1.photos = [theirs];
  assert.equal((await json('/', 'POST', sub)).status, 400);

  const sub2 = await droneSubmission();
  assert.equal((await json('/', 'POST', sub2)).status, 201);
  assert.equal((await json('/', 'POST', sub2)).status, 400, 'photos already in a report cannot be claimed again');
});

test('only images are accepted as photos', async () => {
  const res = await fetch(`${base}/photos`, {
    method: 'POST', headers: { 'Content-Type': 'image/png', cookie: member }, body: Buffer.from('not a picture'),
  });
  assert.equal(res.status, 400);
});

test('the viewer account cannot record inspections', async () => {
  assert.equal((await upload(viewer)).res.status, 403);
  assert.equal((await json('/', 'POST', { equipment_id: 'd1' }, viewer)).status, 403);
});

test('only equipment can be inspected', async () => {
  const res = await json('/', 'POST', await droneSubmission({ equipment_id: 'p1' }));
  assert.equal(res.status, 404);
});

test('a staged photo can be removed by its uploader, a reported one cannot', async () => {
  const { body } = await upload();
  assert.equal((await json(`/photos/${body.id}`, 'DELETE', null, admin)).status, 403);
  assert.equal((await json(`/photos/${body.id}`, 'DELETE')).status, 200);
  assert.equal((await fetch(`${base}/photos/${body.id}`, { headers: { cookie: member } })).status, 404);
});

test('only admins can delete a report, which removes its files', async () => {
  const saved = await (await json('/', 'POST', await droneSubmission())).json();
  await fetch(`${base}/${saved.id}/pdf`, { headers: { cookie: member } });
  const files = db.prepare('SELECT file FROM equipment_inspection_photos WHERE inspection_id = ?').all(saved.id)
    .map((p) => path.join(inspectionsDir(db), 'photos', p.file));
  assert.equal((await json(`/${saved.id}`, 'DELETE')).status, 403);
  assert.equal((await json(`/${saved.id}`, 'DELETE', null, admin)).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM equipment_inspection_photos').get().n, 0);
  assert.ok(files.length && files.every((f) => !fs.existsSync(f)));
  assert.ok(!fs.existsSync(path.join(inspectionsDir(db), 'reports', `${saved.id}.pdf`)));
});

test('uploads left on an abandoned form are cleared after a day', async () => {
  const { body } = await upload();
  assert.equal(removeStalePhotos(db, Date.now() + 25 * 60 * 60 * 1000), 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM equipment_inspection_photos WHERE id = ?').get(body.id).n, 0);
});

test('report filenames follow the Microsoft Forms naming', () => {
  assert.equal(
    reportFilename({ name: 'M4T', serial_number: '1581F7K3C24C600A0RZP' }, { inspected_at: '2026-10-22T01:00:00Z' }),
    'AUAV_Inspection_M4T_1581F7K3C24C600A0RZP_2026-10-22.pdf',
  );
});
