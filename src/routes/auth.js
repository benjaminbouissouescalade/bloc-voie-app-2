// src/routes/auth.js
const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');
const router   = express.Router();
const { pool } = require('../db/schema');
const { JWT_SECRET } = require('../middleware/auth');

function uid() { return 'u_' + Date.now() + '_' + Math.random().toString(36).slice(2,8); }
function cid() { return 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2,8); }
function invToken() { return crypto.randomBytes(24).toString('hex'); }

router.post('/register', async (req, res) => {
  const { email, password, name, role, color, level } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'email, password et name requis' });
  try {
    const existing = await pool.query('SELECT COUNT(*) FROM users');
    const isFirst  = parseInt(existing.rows[0].count) === 0;
    const userRole = isFirst ? 'admin' : (role || 'athlete');
    if (!isFirst && userRole !== 'admin') {
      const authHeader = req.headers.authorization;
      if (!authHeader) return res.status(401).json({ error: 'Token admin requis pour créer un athlète' });
    }
    const hash = await bcrypt.hash(password, 10);
    const userId = uid();
    const climberId = cid();
    await pool.query(`INSERT INTO climbers (id, name, color, level) VALUES ($1, $2, $3, $4)`, [climberId, name, color || '#1a4a7a', level || '7a']);
    await pool.query(`INSERT INTO users (id, email, password, name, role, climber_id) VALUES ($1,$2,$3,$4,$5,$6)`, [userId, email.toLowerCase(), hash, name, userRole, climberId]);
    if (userRole === 'admin') {
      const climbers = await pool.query('SELECT id FROM climbers WHERE id != $1', [climberId]);
      for (const c of climbers.rows) {
        await pool.query(`INSERT INTO coach_athletes (coach_id, climber_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [userId, c.id]);
      }
    }
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
    if (user.role !== 'admin') return res.status(403).json({ error: 'Admin requis' });
    const { rows } = await pool.query(`SELECT u.id, u.email, u.name, u.role, u.climber_id, u.created_at, c.color, c.level FROM users u LEFT JOIN climbers c ON c.id = u.climber_id WHERE u.role = 'athlete' ORDER BY u.created_at DESC`);
    res.json(rows);
  } catch (e) {
    res.status(401).json({ error: 'Token invalide' });
  }
});

router.post('/invite', async (req, res) => {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'Non authentifié' });
  try {
    const token = header.slice(7);
    const admin = jwt.verify(token, JWT_SECRET);
    if (admin.role !== 'admin') return res.status(403).json({ error: 'Admin requis' });
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
    // Vérifie l'accès : son propre profil actuel, ou un profil coaché (coach_athletes)
    const access = await pool.query(
      'SELECT 1 FROM coach_athletes WHERE coach_id=$1 AND climber_id=$2',
      [user.id, climberId]
    );
    if (climberId !== user.climberId && !access.rows.length) {
      return res.status(403).json({ error: 'Accès refusé à ce profil' });
    }
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
    if (admin.role !== 'admin') return res.status(403).json({ error: 'Admin requis' });
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
