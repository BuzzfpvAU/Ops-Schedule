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
