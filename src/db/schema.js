// src/db/schema.js
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        email       TEXT UNIQUE NOT NULL,
        password    TEXT NOT NULL,
        role        TEXT DEFAULT 'athlete',
        climber_id  TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
      ALTER TABLE users ADD COLUMN IF NOT EXISTS climber_id TEXT;
      CREATE TABLE IF NOT EXISTS climbers (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        color       TEXT DEFAULT '#2d5a3d',
        level       TEXT DEFAULT '7a',
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS logs (
        id          TEXT PRIMARY KEY,
        climber_id  TEXT NOT NULL REFERENCES climbers(id) ON DELETE CASCADE,
        date        DATE NOT NULL,
        type        TEXT NOT NULL,
        support     TEXT DEFAULT '',
        minutes     INTEGER DEFAULT 90,
        intensity   INTEGER DEFAULT 3,
        shape       TEXT DEFAULT 'normal',
        location    TEXT DEFAULT '',
        notes       TEXT DEFAULT '',
        ascents     JSONB DEFAULT '[]',
        b_no_grade  JSONB DEFAULT '{}',
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_logs_climber_date ON logs(climber_id, date DESC);
      CREATE TABLE IF NOT EXISTS session_bank (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        type        TEXT NOT NULL,
        support     TEXT DEFAULT '',
        level       TEXT DEFAULT 'confirme',
        duration    INTEGER DEFAULT 90,
        intensity   INTEGER DEFAULT 3,
        goal        TEXT DEFAULT 'projet',
        description TEXT DEFAULT '',
        tags        JSONB DEFAULT '[]',
        source      TEXT DEFAULT 'manual',
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS goals (
        id            TEXT PRIMARY KEY,
        climber_id    TEXT NOT NULL REFERENCES climbers(id) ON DELETE CASCADE,
        target_grade  TEXT,
        priority      TEXT,
        notes         TEXT DEFAULT '',
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS coach_athletes (
        coach_id    TEXT NOT NULL,
        climber_id  TEXT NOT NULL,
        PRIMARY KEY (coach_id, climber_id)
      );
    `);
    console.log('✅ Base de données initialisée');
  } catch (err) {
    console.error('❌ Erreur initialisation DB:', err.message);
    throw err;
  } finally {
    client.release();
  }
}
module.exports = { pool, initDB };
