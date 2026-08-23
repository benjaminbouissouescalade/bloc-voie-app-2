// src/routes/auth.js
const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');
const router   = express.Router();
const { pool } = require('../db/schema');
const { JWT_SECRET } = require('../middleware/auth');
const { isOwnerRole, isCoachRole } = require('../lib/roles');
const { canAccessClimber } = require('../middleware/access');

// Décode un Bearer token sans lever d'exception (retourne null si absent/invalide) —
// utilisé pour les vérifications de rôle optionnelles sur des routes historiquement publiques.
function decodeBearer(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  try { return jwt.verify(header.slice(7), JWT_SECRET); } catch (e) { return null; }
}

// Ordre de restriction croissante — utilisé pour choisir le mode le plus restrictif quand un
// athlète a plusieurs coachs (cas rare mais possible via coach_athletes).
const PLANNING_MODE_RANK = { free: 0, shared: 1, coach_only: 2 };

function uid() { return 'u_' + Date.now() + '_' + Math.random().toString(36).slice(2,8); }
function cid() { return 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2,8); }
function invToken() { return crypto.randomBytes(24).toString('hex'); }

router.post('/register', async (req, res) => {
  const { email, password, name, role, color, level } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'email, password et name requis' });
  try {
    const existing = await pool.query('SELECT COUNT(*) FROM users');
    const isFirst  = parseInt(existing.rows[0].count) === 0;
    const requestedRole = role || 'athlete';

    let userRole;
    if (isFirst) {
      // Tout premier compte de l'app = owner (bootstrap), quel que soit le rôle demandé.
      userRole = 'owner';
    } else if (requestedRole === 'owner' || requestedRole === 'coach') {
      // Créer un compte owner/coach nécessite d'être déjà owner — empêche l'auto-élévation
      // de rôle (avant ce correctif, il suffisait d'envoyer role:'admin' sans authentification).
      const caller = decodeBearer(req);
      if (!caller || !isOwnerRole(caller.role)) {
        return res.status(403).json({ error: 'Seul un owner peut créer un compte coach' });
      }
      userRole = requestedRole;
    } else {
      userRole = 'athlete';
    }

    const hash = await bcrypt.hash(password, 10);
    const userId = uid();
    const climberId = cid();
    await pool.query(`INSERT INTO climbers (id, name, color, level) VALUES ($1, $2, $3, $4)`, [climberId, name, color || '#1a4a7a', level || '7a']);
    await pool.query(`INSERT INTO users (id, email, password, name, role, climber_id) VALUES ($1,$2,$3,$4,$5,$6)`, [userId, email.toLowerCase(), hash, name, userRole, climberId]);
    const token = jwt.sign({ id: userId, email: email.toLowerCase(), name, role: userRole, climberId }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: userId, email, name, role: userRole, climberId } });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email déjà utilisé' });
    res.status(500).json({ error: err.message });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email et password requis' });
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [email.toLowerCase()]);
    if (!rows.length) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    const token = jwt.sign({ id: user.id, email: user.email, name: user.name, role: user.role, climberId: user.climber_id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role, climberId: user.climber_id } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/me', async (req, res) => {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'Non authentifié' });
  try {
    const token = header.slice(7);
    const user = jwt.verify(token, JWT_SECRET);
    res.json({ user });
  } catch (e) {
    res.status(401).json({ error: 'Token invalide' });
  }
});

