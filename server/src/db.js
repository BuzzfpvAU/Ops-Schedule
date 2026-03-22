import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
      UNIQUE(team_member_id, date)
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

  return db;
}
