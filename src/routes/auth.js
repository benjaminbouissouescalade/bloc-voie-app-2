// src/routes/auth.js
const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const router   = express.Router();
const { pool } = require('../db/schema');
const { JWT_SECRET } = require('../middleware/auth');

function uid() { return 'u_' + Date.now() + '_' + Math.random().toString(36).slice(2,8); }
function cid() { return 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2,8); }

// POST /api/auth/register — créer un compte athlète (admin only)
// ou créer le premier admin si aucun utilisateur n'existe
router.post('/register', async (req, res) => {
  const { email, password, name, role, color, level } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'email, password et name requis' });

  try {
    // Vérifier si c'est le premier utilisateur → devient admin
    const existing = await pool.query('SELECT COUNT(*) FROM users');
    const isFirst  = parseInt(existing.rows[0].count) === 0;
    const userRole = isFirst ? 'admin' : (role || 'athlete');

    // Si pas admin et token admin requis
    if (!isFirst && userRole !== 'admin') {
      const authHeader = req.headers.authorization;
      if (!authHeader) return res.status(401).json({ error: 'Token admin requis pour créer un athlète' });
    }

    const hash = await bcrypt.hash(password, 10);
    const userId = uid();

    // Créer le profil grimpeur associé
    const climberId = cid();
    await pool.query(
      `INSERT INTO climbers (id, name, color, level) VALUES ($1, $2, $3, $4)`,
      [climberId, name, color || '#1a4a7a', level || '7a']
    );

    await pool.query(
      `INSERT INTO users (id, email, password, name, role, climber_id) VALUES ($1,$2,$3,$4,$5,$6)`,
      [userId, email.toLowerCase(), hash, name, userRole, climberId]
    );

    // Si admin, lier tous les grimpeurs existants
    if (userRole === 'admin') {
      const climbers = await pool.query('SELECT id FROM climbers WHERE id != $1', [climberId]);
      for (const c of climbers.rows) {
        await pool.query(
          `INSERT INTO coach_athletes (coach_id, climber_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [userId, c.id]
        );
      }
    }

    const token = jwt.sign(
      { id: userId, email: email.toLowerCase(), name, role: userRole, climberId },
      JWT_SECRET, { expiresIn: '30d' }
    );

    res.json({ token, user: { id: userId, email, name, role: userRole, climberId } });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email déjà utilisé' });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email et password requis' });
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [email.toLowerCase()]);
    if (!rows.length) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });

    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role, climberId: user.climber_id },
      JWT_SECRET, { expiresIn: '30d' }
    );
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role, climberId: user.climber_id } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/me — vérifier le token
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

// GET /api/auth/athletes — liste des athlètes (admin only)
router.get('/athletes', async (req, res) => {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'Non authentifié' });
  try {
    const token = header.slice(7);
    const user  = jwt.verify(token, JWT_SECRET);
    if (user.role !== 'admin') return res.status(403).json({ error: 'Admin requis' });

    const { rows } = await pool.query(`
      SELECT u.id, u.email, u.name, u.role, u.climber_id, u.created_at,
             c.color, c.level
      FROM users u
      LEFT JOIN climbers c ON c.id = u.climber_id
      WHERE u.role = 'athlete'
      ORDER BY u.created_at DESC
    `);
    res.json(rows);
  } catch (e) {
    res.status(401).json({ error: 'Token invalide' });
  }
});

// POST /api/auth/invite — créer un compte athlète (admin only)
router.post('/invite', async (req, res) => {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'Non authentifié' });
  try {
    const token = header.slice(7);
    const admin = jwt.verify(token, JWT_SECRET);
    if (admin.role !== 'admin') return res.status(403).json({ error: 'Admin requis' });

    const { email, password, name, color, level } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: 'email, password, name requis' });

    const hash       = await bcrypt.hash(password, 10);
    const userId     = uid();
    const climberId  = cid();

    await pool.query(
      `INSERT INTO climbers (id, name, color, level, owner_id) VALUES ($1,$2,$3,$4,$5)`,
      [climberId, name, color || '#1a4a7a', level || '7a', admin.id]
    );
    await pool.query(
      `INSERT INTO users (id, email, password, name, role, climber_id) VALUES ($1,$2,$3,$4,'athlete',$5)`,
      [userId, email.toLowerCase(), hash, name, climberId]
    );
    // Donner accès au coach
    await pool.query(
      `INSERT INTO coach_athletes (coach_id, climber_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [admin.id, climberId]
    );

    res.json({ ok: true, userId, climberId, name, email });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email déjà utilisé' });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