router.get('/athletes', async (req, res) => {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'Non authentifié' });
  try {
    const token = header.slice(7);
    const user  = jwt.verify(token, JWT_SECRET);
    if (!isCoachRole(user.role)) return res.status(403).json({ error: 'Coach requis' });
    let rows;
    if (isOwnerRole(user.role)) {
      // Un owner voit tous les athlètes de l'app, avec leur(s) coach(s) actuel(s) — utile pour
      // la gestion des attributions coach ↔ athlète. Filtrable par ?coachId= pour voir le
      // roster d'un coach précis (correctif : avant, un coach voyait ici TOUS les athlètes,
      // tous coachs confondus, sans aucun filtre).
      const { coachId } = req.query;
      ({ rows } = coachId
        ? await pool.query(
            `SELECT u.id, u.email, u.name, u.role, u.climber_id, u.created_at, c.color, c.level FROM users u
             LEFT JOIN climbers c ON c.id = u.climber_id
             WHERE u.role = 'athlete' AND u.climber_id IN (SELECT climber_id FROM coach_athletes WHERE coach_id = $1)
             ORDER BY u.created_at DESC`,
            [coachId]
          )
        : await pool.query(
            `SELECT u.id, u.email, u.name, u.role, u.climber_id, u.created_at, c.color, c.level,
                    COALESCE((
                      SELECT json_agg(json_build_object('coachId', ca.coach_id, 'coachName', cu.name))
                      FROM coach_athletes ca JOIN users cu ON cu.id = ca.coach_id
                      WHERE ca.climber_id = u.climber_id
                    ), '[]') AS coaches
             FROM users u LEFT JOIN climbers c ON c.id = u.climber_id
             WHERE u.role = 'athlete' ORDER BY u.created_at DESC`
          ));
    } else {
      // Jointure directe (plutôt qu'un IN sur sous-requête) pour récupérer au passage le
      // planning_mode de la relation — utilisé par l'espace Coaching pour afficher/éditer le
      // mode de planification (libre/partagé/coach uniquement) de chaque athlète.
      ({ rows } = await pool.query(
        `SELECT u.id, u.email, u.name, u.role, u.climber_id, u.created_at, c.color, c.level, ca.planning_mode
         FROM users u
         JOIN coach_athletes ca ON ca.climber_id = u.climber_id AND ca.coach_id = $1
         LEFT JOIN climbers c ON c.id = u.climber_id
         WHERE u.role = 'athlete'
         ORDER BY u.created_at DESC`,
        [user.id]
      ));
    }
    res.json(rows);
  } catch (e) {
    res.status(401).json({ error: 'Token invalide' });
  }
});

