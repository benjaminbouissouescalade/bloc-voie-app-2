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
      ALTER TABLE climbers ADD COLUMN IF NOT EXISTS trips JSONB DEFAULT '[]';
      ALTER TABLE climbers ADD COLUMN IF NOT EXISTS profile JSONB DEFAULT '{}';
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
      ALTER TABLE logs ADD COLUMN IF NOT EXISTS planned BOOLEAN DEFAULT false;
      ALTER TABLE logs ADD COLUMN IF NOT EXISTS bank_ref TEXT;
      ALTER TABLE logs ADD COLUMN IF NOT EXISTS cycle_id TEXT;
      ALTER TABLE logs ADD COLUMN IF NOT EXISTS cycle_name TEXT;
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
      ALTER TABLE session_bank ADD COLUMN IF NOT EXISTS category TEXT;
      ALTER TABLE session_bank ADD COLUMN IF NOT EXISTS subcategory TEXT;
      ALTER TABLE session_bank ADD COLUMN IF NOT EXISTS cross_tags JSONB DEFAULT '[]';
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
      CREATE TABLE IF NOT EXISTS plans (
        climber_id  TEXT PRIMARY KEY REFERENCES climbers(id) ON DELETE CASCADE,
        coach_id    TEXT,
        data        JSONB DEFAULT '{}',
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS invites (
        token       TEXT PRIMARY KEY,
        coach_id    TEXT NOT NULL,
        email       TEXT DEFAULT '',
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        expires_at  TIMESTAMPTZ,
        used_at     TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS finger_tests (
        id                    TEXT PRIMARY KEY,
        climber_id            TEXT NOT NULL REFERENCES climbers(id) ON DELETE CASCADE,
        test_date             DATE NOT NULL,
        reference_dataset_id  TEXT DEFAULT 'berta_2024',
        body_mass_kg          NUMERIC,
        rp_grade              TEXT,
        rp_ircra              INTEGER,
        mvc_kg                NUMERIC,
        mvc_kg_kg             NUMERIC,
        intermittent_kg_s_kg  NUMERIC,
        continuous_kg_s_kg    NUMERIC,
        finger_hang_s         NUMERIC,
        quality_flags         JSONB DEFAULT '{}',
        comparison_mode       TEXT DEFAULT 'same_sex',
        notes                 TEXT DEFAULT '',
        created_at            TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_finger_tests_climber ON finger_tests(climber_id, test_date DESC);

      -- Communauté / mode jeu : crews indépendants de la relation coach-athlète (peuvent
      -- rassembler des grimpeurs de coachs différents, via un code d'invitation partagé).
      CREATE TABLE IF NOT EXISTS crews (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        created_by  TEXT NOT NULL REFERENCES climbers(id) ON DELETE CASCADE,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS crew_members (
        crew_id     TEXT NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
        climber_id  TEXT NOT NULL REFERENCES climbers(id) ON DELETE CASCADE,
        joined_at   TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (crew_id, climber_id)
      );
      CREATE TABLE IF NOT EXISTS crew_invites (
        code        TEXT PRIMARY KEY,
        crew_id     TEXT NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
        created_by  TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        expires_at  TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS crew_activity (
        id          TEXT PRIMARY KEY,
        crew_id     TEXT NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
        climber_id  TEXT NOT NULL REFERENCES climbers(id) ON DELETE CASCADE,
        kind        TEXT NOT NULL,
        payload     JSONB DEFAULT '{}',
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS crew_kudos (
        id              TEXT PRIMARY KEY,
        crew_id         TEXT NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
        from_climber_id TEXT NOT NULL REFERENCES climbers(id) ON DELETE CASCADE,
        to_climber_id   TEXT NOT NULL REFERENCES climbers(id) ON DELETE CASCADE,
        week_start      DATE NOT NULL,
        emoji           TEXT DEFAULT '👏',
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_crew_members_climber ON crew_members(climber_id);
      CREATE INDEX IF NOT EXISTS idx_crew_activity_crew ON crew_activity(crew_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_crew_kudos_lookup ON crew_kudos(crew_id, to_climber_id, week_start);
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
