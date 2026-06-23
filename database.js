const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const dbDir = path.join(__dirname, 'data');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = path.join(dbDir, 'dtv.db');
const db = new sqlite3.Database(dbPath);

// Helper to run query with Promise
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

// Helper to get single row
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

// Helper to get all rows
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// Initialize tables
async function initDb() {
  // Users table
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_approved INTEGER DEFAULT 0,
      is_admin INTEGER DEFAULT 0,
      approval_token TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Media folders table
  await run(`
    CREATE TABLE IF NOT EXISTS media_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Media items table
  await run(`
    CREATE TABLE IF NOT EXISTS media_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folder_id INTEGER,
      filepath TEXT UNIQUE NOT NULL,
      filename TEXT NOT NULL,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      duration INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (folder_id) REFERENCES media_folders(id) ON DELETE SET NULL
    )
  `);

  // Subtitles table
  await run(`
    CREATE TABLE IF NOT EXISTS subtitles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_item_id INTEGER,
      language TEXT NOT NULL,
      filepath TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (media_item_id) REFERENCES media_items(id) ON DELETE CASCADE
    )
  `);

  // Add release_date column if it doesn't exist yet (migration)
  await run(`ALTER TABLE media_items ADD COLUMN release_date TEXT`).catch(() => {});

  // TV show hierarchy columns
  await run(`ALTER TABLE media_items ADD COLUMN show_name TEXT`).catch(() => {});
  await run(`ALTER TABLE media_items ADD COLUMN season_number INTEGER`).catch(() => {});
  await run(`ALTER TABLE media_items ADD COLUMN episode_number INTEGER`).catch(() => {});
  await run(`ALTER TABLE media_items ADD COLUMN episode_title TEXT`).catch(() => {});

  // YouTube trailer key (legacy, kept for existing data)
  await run(`ALTER TABLE media_items ADD COLUMN trailer_key TEXT`).catch(() => {});

  // TMDB page URL
  await run(`ALTER TABLE media_items ADD COLUMN tmdb_url TEXT`).catch(() => {});

  // Path to 720p/2Mbps conversion stored in /conversions
  await run(`ALTER TABLE media_items ADD COLUMN conversion_path TEXT`).catch(() => {});

  // Music hierarchy
  await run(`ALTER TABLE media_items ADD COLUMN artist_name TEXT`).catch(() => {});
  await run(`ALTER TABLE media_items ADD COLUMN album_name TEXT`).catch(() => {});
  await run(`ALTER TABLE media_items ADD COLUMN track_number INTEGER`).catch(() => {});

  // Settings table
  await run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // Playback progress table
  await run(`
    CREATE TABLE IF NOT EXISTS playback_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      media_item_id INTEGER NOT NULL,
      position REAL NOT NULL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, media_item_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (media_item_id) REFERENCES media_items(id) ON DELETE CASCADE
    )
  `);

  console.log('Database tables initialized.');

  // Create admin account if configured and doesn't exist
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@dtv.local';
  const adminPassword = process.env.ADMIN_PASSWORD || 'adminpassword';

  try {
    const existingAdmin = await get('SELECT * FROM users WHERE email = ?', [adminEmail]);
    if (!existingAdmin) {
      const hash = await bcrypt.hash(adminPassword, 10);
      await run(
        'INSERT INTO users (email, password_hash, is_approved, is_admin) VALUES (?, ?, 1, 1)',
        [adminEmail, hash]
      );
      console.log(`Admin user created: ${adminEmail}`);
    } else {
      // Ensure admin user is admin and approved
      await run('UPDATE users SET is_admin = 1, is_approved = 1 WHERE email = ?', [adminEmail]);
      console.log(`Admin user verified: ${adminEmail}`);
    }
  } catch (err) {
    console.error('Error creating admin user:', err);
  }
}

module.exports = {
  db,
  initDb,
  run,
  get,
  all
};
