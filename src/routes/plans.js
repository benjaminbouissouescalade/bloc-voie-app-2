// src/routes/plans.js
// Planning assigné par un coach à un grimpeur (un seul planning "actif" par grimpeur)
const express = require('express');
const router = express.Router();
const { pool } = require('../db/schema');
const { requireAuth } = require('../middleware/auth');
const { requireClimberAccess } = require('../middleware/access');

router.use(requireAuth);
router.use('/:climberId', requireClimberAccess('climberId'));

// GET /api/plans/:climberId — le planning actuellement assigné (ou null)
router.get('/:climberId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM plans WHERE climber_id=$1', [req.params.climberId]
    );
    if (!rows.length) return res.json(null);
    res.json({
      climberId: rows[0].climber_id,
      coachId: rows[0].coach_id,
      data: rows[0].data || {},
      updatedAt: rows[0].updated_at
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/plans/:climberId — créer/écraser le planning assigné
router.post('/:climberId', async (req, res) => {
  const { data } = req.body;
  if (!data) return res.status(400).json({ error: 'data requis' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO plans (climber_id, coach_id, data, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (climber_id) DO UPDATE SET coach_id=$2, data=$3, updated_at=NOW()
       RETURNING *`,
      [req.params.climberId, req.user.id, JSON.stringify(data)]
    );
    res.json({
      climberId: rows[0].climber_id,
      coachId: rows[0].coach_id,
      data: rows[0].data,
      updatedAt: rows[0].updated_at
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/plans/:climberId — retirer le planning assigné
router.delete('/:climberId', async (req, res) => {
  try {
    await pool.query('DELETE FROM plans WHERE climber_id=$1', [req.params.climberId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
