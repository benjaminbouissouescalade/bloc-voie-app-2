// src/routes/climbers.js
const express = require('express');
const router = express.Router();
const { pool } = require('../db/schema');
const { requireAuth } = require('../middleware/auth');
const { canAccessClimber } = require('../middleware/access');

router.use(requireAuth);

// GET /api/climbers — les grimpeurs accessibles à l'utilisateur connecté
// (son propre profil + les athlètes qu'il coach s'il est admin)
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT c.* FROM climbers c
       WHERE c.id = $1
          OR c.id IN (SELECT climber_id FROM coach_athletes WHERE coach_id = $2)
       ORDER BY c.created_at ASC`,
      [req.user.climberId, req.user.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/climbers/:id — un grimpeur (si accessible)
router.get('/:id', async (req, res) => {
  try {
    const ok = await canAccessClimber(req.user, req.params.id);
    if (!ok) return res.status(403).json({ error: 'Accès refusé à ce grimpeur' });
    const { rows } = await pool.query(
      'SELECT * FROM climbers WHERE id = $1', [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Grimpeur introuvable' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/climbers — créer ou mettre à jour un grimpeur
router.post('/', async (req, res) => {
  const { id, name, color, level, trips } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'id et name requis' });
  try {
    const existing = await pool.query('SELECT id FROM climbers WHERE id=$1', [id]);
    if (existing.rows.length) {
      // Mise à jour d'un grimpeur existant : il faut y avoir accès
      const ok = await canAccessClimber(req.user, id);
      if (!ok) return res.status(403).json({ error: 'Accès refusé à ce grimpeur' });
    } else {
      // Nouveau grimpeur : autorisé pour son propre profil, ou pour un admin
      // qui crée un profil qu'il coachera lui-même
      if (id !== req.user.climberId && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Seul un coach peut créer de nouveaux profils' });
      }
    }
    const { rows } = await pool.query(
      `INSERT INTO climbers (id, name, color, level, trips)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET name=$2, color=$3, level=$4, trips=$5, updated_at=NOW()
       RETURNING *`,
      [id, name, color || '#2d5a3d', level || '7a', JSON.stringify(trips || [])]
    );
    if (!existing.rows.length && id !== req.user.climberId) {
      await pool.query(
        `INSERT INTO coach_athletes (coach_id, climber_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [req.user.id, id]
      );
    }
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/climbers/:id — modifier un grimpeur
router.put('/:id', async (req, res) => {
  const { name, color, level, trips } = req.body;
  try {
    const ok = await canAccessClimber(req.user, req.params.id);
    if (!ok) return res.status(403).json({ error: 'Accès refusé à ce grimpeur' });
    const { rows } = await pool.query(
      `UPDATE climbers SET name=$1, color=$2, level=$3, trips=$4, updated_at=NOW()
       WHERE id=$5 RETURNING *`,
      [name, color, level, JSON.stringify(trips || []), req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Grimpeur introuvable' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/climbers/:id — supprimer un grimpeur (cascade sur les logs)
router.delete('/:id', async (req, res) => {
  try {
    const ok = await canAccessClimber(req.user, req.params.id);
    if (!ok) return res.status(403).json({ error: 'Accès refusé à ce grimpeur' });
    await pool.query('DELETE FROM climbers WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
