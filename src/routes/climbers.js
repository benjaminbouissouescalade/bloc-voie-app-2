// src/routes/climbers.js
const express = require('express');
const router = express.Router();
const { pool } = require('../db/schema');
const { requireAuth } = require('../middleware/auth');
const { canAccessClimber } = require('../middleware/access');
const { isOwnerRole, isCoachRole } = require('../lib/roles');

router.use(requireAuth);

// GET /api/climbers — les grimpeurs accessibles à l'utilisateur connecté
// (son propre profil + les athlètes qu'il coach ; un owner voit tous les profils)
router.get('/', async (req, res) => {
  try {
    if (isOwnerRole(req.user.role)) {
      const { rows } = await pool.query('SELECT * FROM climbers ORDER BY created_at ASC');
      return res.json(rows);
    }
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
  const { id, name, color, level, trips, profile, objectives, cycleObjectives } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'id et name requis' });
  try {
    const existing = await pool.query('SELECT id, profile, objectives, cycle_objectives FROM climbers WHERE id=$1', [id]);
    if (existing.rows.length) {
      // Mise à jour d'un grimpeur existant : il faut y avoir accès
      const ok = await canAccessClimber(req.user, id);
      if (!ok) return res.status(403).json({ error: 'Accès refusé à ce grimpeur' });
    } else {
      // Nouveau grimpeur : autorisé pour son propre profil, ou pour un coach/owner
      // qui crée un profil qu'il coachera lui-même
      if (id !== req.user.climberId && !isCoachRole(req.user.role)) {
        return res.status(403).json({ error: 'Seul un coach peut créer de nouveaux profils' });
      }
    }
    // Ne pas écraser un profil détaillé existant si le client n'en envoie pas (sync client "léger")
    const profileToSave = profile !== undefined ? profile : (existing.rows[0]?.profile || {});
    const objectivesToSave = objectives !== undefined ? objectives : (existing.rows[0]?.objectives || []);
    const cycleObjectivesToSave = cycleObjectives !== undefined ? cycleObjectives : (existing.rows[0]?.cycle_objectives || []);
    const { rows } = await pool.query(
      `INSERT INTO climbers (id, name, color, level, trips, profile, objectives, cycle_objectives)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET name=$2, color=$3, level=$4, trips=$5, profile=$6, objectives=$7, cycle_objectives=$8, updated_at=NOW()
       RETURNING *`,
      [id, name, color || '#2d5a3d', level || '7a', JSON.stringify(trips || []), JSON.stringify(profileToSave), JSON.stringify(objectivesToSave), JSON.stringify(cycleObjectivesToSave)]
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
  const { name, color, level, trips, profile, objectives, cycleObjectives } = req.body;
  try {
    const ok = await canAccessClimber(req.user, req.params.id);
    if (!ok) return res.status(403).json({ error: 'Accès refusé à ce grimpeur' });
    const existing = await pool.query('SELECT profile, objectives, cycle_objectives FROM climbers WHERE id=$1', [req.params.id]);
    const profileToSave = profile !== undefined ? profile : (existing.rows[0]?.profile || {});
    const objectivesToSave = objectives !== undefined ? objectives : (existing.rows[0]?.objectives || []);
    const cycleObjectivesToSave = cycleObjectives !== undefined ? cycleObjectives : (existing.rows[0]?.cycle_objectives || []);
    const { rows } = await pool.query(
      `UPDATE climbers SET name=$1, color=$2, level=$3, trips=$4, profile=$5, objectives=$6, cycle_objectives=$7, updated_at=NOW()
       WHERE id=$8 RETURNING *`,
      [name, color, level, JSON.stringify(trips || []), JSON.stringify(profileToSave), JSON.stringify(objectivesToSave), JSON.stringify(cycleObjectivesToSave), req.params.id]
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
