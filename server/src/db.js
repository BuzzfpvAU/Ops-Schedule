import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function initDb() {
  const defaultPath = path.join(__dirname, '..', 'data', 'ops-schedule.db');
  const dbPath = process.env.DATABASE_PATH || defaultPath;

  // Ensure the directory exists
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const existed = fs.existsSync(dbPath);
  const db = new Database(dbPath);
  console.log(`Database: ${dbPath} (${existed ? 'existing' : 'new'})`);

  // Enable WAL mode for better concurrent access
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS team_members (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT DEFAULT '',
      location TEXT DEFAULT '',
      timezone TEXT DEFAULT 'Australia/Sydney',
      color TEXT DEFAULT '#3B82F6',
      sort_order INTEGER DEFAULT 0,
      is_equipment INTEGER DEFAULT 0,
      info_url TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now', '+10 hours')),
      updated_at TEXT DEFAULT (datetime('now', '+10 hours'))
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      color TEXT DEFAULT '#3B82F6',
      client TEXT DEFAULT '',
      file_url TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now', '+10 hours')),
      updated_at TEXT DEFAULT (datetime('now', '+10 hours'))
    );

    CREATE TABLE IF NOT EXISTS schedule_entries (
      id TEXT PRIMARY KEY,
      team_member_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      date TEXT NOT NULL,
      notes TEXT DEFAULT '',
      status TEXT DEFAULT 'tentative',
      created_at TEXT DEFAULT (datetime('now', '+10 hours')),
      updated_at TEXT DEFAULT (datetime('now', '+10 hours')),
      FOREIGN KEY (team_member_id) REFERENCES team_members(id) ON DELETE CASCADE,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_schedule_date ON schedule_entries(date);
    CREATE INDEX IF NOT EXISTS idx_schedule_member ON schedule_entries(team_member_id);
    CREATE INDEX IF NOT EXISTS idx_schedule_job ON schedule_entries(job_id);
    CREATE INDEX IF NOT EXISTS idx_schedule_member_date ON schedule_entries(team_member_id, date);

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      team_member_id TEXT NOT NULL,
      type TEXT DEFAULT 'info',
      message TEXT NOT NULL,
      date TEXT,
      job_code TEXT,
      read INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', '+10 hours')),
      FOREIGN KEY (team_member_id) REFERENCES team_members(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_notifications_member ON notifications(team_member_id, read);
  `);

  // Migrate: remove UNIQUE(team_member_id, date) to allow multiple entries per cell
  const hasUniqueConstraint = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='schedule_entries'"
  ).get();
  if (hasUniqueConstraint && hasUniqueConstraint.sql.includes('UNIQUE(team_member_id, date)')) {
    console.log('Migrating: removing UNIQUE(team_member_id, date) constraint...');
    db.transaction(() => {
    db.exec(`
      CREATE TABLE schedule_entries_new (
        id TEXT PRIMARY KEY,
        team_member_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        date TEXT NOT NULL,
        notes TEXT DEFAULT '',
        status TEXT DEFAULT 'tentative',
        created_at TEXT DEFAULT (datetime('now', '+10 hours')),
        updated_at TEXT DEFAULT (datetime('now', '+10 hours')),
        FOREIGN KEY (team_member_id) REFERENCES team_members(id) ON DELETE CASCADE,
        FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
      );
      INSERT INTO schedule_entries_new SELECT * FROM schedule_entries;
      DROP TABLE schedule_entries;
      ALTER TABLE schedule_entries_new RENAME TO schedule_entries;
      CREATE INDEX idx_schedule_date ON schedule_entries(date);
      CREATE INDEX idx_schedule_member ON schedule_entries(team_member_id);
      CREATE INDEX idx_schedule_job ON schedule_entries(job_id);
      CREATE INDEX idx_schedule_member_date ON schedule_entries(team_member_id, date);
    `);
    })();
    console.log('Migration complete: UNIQUE constraint removed');
  }

  // Migrate: add auth columns to team_members
  const columns = db.pragma('table_info(team_members)').map(c => c.name);
  if (!columns.includes('email')) {
    db.exec(`ALTER TABLE team_members ADD COLUMN email TEXT`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_team_members_email ON team_members(email) WHERE email IS NOT NULL`);
  }
  if (!columns.includes('password_hash')) {
    db.exec(`ALTER TABLE team_members ADD COLUMN password_hash TEXT`);
  }
  if (!columns.includes('is_admin')) {
    db.exec(`ALTER TABLE team_members ADD COLUMN is_admin INTEGER DEFAULT 0`);
  }
  if (!columns.includes('must_change_password')) {
    db.exec(`ALTER TABLE team_members ADD COLUMN must_change_password INTEGER DEFAULT 0`);
  }
  if (!columns.includes('is_viewer')) {
    db.exec(`ALTER TABLE team_members ADD COLUMN is_viewer INTEGER DEFAULT 0`);
  }

  // Migrate: add equipment-specific columns
  if (!columns.includes('serial_number')) {
    db.exec(`ALTER TABLE team_members ADD COLUMN serial_number TEXT DEFAULT ''`);
  }
  if (!columns.includes('dimensions')) {
    db.exec(`ALTER TABLE team_members ADD COLUMN dimensions TEXT DEFAULT ''`);
  }
  if (!columns.includes('weight')) {
    db.exec(`ALTER TABLE team_members ADD COLUMN weight TEXT DEFAULT ''`);
  }
  if (!columns.includes('serviceable')) {
    db.exec(`ALTER TABLE team_members ADD COLUMN serviceable INTEGER DEFAULT 1`);
  }
  if (!columns.includes('sds_url')) {
    db.exec(`ALTER TABLE team_members ADD COLUMN sds_url TEXT DEFAULT ''`);
  }
  if (!columns.includes('airtag_name')) {
    db.exec(`ALTER TABLE team_members ADD COLUMN airtag_name TEXT DEFAULT ''`);
  }
  if (!columns.includes('equipment_category')) {
    db.exec(`ALTER TABLE team_members ADD COLUMN equipment_category TEXT DEFAULT ''`);
    // Backfill categories from name/role keywords (only rows still unset)
    const backfill = (kw, cat) => db.prepare(
      `UPDATE team_members SET equipment_category = ?
       WHERE is_equipment = 1 AND equipment_category = ''
         AND (lower(COALESCE(role,'')) LIKE ? OR lower(COALESCE(name,'')) LIKE ?)`
    ).run(cat, `%${kw}%`, `%${kw}%`);
    backfill('battery', 'Batteries');
    backfill('payload', 'Payloads');
    backfill('camera', 'Payloads');
    backfill('sensor', 'Payloads');
    backfill('lidar', 'Payloads');
    backfill('thermal', 'Payloads');
    backfill('survey', 'Survey Equip');
    backfill('drtk', 'Survey Equip');
    backfill('pole', 'Survey Equip');
    backfill('gnss', 'Survey Equip');
    // Anything not matched is a drone
    db.prepare(
      "UPDATE team_members SET equipment_category = 'Drones' WHERE is_equipment = 1 AND equipment_category = ''"
    ).run();
  }

  // Migrate: expand jobs into full job-readiness cards (16 Sep 2026)
  const jobColumns = db.pragma('table_info(jobs)').map(c => c.name);
  const addJobColumn = (name, ddl) => {
    if (!jobColumns.includes(name)) db.exec(`ALTER TABLE jobs ADD COLUMN ${ddl}`);
  };
  addJobColumn('job_number', `job_number TEXT DEFAULT ''`);        // external main job reference
  addJobColumn('sharepoint_url', `sharepoint_url TEXT DEFAULT ''`);
  addJobColumn('status', `status TEXT DEFAULT 'planning'`);        // planning|confirmed|active|complete|cancelled
  addJobColumn('site_address', `site_address TEXT DEFAULT ''`);
  addJobColumn('site_contact', `site_contact TEXT DEFAULT ''`);
  addJobColumn('notes', `notes TEXT DEFAULT ''`);
  addJobColumn('rental_required', `rental_required INTEGER DEFAULT 0`);
  addJobColumn('archived', `archived INTEGER DEFAULT 0`);
  addJobColumn('archived_at', `archived_at TEXT DEFAULT ''`);
  addJobColumn('state', `state TEXT DEFAULT ''`);                  // WA|VIC|QLD|NSW|NT|Processing — drives the schedule's Unallocated line
  addJobColumn('crew_size', `crew_size INTEGER DEFAULT 1`);       // job counts as unallocated while distinct rostered crew < crew_size
  addJobColumn('planned_start', `planned_start TEXT DEFAULT ''`); // planned window shown on the Unallocated line
  addJobColumn('planned_end', `planned_end TEXT DEFAULT ''`);
  addJobColumn('lead_id', `lead_id TEXT DEFAULT ''`);              // project lead (team member) running the job — the job's state follows their base location

  // Job card: readiness checklists, flights, accommodation, rentals, equipment kit
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_checklist_items (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      label TEXT NOT NULL,
      notes TEXT DEFAULT '',
      due_date TEXT DEFAULT '',
      assigned_to TEXT DEFAULT '',
      done INTEGER DEFAULT 0,
      done_by TEXT DEFAULT '',
      done_at TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', '+10 hours')),
      updated_at TEXT DEFAULT (datetime('now', '+10 hours')),
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_job_checklist_job ON job_checklist_items(job_id, category, sort_order);

    CREATE TABLE IF NOT EXISTS job_flights (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      person_id TEXT DEFAULT '',
      person_name TEXT DEFAULT '',
      direction TEXT DEFAULT 'out',
      airline TEXT DEFAULT '',
      flight_number TEXT DEFAULT '',
      depart_airport TEXT DEFAULT '',
      depart_at TEXT DEFAULT '',
      arrive_airport TEXT DEFAULT '',
      arrive_at TEXT DEFAULT '',
      booking_ref TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now', '+10 hours')),
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_job_flights_job ON job_flights(job_id);

    CREATE TABLE IF NOT EXISTS job_accommodation (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      person_id TEXT DEFAULT '',
      person_name TEXT DEFAULT '',
      venue TEXT DEFAULT '',
      address TEXT DEFAULT '',
      check_in TEXT DEFAULT '',
      check_out TEXT DEFAULT '',
      booking_ref TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now', '+10 hours')),
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_job_accommodation_job ON job_accommodation(job_id);

    CREATE TABLE IF NOT EXISTS job_rentals (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      company TEXT DEFAULT '',
      vehicle_desc TEXT DEFAULT '',
      rego TEXT DEFAULT '',
      pickup_location TEXT DEFAULT '',
      pickup_at TEXT DEFAULT '',
      return_at TEXT DEFAULT '',
      booked_under TEXT DEFAULT '',
      booking_ref TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now', '+10 hours')),
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_job_rentals_job ON job_rentals(job_id);

    CREATE TABLE IF NOT EXISTS job_equipment (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      equipment_id TEXT NOT NULL,
      assigned_to TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now', '+10 hours')),
      UNIQUE(job_id, equipment_id),
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
      FOREIGN KEY (equipment_id) REFERENCES team_members(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_job_equipment_job ON job_equipment(job_id);
  `);

  // Migrate: equipment transit windows on job_equipment (minutes; 0 = hand-carried)
  const jeColumns = db.pragma('table_info(job_equipment)').map(c => c.name);
  if (!jeColumns.includes('transit_before')) {
    db.exec(`ALTER TABLE job_equipment ADD COLUMN transit_before INTEGER DEFAULT 0`);
  }
  if (!jeColumns.includes('transit_after')) {
    db.exec(`ALTER TABLE job_equipment ADD COLUMN transit_after INTEGER DEFAULT 0`);
  }

  // Per-person compliance records (site inductions, White Card, licences, medicals…)
  db.exec(`
    CREATE TABLE IF NOT EXISTS member_compliance (
      id TEXT PRIMARY KEY,
      team_member_id TEXT NOT NULL,
      type TEXT NOT NULL,
      reference TEXT DEFAULT '',
      site TEXT DEFAULT '',
      issued_at TEXT DEFAULT '',
      expires_at TEXT DEFAULT '',
      file_url TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now', '+10 hours')),
      updated_at TEXT DEFAULT (datetime('now', '+10 hours')),
      FOREIGN KEY (team_member_id) REFERENCES team_members(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_member_compliance_member ON member_compliance(team_member_id);
  `);

  // ── Planning workflow (18 Sep 2026) ─────────────────────────────────────
  // Gate tiers on checklist items (required + stage), job types, and per-job
  // required compliance records. See docs/superpowers/specs/2026-09-18-*.
  const jcCols = db.pragma('table_info(job_checklist_items)').map(c => c.name);
  if (!jcCols.includes('required')) {
    db.exec(`ALTER TABLE job_checklist_items ADD COLUMN required INTEGER DEFAULT 0`);
  }
  if (!jcCols.includes('stage')) {
    db.exec(`ALTER TABLE job_checklist_items ADD COLUMN stage TEXT DEFAULT ''`);
  }
  addJobColumn('job_type', `job_type TEXT DEFAULT ''`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS job_requirements (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      compliance_type TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now', '+10 hours')),
      UNIQUE(job_id, compliance_type),
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );
  `);

  // Backfill standard-template items with their gate tier. Guarded by
  // stage='' so it can never clobber a tier once set.
  const WORKFLOW_TIERS = [
    // planning gate — blocks "Confirmed"
    ['Confirm equipment kit list', 1, 'planning'],
    ['Site inductions arranged', 1, 'planning'],
    ['SWMS / JSA completed', 1, 'planning'],
    ['CASA / airspace approval', 1, 'planning'],
    ['Site access passes arranged', 1, 'planning'],
    ['Client site contact confirmed', 1, 'planning'],
    // prep gate — blocks "Active" (dispatch)
    ['Charge batteries', 1, 'active'],
    ['Pack equipment cases', 1, 'active'],
    ['Check serviceability / calibration', 1, 'active'],
    // logistics — advisory only
    ['Book accommodation', 0, 'confirmed'],
    ['Confirm check-in / check-out dates', 0, 'confirmed'],
    ['Send booking details to crew', 0, 'confirmed'],
    ['Book flights', 0, 'confirmed'],
    ['Confirm flight details with crew', 0, 'confirmed'],
    ['Check baggage / equipment allowances', 0, 'confirmed'],
    ['Assign vehicle', 0, 'confirmed'],
    ['Book rental car (if required)', 0, 'confirmed'],
    ['Confirm pickup / return details', 0, 'confirmed'],
  ];
  const tierStmt = db.prepare(
    `UPDATE job_checklist_items SET required = ?, stage = ? WHERE label = ? AND stage = ''`
  );
  for (const [label, required, stage] of WORKFLOW_TIERS) {
    tierStmt.run(required, stage, label);
  }

  // Equipment allocation: buffer pads + allocation status + kits.
  const jeAllocCols = db.pragma('table_info(job_equipment)').map(c => c.name);
  if (!jeAllocCols.includes('status')) {
    db.exec(`ALTER TABLE job_equipment ADD COLUMN status TEXT DEFAULT 'tentative'`);
  }
  if (!jeAllocCols.includes('pad_before')) {
    db.exec(`ALTER TABLE job_equipment ADD COLUMN pad_before INTEGER DEFAULT 1`);
  }
  if (!jeAllocCols.includes('pad_after')) {
    db.exec(`ALTER TABLE job_equipment ADD COLUMN pad_after INTEGER DEFAULT 1`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS equipment_kits (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      notes TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now', '+10 hours')),
      updated_at TEXT DEFAULT (datetime('now', '+10 hours'))
    );
    CREATE TABLE IF NOT EXISTS equipment_kit_items (
      id TEXT PRIMARY KEY,
      kit_id TEXT NOT NULL,
      equipment_id TEXT NOT NULL,
      UNIQUE(kit_id, equipment_id),
      FOREIGN KEY (kit_id) REFERENCES equipment_kits(id) ON DELETE CASCADE,
      FOREIGN KEY (equipment_id) REFERENCES team_members(id) ON DELETE CASCADE
    );
  `);

  // Equipment location history (AirTag pings + manual updates)
  db.exec(`
    CREATE TABLE IF NOT EXISTS equipment_locations (
      id TEXT PRIMARY KEY,
      team_member_id TEXT NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      accuracy REAL,
      battery TEXT DEFAULT '',
      source TEXT DEFAULT 'manual',
      seen_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now', '+10 hours')),
      FOREIGN KEY (team_member_id) REFERENCES team_members(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_equipment_locations_member_seen
      ON equipment_locations(team_member_id, seen_at DESC);
  `);

  // New tables for auth
  db.exec(`
    CREATE TABLE IF NOT EXISTS passkey_credentials (
      id TEXT PRIMARY KEY,
      team_member_id TEXT NOT NULL,
      public_key TEXT NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', '+10 hours')),
      FOREIGN KEY (team_member_id) REFERENCES team_members(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id TEXT PRIMARY KEY,
      team_member_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER DEFAULT 0,
      FOREIGN KEY (team_member_id) REFERENCES team_members(id) ON DELETE CASCADE
    );
  `);

  // Calendar-subscription feed tokens — separate table (not a column on
  // team_members/jobs) so the SELECT * list endpoints never leak tokens.
  // Tokens are created lazily when a feed URL is requested in the UI.
  db.exec(`
    CREATE TABLE IF NOT EXISTS calendar_tokens (
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      created_at TEXT DEFAULT (datetime('now', '+10 hours')),
      PRIMARY KEY (entity_type, entity_id)
    );
  `);

  // Create shared viewer account if it doesn't exist
  const viewerExists = db.prepare("SELECT id FROM team_members WHERE email = 'view@auav.com.au'").get();
  if (!viewerExists) {
    const viewerHash = bcrypt.hashSync('rh2FpFcU34xvDs', 12);
    db.prepare(
      "INSERT INTO team_members (id, name, email, password_hash, is_viewer, is_admin, active) VALUES (?, 'Viewer', 'view@auav.com.au', ?, 1, 0, 1)"
    ).run(crypto.randomUUID(), viewerHash);
    console.log('Created shared viewer account: view@auav.com.au');
  }

  return db;
}
