// src/routes/testAssignments.js
// Prescription d'un test personnalisé (custom_test_types) à UN athlète pour UNE date (retour
// utilisateur : "sur les tests personnalisés créés par le coach, la possibilité de le mettre pour
// une personne à une date"). Ne stocke qu'une prescription — le résultat réel loggué par
// l'athlète reste dans general_tests comme avant (cf. src/routes/generalTests.js) ; result_id
// relie juste la prescription au résultat une fois faite (cf. POST /:id/complete).
const express = require('express');
const router = express.Router();
const { pool } = require('../db/schema');
const { requireAuth } = require('../middleware/auth');
const { requireClimberAccess, canAccessClimber } = require('../middleware/access');
const { isCoachRole } = require('../lib/roles');

router.use(requireAuth);

function rowToAssignment(r) {
  return {
    id: r.id,
    climberId: r.climber_id,
    testTypeId: r.test_type_id,
    date: r.date.toISOString().slice(0, 10),
    note: r.note || '',
    assignedByCoachId: r.assigned_by_coach_id || '',
    done: !!r.done,
    resultId: r.result_id || '',
    createdAt: new Date(r.created_at).getTime()
  };
}

// ─────────────────────────────────────────────────────────────────────────
// GET /mine déclarée AVANT GET /:climberId, pour ne jamais être interceptée par la route
// générique à un seul segment (même précaution que /favorites vs /:id dans bank.js).
// ─────────────────────────────────────────────────────────────────────────

// GET /api/test-assignments/mine?testTypeId=xxx — toutes les prescriptions faites par LE COACH
// connecté (tous ses athlètes), optionnellement filtrées par type de test — sert à afficher, dans
// l'éditeur d'un test personnalisé, la liste "qui doit faire ce test et quand".
router.get('/mine', async (req, res) => {
  if (!isCoachRole(req.user?.role)) return res.json([]);
  try {
    const { testTypeId } = req.query;
    const params = [req.user.id];
    let sql = 'SELECT * FROM test_assignments WHERE assigned_by_coach_id=$1';
    if (testTypeId) { sql += ' AND test_type_id=$2'; params.push(testTypeId); }
    sql += ' ORDER BY date DESC';
    const { rows } = await pool.query(sql, params);
    res.json(rows.map(rowToAssignment));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/test-assignments/:id/complete — relie une prescription au résultat une fois loggué
// (appelé automatiquement par le frontend quand un résultat correspondant est enregistré, que ce
// soit par le coach ou par l'athlète lui-même — d'où la vérification d'accès climber plutôt qu'une
// restriction au rôle coach).
router.post('/:id/complete', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT climber_id FROM test_assignments WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.json({ ok: true }); // déjà absente/annulée : idempotent
    const ok = await canAccessClimber(req.user, rows[0].climber_id);
    if (!ok) return res.status(403).json({ error: 'Accès refusé à ce grimpeur' });
    const resultId = req.body?.resultId || '';
    await pool.query('UPDATE test_assignments SET done=true, result_id=$1 WHERE id=$2', [resultId, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/test-assignments/:climberId — prescriptions d'UN athlète (vue athlète : "tests à
// faire"), aussi utilisée côté coach pour afficher le badge sur la fiche actuellement affichée.
router.get('/:climberId', requireClimberAccess('climberId'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM test_assignments WHERE climber_id=$1 ORDER BY date DESC',
      [req.params.climberId]
    );
    res.json(rows.map(rowToAssignment));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/test-assignments — un coach programme un test personnalisé pour un de ses athlètes
router.post('/', async (req, res) => {
  if (!isCoachRole(req.user?.role)) return res.status(403).json({ error: 'Réservé aux coachs.' });
  const { id, climberId, testTypeId, date, note } = req.body;
  if (!id || !climberId || !testTypeId || !date) {
    return res.status(400).json({ error: 'id, climberId, testTypeId et date requis' });
  }
  const ok = await canAccessClimber(req.user, climberId);
  if (!ok) return res.status(403).json({ error: 'Accès refusé à ce grimpeur' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO test_assignments (id, climber_id, test_type_id, date, note, assigned_by_coach_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET climber_id=$2, test_type_id=$3, date=$4, note=$5
       RETURNING *`,
      [id, climberId, testTypeId, date, note || '', req.user.id]
    );
    res.json({ ok: true, assignment: rowToAssignment(rows[0]) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/test-assignments/:id — annule une prescription (coach uniquement)
router.delete('/:id', async (req, res) => {
  if (!isCoachRole(req.user?.role)) return res.status(403).json({ error: 'Réservé aux coachs.' });
  try {
    await pool.query('DELETE FROM test_assignments WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
