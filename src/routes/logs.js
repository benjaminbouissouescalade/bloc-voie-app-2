// src/routes/logs.js
const express = require('express');
const router = express.Router();
const { pool } = require('../db/schema');
const { requireAuth } = require('../middleware/auth');
const { requireClimberAccess } = require('../middleware/access');

router.use(requireAuth);
router.use('/:climberId', requireClimberAccess('climberId'));

// GET /api/logs/:climberId — toutes les séances d'un grimpeur
router.get('/:climberId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM logs WHERE climber_id=$1 ORDER BY date DESC`,
      [req.params.climberId]
    );
    // Normalise pour le frontend
    const logs = rows.map(r => ({
      id: r.id,
      date: r.date.toISOString().slice(0, 10),
      type: r.type,
      support: r.support,
      minutes: r.minutes,
      intensity: r.intensity,
      shape: r.shape,
      location: r.location,
      notes: r.notes,
      ascents: r.ascents || [],
      bNoGrade: r.b_no_grade || {},
      planned: !!r.planned,
      bankRef: r.bank_ref || null,
      cycleId: r.cycle_id || null,
      cycleName: r.cycle_name || null,
      source: r.source || 'self',
      assignedByCoachId: r.assigned_by_coach_id || null,
      flexGoal: r.flex_goal || null
    }));
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/logs/:climberId — créer ou mettre à jour une séance
router.post('/:climberId', async (req, res) => {
  const { id, date, type, support, minutes, intensity, shape, location, notes, ascents, bNoGrade, planned, bankRef, cycleId, cycleName, source, assignedByCoachId, flexGoal } = req.body;
  if (!id || !date) return res.status(400).json({ error: 'id et date requis' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO logs (id, climber_id, date, type, support, minutes, intensity, shape, location, notes, ascents, b_no_grade, planned, bank_ref, cycle_id, cycle_name, source, assigned_by_coach_id, flex_goal)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       ON CONFLICT (id) DO UPDATE SET
         date=$3, type=$4, support=$5, minutes=$6, intensity=$7, shape=$8,
         location=$9, notes=$10, ascents=$11, b_no_grade=$12, planned=$13, bank_ref=$14, cycle_id=$15, cycle_name=$16,
         source=$17, assigned_by_coach_id=$18, flex_goal=$19, updated_at=NOW()
       RETURNING *`,
      [id, req.params.climberId, date, type, support||'', minutes||90, intensity||3,
       shape||'normal', location||'', notes||'',
       JSON.stringify(ascents||[]), JSON.stringify(bNoGrade||{}), !!planned, bankRef||null,
       cycleId||null, cycleName||null, source||'self', assignedByCoachId||null, flexGoal||null]
    );
    res.json({ ok: true, id: rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/logs/:climberId/:logId — supprimer une séance
router.delete('/:climberId/:logId', async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM logs WHERE id=$1 AND climber_id=$2',
      [req.params.logId, req.params.climberId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/logs/:climberId/sync — sync complète (import JSON)
router.post('/:climberId/sync', async (req, res) => {
  const { logs } = req.body;
  if (!Array.isArray(logs)) return res.status(400).json({ error: 'logs[] requis' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Supprime tout et réinsère (pour l'import complet)
    await client.query('DELETE FROM logs WHERE climber_id=$1', [req.params.climberId]);
    for (const log of logs) {
      await client.query(
        `INSERT INTO logs (id, climber_id, date, type, support, minutes, intensity, shape, location, notes, ascents, b_no_grade, planned, bank_ref, cycle_id, cycle_name, source, assigned_by_coach_id, flex_goal)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [log.id, req.params.climberId, log.date, log.type, log.support||'',
         log.minutes||90, log.intensity||3, log.shape||'normal',
         log.location||'', log.notes||'',
         JSON.stringify(log.ascents||[]), JSON.stringify(log.bNoGrade||{}),
         !!log.planned, log.bankRef||null, log.cycleId||null, log.cycleName||null,
         log.source||'self', log.assignedByCoachId||null, log.flexGoal||null]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, synced: logs.length });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
