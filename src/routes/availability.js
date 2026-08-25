// src/routes/availability.js
// Disponibilité déclarée par un athlète pour les jours à venir : quelle salle (gym_id, cf.
// routes/gyms.js) et combien de temps (minutes). Scopé par climber comme general_tests —
// un coach voit la dispo de ses athlètes via requireClimberAccess (même règle que le reste
// de l'app), un athlète voit/déclare la sienne.
const express = require('express');
const router = express.Router();
const { pool } = require('../db/schema');
const { requireAuth } = require('../middleware/auth');
const { requireClimberAccess } = require('../middleware/access');

router.use(requireAuth);
router.use('/:climberId', requireClimberAccess('climberId'));

function rowToAvailability(r) {
  return {
    id: r.id,
    climberId: r.climber_id,
    date: r.date.toISOString().slice(0, 10),
    gymId: r.gym_id,
    minutes: r.minutes,
    notes: r.notes || ''
  };
}

// GET /api/availability/:climberId?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/:climberId', async (req, res) => {
  try {
    const { from, to } = req.query;
    let query = 'SELECT * FROM availability WHERE climber_id=$1';
    const params = [req.params.climberId];
    if (from) { params.push(from); query += ` AND date >= $${params.length}`; }
    if (to) { params.push(to); query += ` AND date <= $${params.length}`; }
    query += ' ORDER BY date ASC';
    const { rows } = await pool.query(query, params);
    res.json(rows.map(rowToAvailability));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/availability/:climberId — créer ou mettre à jour (id fourni par le client)
router.post('/:climberId', async (req, res) => {
  const b = req.body;
  if (!b.id || !b.date) return res.status(400).json({ error: 'id et date sont requis' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO availability (id, climber_id, date, gym_id, minutes, notes)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET
         date=$3, gym_id=$4, minutes=$5, notes=$6, updated_at=NOW()
       RETURNING *`,
      [b.id, req.params.climberId, b.date, b.gymId || null, b.minutes || 90, b.notes || '']
    );
    res.json({ ok: true, availability: rowToAvailability(rows[0]) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/availability/:climberId/:availId
router.delete('/:climberId/:availId', async (req, res) => {
  try {
    await pool.query('DELETE FROM availability WHERE id=$1 AND climber_id=$2', [req.params.availId, req.params.climberId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