// GET /api/auth/coaches — liste des coachs dédiés (owner uniquement, hors owner lui-même)
router.get('/coaches', async (req, res) => {
  const caller = decodeBearer(req);
  if (!caller || !isOwnerRole(caller.role)) return res.status(403).json({ error: 'Owner requis' });
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.name, u.role, u.climber_id, u.created_at,
              (SELECT COUNT(*) FROM coach_athletes ca WHERE ca.coach_id = u.id) AS athlete_count
       FROM users u WHERE u.role = 'coach' ORDER BY u.created_at ASC`
    );
    res.json(rows.map(r => ({
      id: r.id, email: r.email, name: r.name, role: r.role, climberId: r.climber_id,
      createdAt: r.created_at, athleteCount: parseInt(r.athlete_count, 10)
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/create-coach — crée un compte coach (owner uniquement).
// Le coach reçoit aussi son propre profil grimpeur (rôle professionnel et profil sportif
// restent deux choses indépendantes, voir src/lib/roles.js).
router.post('/create-coach', async (req, res) => {
  const caller = decodeBearer(req);
  if (!caller || !isOwnerRole(caller.role)) return res.status(403).json({ error: 'Owner requis' });
  const { email, password, name, color, level } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'email, password, name requis' });
  if (password.length < 6) return res.status(400).json({ error: 'Le mot de passe doit faire au moins 6 caractères' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const userId = uid();
    const climberId = cid();
    await pool.query(`INSERT INTO climbers (id, name, color, level) VALUES ($1,$2,$3,$4)`, [climberId, name, color || '#1a4a7a', level || '7a']);
    await pool.query(`INSERT INTO users (id, email, password, name, role, climber_id) VALUES ($1,$2,$3,$4,'coach',$5)`, [userId, email.toLowerCase(), hash, name, climberId]);
    res.json({ ok: true, userId, climberId, name, email, role: 'coach' });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email déjà utilisé' });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/set-role — promeut un compte existant en coach, ou le repasse en simple
// athlète (owner uniquement). Ne touche jamais climber_id : le profil grimpeur et son historique
// restent intacts quel que soit le rôle (rôle professionnel et profil sportif sont indépendants,
// voir src/lib/roles.js). Rétrograder un coach ne supprime pas ses lignes coach_athletes : une
// repromotion ultérieure retrouve automatiquement son roster précédent.
router.post('/set-role', async (req, res) => {
  const caller = decodeBearer(req);
  if (!caller || !isOwnerRole(caller.role)) return res.status(403).json({ error: 'Owner requis' });
  const { userId, role } = req.body || {};
  if (!userId || !['athlete', 'coach'].includes(role)) {
    return res.status(400).json({ error: 'userId et role (athlete ou coach) requis' });
  }
  try {
    const { rows } = await pool.query('SELECT role FROM users WHERE id=$1', [userId]);
    if (!rows.length) return res.status(404).json({ error: 'Compte introuvable' });
    if (isOwnerRole(rows[0].role)) return res.status(400).json({ error: 'Impossible de changer le rôle du owner' });
    await pool.query('UPDATE users SET role=$1 WHERE id=$2', [role, userId]);
    res.json({ ok: true, userId, role });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/assign-athlete — attribue un athlète (climberId) à un coach (owner uniquement).
// exclusive=true retire d'abord les autres relations existantes pour ce grimpeur (changement de coach,
// voir section "Relations de coaching" : on ne change que la relation, jamais le profil grimpeur).
router.post('/assign-athlete', async (req, res) => {
  const caller = decodeBearer(req);
  if (!caller || !isOwnerRole(caller.role)) return res.status(403).json({ error: 'Owner requis' });
  const { coachId, climberId, exclusive } = req.body || {};
  if (!coachId || !climberId) return res.status(400).json({ error: 'coachId et climberId requis' });
  try {
    const { rows: coachRows } = await pool.query('SELECT role FROM users WHERE id=$1', [coachId]);
    if (!coachRows.length || !isCoachRole(coachRows[0].role)) {
      return res.status(400).json({ error: 'coachId invalide (pas un compte coach)' });
    }
    if (exclusive) await pool.query('DELETE FROM coach_athletes WHERE climber_id=$1', [climberId]);
    await pool.query('INSERT INTO coach_athletes (coach_id, climber_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [coachId, climberId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/auth/assign-athlete/:coachId/:climberId — retire un athlète d'un coach (owner uniquement)
router.delete('/assign-athlete/:coachId/:climberId', async (req, res) => {
  const caller = decodeBearer(req);
  if (!caller || !isOwnerRole(caller.role)) return res.status(403).json({ error: 'Owner requis' });
  try {
    await pool.query('DELETE FROM coach_athletes WHERE coach_id=$1 AND climber_id=$2', [req.params.coachId, req.params.climberId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/set-planning-mode — règle le mode de planification (free/shared/coach_only)
// pour une relation coach-athlète donnée. Un coach ne peut régler que sur ses propres athlètes ;
// un owner peut le faire pour n'importe quelle relation. Appliqué côté interface uniquement
// (voir commentaire sur la colonne dans src/db/schema.js).
router.post('/set-planning-mode', async (req, res) => {
  const caller = decodeBearer(req);
  if (!caller || !isCoachRole(caller.role)) return res.status(403).json({ error: 'Coach requis' });
  const { coachId, climberId, mode } = req.body || {};
  if (!coachId || !climberId || !['free', 'shared', 'coach_only'].includes(mode)) {
    return res.status(400).json({ error: 'coachId, climberId et mode (free/shared/coach_only) requis' });
  }
  if (!isOwnerRole(caller.role) && caller.id !== coachId) {
    return res.status(403).json({ error: 'Tu ne peux régler le mode que sur tes propres athlètes' });
  }
  try {
    const { rows } = await pool.query(
      'UPDATE coach_athletes SET planning_mode=$1 WHERE coach_id=$2 AND climber_id=$3 RETURNING *',
      [mode, coachId, climberId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Relation coach-athlète introuvable' });
    res.json({ ok: true, coachId, climberId, mode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/my-planning-mode — mode applicable au compte connecté : le plus restrictif parmi
// ses relations de coaching, ou 'free' si aucun coach (un athlète doit pouvoir utiliser Digger
// même sans coach, voir section "Athlete" du modèle de rôles).
router.get('/my-planning-mode', async (req, res) => {
  const caller = decodeBearer(req);
  if (!caller) return res.status(401).json({ error: 'Non authentifié' });
  try {
    const { rows } = await pool.query(
      `SELECT ca.planning_mode, u.name AS coach_name FROM coach_athletes ca
       JOIN users u ON u.id = ca.coach_id WHERE ca.climber_id = $1`,
      [caller.climberId]
    );
    if (!rows.length) return res.json({ mode: 'free', coachName: null });
    let best = rows[0];
    for (const r of rows) {
      if ((PLANNING_MODE_RANK[r.planning_mode] || 0) > (PLANNING_MODE_RANK[best.planning_mode] || 0)) best = r;
    }
    res.json({ mode: best.planning_mode || 'shared', coachName: best.coach_name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/invite', async (req, res) => {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'Non authentifié' });
  try {
    const token = header.slice(7);
    const admin = jwt.verify(token, JWT_SECRET);
    if (!isCoachRole(admin.role)) return res.status(403).json({ error: 'Coach requis' });
    const { email, password, name, color, level } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: 'email, password, name requis' });
    const hash = await bcrypt.hash(password, 10);
    const userId = uid();
    const climberId = cid();
    await pool.query(`INSERT INTO climbers (id, name, color, level) VALUES ($1,$2,$3,$4)`, [climberId, name, color || '#1a4a7a', level || '7a']);
    await pool.query(`INSERT INTO users (id, email, password, name, role, climber_id) VALUES ($1,$2,$3,$4,'athlete',$5)`, [userId, email.toLowerCase(), hash, name, climberId]);
    await pool.query(`INSERT INTO coach_athletes (coach_id, climber_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [admin.id, climberId]);
    res.json({ ok: true, userId, climberId, name, email });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email déjà utilisé' });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/set-primary-climber — relie le compte connecté à un autre profil grimpeur
// (utile quand le compte a été créé avant qu'un profil existant ne lui soit rattaché)
router.post('/set-primary-climber', async (req, res) => {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'Non authentifié' });
  try {
    const token = header.slice(7);
    const user = jwt.verify(token, JWT_SECRET);
    const { climberId } = req.body;
    if (!climberId) return res.status(400).json({ error: 'climberId requis' });
    // Vérifie l'accès : son propre profil actuel, un profil coaché (coach_athletes),
    // ou n'importe quel profil si owner.
    const ok = await canAccessClimber(user, climberId);
    if (!ok) return res.status(403).json({ error: 'Accès refusé à ce profil' });
    const { rows: climberRows } = await pool.query('SELECT * FROM climbers WHERE id=$1', [climberId]);
    if (!climberRows.length) return res.status(404).json({ error: 'Profil introuvable' });
    const oldClimberId = user.climberId;
    await pool.query('UPDATE users SET climber_id=$1 WHERE id=$2', [climberId, user.id]);
    // Garde l'ancien profil accessible en tant que profil coaché, s'il existe encore
    if (oldClimberId && oldClimberId !== climberId) {
      await pool.query(
        'INSERT INTO coach_athletes (coach_id, climber_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [user.id, oldClimberId]
      );
    }
    const newToken = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role, climberId },
      JWT_SECRET, { expiresIn: '30d' }
    );
    res.json({ token: newToken, user: { id: user.id, email: user.email, name: user.name, role: user.role, climberId } });
  } catch (e) {
    res.status(401).json({ error: 'Token invalide' });
  }
});

