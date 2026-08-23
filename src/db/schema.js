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
      -- Modèle de rôles owner/coach/athlete : l'ancien rôle unique "admin" (= coach unique de
      -- l'app à l'origine) devient "owner". Idempotent : sans ligne 'admin' restante, no-op.
      UPDATE users SET role = 'owner' WHERE role = 'admin';
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
      ALTER TABLE climbers ADD COLUMN IF NOT EXISTS objectives JSONB DEFAULT '[]';
      -- Objectifs de coaching "libres" sur une période (ex: cycle "Volume × 6 sur 3 semaines") : le
      -- coach fixe un objectif (goal) + un nombre de séances sur une période, sans imposer de jour
      -- précis. L'athlète pioche lui-même dans la banque (même goal) quand il veut, ce qui crée une
      -- séance réelle (logs.objective_id) et fait avancer la progression. Tableau d'objets
      -- {id, flexGoal, targetCount, startDate, endDate, cycleId, cycleName, source, assignedByCoachId}.
      -- Remplace l'ancien mécanisme "créneaux datés" (logs.flex_goal seul) jugé trop rigide.
      ALTER TABLE climbers ADD COLUMN IF NOT EXISTS cycle_objectives JSONB DEFAULT '[]';
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
      -- Origine de la séance (section "coexistence planification coach/athlète") : 'self' =
      -- créée par l'athlète lui-même (valeur par défaut, comportement historique inchangé),
      -- 'coach' = prescrite par un coach depuis l'espace Coaching, 'ai' = réservé pour une future
      -- génération automatique. assigned_by_coach_id identifie le coach quand source='coach'.
      ALTER TABLE logs ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'self';
      ALTER TABLE logs ADD COLUMN IF NOT EXISTS assigned_by_coach_id TEXT;
      -- flex_goal : quand une séance provient d'un objectif de période (climbers.cycle_objectives),
      -- trace le goal correspondant (cf. SB_GOAL_LABELS côté frontend) pour l'affichage ("🎯
      -- Objectif : Volume endurance"). objective_id relie la séance à l'objectif qu'elle fait
      -- avancer (compte de progression = nombre de logs avec ce objective_id).
      ALTER TABLE logs ADD COLUMN IF NOT EXISTS flex_goal TEXT;
      ALTER TABLE logs ADD COLUMN IF NOT EXISTS objective_id TEXT;
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
      -- 'seance' (séance complète) ou 'exercice' (bloc de contenu court à intégrer) — permet
      -- de ne pas mélanger une séance de 90min et un exercice de 10min dans la même vue.
      ALTER TABLE session_bank ADD COLUMN IF NOT EXISTS content_type TEXT DEFAULT 'seance';
      -- Favoris par utilisateur — la banque de séances reste globale/partagée, mais le statut
      -- favori est personnel au COMPTE connecté (pas à l'athlète actuellement affiché dans
      -- l'interface coach) : voir migration user_id ci-dessous.
      CREATE TABLE IF NOT EXISTS session_bank_favorites (
        climber_id  TEXT NOT NULL REFERENCES climbers(id) ON DELETE CASCADE,
        bank_id     TEXT NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (climber_id, bank_id)
      );
      -- Migration : les favoris doivent être rattachés au compte (users.id), pas au profil
      -- grimpeur actif, car un coach garde ses favoris même en changeant d'athlète affiché,
      -- et climber_id peut théoriquement changer via /api/auth/set-primary-climber alors que
      -- users.id est l'ancre stable de l'identité du compte.
      ALTER TABLE session_bank_favorites ADD COLUMN IF NOT EXISTS user_id TEXT;
      -- Backfill gardé par une vérification d'existence de climber_id : au premier boot la
      -- colonne existe encore (backfill exécuté) ; aux boots suivants elle a déjà été
      -- supprimée plus bas, donc on saute cette étape au lieu de planter au redémarrage.
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'session_bank_favorites' AND column_name = 'climber_id'
        ) THEN
          UPDATE session_bank_favorites f SET user_id = u.id
            FROM users u WHERE u.climber_id = f.climber_id AND f.user_id IS NULL;
        END IF;
      END $$;
      DELETE FROM session_bank_favorites WHERE user_id IS NULL;
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_name = 'session_bank_favorites' AND constraint_type = 'PRIMARY KEY'
            AND constraint_name = 'session_bank_favorites_pkey'
        ) THEN
          ALTER TABLE session_bank_favorites DROP CONSTRAINT session_bank_favorites_pkey;
        END IF;
      END $$;
      ALTER TABLE session_bank_favorites ALTER COLUMN user_id SET NOT NULL;
      ALTER TABLE session_bank_favorites DROP COLUMN IF EXISTS climber_id;
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_name = 'session_bank_favorites' AND constraint_type = 'PRIMARY KEY'
        ) THEN
          ALTER TABLE session_bank_favorites ADD CONSTRAINT session_bank_favorites_pkey PRIMARY KEY (user_id, bank_id);
        END IF;
      END $$;
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
      -- Mode de planification par relation coach-athlète (voir section "coexistence planification
      -- coach/athlète") : free = l'athlète gère librement, shared = les deux peuvent planifier
      -- (comportement historique, donc valeur par défaut), coach_only = le coach contrôle le
      -- prévisionnel. Appliqué côté interface uniquement pour l'instant — pas un verrou serveur,
      -- car les séances sont sauvegardées via un remplacement complet de l'historique
      -- (POST /api/logs/:climberId/sync), qui ne permet pas de distinguer "nouvelle séance
      -- ajoutée par l'athlète" au niveau de la requête.
      ALTER TABLE coach_athletes ADD COLUMN IF NOT EXISTS planning_mode TEXT DEFAULT 'shared';
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

      -- Tests généraux (hub Doigts/Bras/Souplesse/Général, cf. src/routes/generalTests.js) :
      -- table générique plutôt qu'une table par type de test, pour que chaque nouveau test
      -- (SmartBoard, suspension sur réglette, et les futurs tests bras/souplesse/général) se
      -- rattache simplement via test_type + payload JSONB, sans nouvelle migration à chaque fois.
      -- Chaque ligne est une mesure datée, jamais écrasée (sauf mise à jour explicite du même id) :
      -- ça permet historique, meilleur résultat, dernier résultat, progression % et asymétrie G/D
      -- calculés à la volée côté frontend à partir de la liste complète.
      CREATE TABLE IF NOT EXISTS general_tests (
        id          TEXT PRIMARY KEY,
        climber_id  TEXT NOT NULL REFERENCES climbers(id) ON DELETE CASCADE,
        category    TEXT NOT NULL,
        test_type   TEXT NOT NULL,
        test_date   DATE NOT NULL,
        payload     JSONB DEFAULT '{}',
        notes       TEXT DEFAULT '',
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_general_tests_lookup ON general_tests(climber_id, test_type, test_date DESC);

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

      -- Défi collectif mensuel : un objectif chiffré par crew et par mois, la progression
      -- d'équipe est la somme des progressions individuelles (mêmes métriques que les
      -- challenges privés) — pas de duplication, calculée à la volée depuis les vrais logs.
      CREATE TABLE IF NOT EXISTS crew_monthly_challenges (
        id          TEXT PRIMARY KEY,
        crew_id     TEXT NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
        month       DATE NOT NULL,
        metric      TEXT NOT NULL,
        target      NUMERIC NOT NULL,
        created_by  TEXT NOT NULL REFERENCES climbers(id) ON DELETE CASCADE,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (crew_id, month)
      );

      -- Communauté v2 : connexions 1:1 "partenaires", indépendantes des crews.
      -- Sert de base au Feed, aux profils partenaires, aux séances communes, etc.
      CREATE TABLE IF NOT EXISTS partner_invites (
        code        TEXT PRIMARY KEY,
        created_by  TEXT NOT NULL REFERENCES climbers(id) ON DELETE CASCADE,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        expires_at  TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS partnerships (
        id          TEXT PRIMARY KEY,
        climber_a   TEXT NOT NULL REFERENCES climbers(id) ON DELETE CASCADE,
        climber_b   TEXT NOT NULL REFERENCES climbers(id) ON DELETE CASCADE,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(climber_a, climber_b)
      );
      CREATE INDEX IF NOT EXISTS idx_partnerships_a ON partnerships(climber_a);
      CREATE INDEX IF NOT EXISTS idx_partnerships_b ON partnerships(climber_b);

      -- Réactions Digger (5 types fixes) sur une séance loguée — une réaction active par utilisateur.
      CREATE TABLE IF NOT EXISTS session_reactions (
        log_id      TEXT NOT NULL,
        climber_id  TEXT NOT NULL REFERENCES climbers(id) ON DELETE CASCADE,
        reaction    TEXT NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (log_id, climber_id)
      );

      -- "On grimpe ensemble" : relie plusieurs séances (une par participant) comme faisant
      -- partie d'une même sortie commune, sans dupliquer les données de chacun.
      CREATE TABLE IF NOT EXISTS session_links (
        id          TEXT NOT NULL,
        log_id      TEXT NOT NULL,
        climber_id  TEXT NOT NULL REFERENCES climbers(id) ON DELETE CASCADE,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
      -- La table a été créée à l'origine avec id TEXT PRIMARY KEY, ce qui empêchait plusieurs
      -- participants de partager le même id de groupe. On corrige ici : un id de groupe peut
      -- désormais avoir une ligne par participant, et une séance (log_id) n'appartient qu'à
      -- un seul groupe à la fois.
      ALTER TABLE session_links DROP CONSTRAINT IF EXISTS session_links_pkey;
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'session_links_log_unique') THEN
          ALTER TABLE session_links ADD CONSTRAINT session_links_log_unique UNIQUE (log_id);
        END IF;
      END $$;
      CREATE INDEX IF NOT EXISTS idx_session_links_link ON session_links(id);
      CREATE INDEX IF NOT EXISTS idx_session_links_log ON session_links(log_id);

      -- Séances proposées à des partenaires ("Séances à venir / Je participe").
      CREATE TABLE IF NOT EXISTS proposed_sessions (
        id           TEXT PRIMARY KEY,
        created_by   TEXT NOT NULL REFERENCES climbers(id) ON DELETE CASCADE,
        type         TEXT NOT NULL,
        date         DATE NOT NULL,
        time_label   TEXT DEFAULT '',
        location     TEXT DEFAULT '',
        invitees     JSONB DEFAULT '[]',
        created_at   TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS proposed_session_participants (
        proposed_id  TEXT NOT NULL REFERENCES proposed_sessions(id) ON DELETE CASCADE,
        climber_id   TEXT NOT NULL REFERENCES climbers(id) ON DELETE CASCADE,
        log_id       TEXT,
        joined_at    TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (proposed_id, climber_id)
      );

      -- Challenges privés (crew entier ou sélection de partenaires).
      CREATE TABLE IF NOT EXISTS challenges (
        id            TEXT PRIMARY KEY,
        created_by    TEXT NOT NULL REFERENCES climbers(id) ON DELETE CASCADE,
        name          TEXT NOT NULL,
        description   TEXT DEFAULT '',
        metric        TEXT NOT NULL,
        target        NUMERIC NOT NULL,
        start_date    DATE NOT NULL,
        end_date      DATE NOT NULL,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS challenge_participants (
        challenge_id  TEXT NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
        climber_id    TEXT NOT NULL REFERENCES climbers(id) ON DELETE CASCADE,
        PRIMARY KEY (challenge_id, climber_id)
      );
      -- Défi ciblant une séance précise de la banque (ex. "Voie rose, Salle X") plutôt
      -- qu'une métrique chiffrée générique. NULL pour les défis chiffrés classiques.
      ALTER TABLE challenges ADD COLUMN IF NOT EXISTS bank_id TEXT;
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