// POST /api/auth/create-invite-link — génère un lien d'inscription (admin uniquement)
router.post('/create-invite-link', async (req, res) => {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'Non authentifié' });
  try {
    const admin = jwt.verify(header.slice(7), JWT_SECRET);
    if (!isCoachRole(admin.role)) return res.status(403).json({ error: 'Coach requis' });
    const { email } = req.body || {};
    const token = invToken();
    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); // 14 jours
    await pool.query(
      `INSERT INTO invites (token, coach_id, email, expires_at) VALUES ($1,$2,$3,$4)`,
      [token, admin.id, email || '', expiresAt]
    );
    res.json({ token, expiresAt });
  } catch (e) {
    res.status(401).json({ error: 'Token invalide' });
  }
});

// GET /api/auth/invite-info/:token — infos publiques sur une invitation (page d'onboarding)
router.get('/invite-info/:token', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT i.*, u.name AS coach_name FROM invites i
       LEFT JOIN users u ON u.id = i.coach_id
       WHERE i.token=$1`,
      [req.params.token]
    );
    if (!rows.length) return res.status(404).json({ error: 'Invitation introuvable' });
    const inv = rows[0];
    if (inv.used_at) return res.status(410).json({ error: 'Cette invitation a déjà été utilisée' });
    if (inv.expires_at && new Date(inv.expires_at) < new Date()) return res.status(410).json({ error: 'Cette invitation a expiré' });
    res.json({ coachName: inv.coach_name || 'ton coach', email: inv.email || '' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/accept-invite — crée le compte athlète depuis un lien d'invitation
router.post('/accept-invite', async (req, res) => {
  const { token, name, email, password, level, color, profile } = req.body;
  if (!token || !name || !email || !password) return res.status(400).json({ error: 'token, name, email, password requis' });
  if (password.length < 6) return res.status(400).json({ error: 'Le mot de passe doit faire au moins 6 caractères' });
  try {
    const { rows: invRows } = await pool.query('SELECT * FROM invites WHERE token=$1', [token]);
    if (!invRows.length) return res.status(404).json({ error: 'Invitation introuvable' });
    const inv = invRows[0];
    if (inv.used_at) return res.status(410).json({ error: 'Cette invitation a déjà été utilisée' });
    if (inv.expires_at && new Date(inv.expires_at) < new Date()) return res.status(410).json({ error: 'Cette invitation a expiré' });

    const hash = await bcrypt.hash(password, 10);
    const userId = uid();
    const climberId = cid();
    await pool.query(
      `INSERT INTO climbers (id, name, color, level, profile) VALUES ($1,$2,$3,$4,$5)`,
      [climberId, name, color || '#1a4a7a', level || '7a', JSON.stringify(profile || {})]
    );
    await pool.query(
      `INSERT INTO users (id, email, password, name, role, climber_id) VALUES ($1,$2,$3,$4,'athlete',$5)`,
      [userId, email.toLowerCase(), hash, name, climberId]
    );
    await pool.query(
      `INSERT INTO coach_athletes (coach_id, climber_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [inv.coach_id, climberId]
    );
    await pool.query('UPDATE invites SET used_at=NOW() WHERE token=$1', [token]);

    const jwtToken = jwt.sign(
      { id: userId, email: email.toLowerCase(), name, role: 'athlete', climberId },
      JWT_SECRET, { expiresIn: '30d' }
    );
    res.json({ token: jwtToken, user: { id: userId, email, name, role: 'athlete', climberId } });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email déjà utilisé' });
    res.status(500).json({ error: err.message });
  }
});

router.post('/change-password', async (req, res) => {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'Non authentifié' });
  try {
    const token = header.slice(7);
    const user = jwt.verify(token, JWT_SECRET);
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'currentPassword et newPassword requis' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Le nouveau mot de passe doit faire au moins 6 caractères' });
    const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Utilisateur introuvable' });
    const ok = await bcrypt.compare(currentPassword, rows[0].password);
    if (!ok) return res.status(401).json({ error: 'Mot de passe actuel incorrect' });
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password=$1 WHERE id=$2', [hash, user.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
