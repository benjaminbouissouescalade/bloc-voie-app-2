// src/routes/generalTests.js
// CRUD générique pour le hub "Tests généraux" (Doigts/Bras/Souplesse/Général — cf. le Finger
// Profile existant qui, lui, garde sa propre table finger_tests inchangée). Un seul type de ligne
// (test_type + payload JSONB) sert à tous les tests présents et futurs de ce hub, pour ne pas
// avoir à migrer la base à chaque nouveau test ajouté (SmartBoard, suspension sur réglette, et
// plus tard bras/souplesse/général).
const express = require('express');
const router = express.Router();
const { pool } = require('../db/schema');
const { requireAuth } = require('../middleware/auth');
const { requireClimberAccess } = require('../middleware/access');

router.use(requireAuth);
router.use('/:climberId', requireClimberAccess('climberId'));

function rowToTest(r) {
  return {
    id: r.id,
    climberId: r.climber_id,
    category: r.category,
    testType: r.test_type,
    testDate: r.test_date.toISOString().slice(0, 10),
    payload: r.payload || {},
    notes: r.notes || ''
  };
}

// GET /api/general-tests/:climberId?type=edge_hang — historique, filtrable par test_type
router.get('/:climberId', async (req, res) => {
  try {
    const type = req.query.type;
    const { rows } = type
      ? await pool.query(
          'SELECT * FROM general_tests WHERE climber_id=$1 AND test_type=$2 ORDER BY test_date DESC, created_at DESC',
          [req.params.climberId, type]
        )
      : await pool.query(
          'SELECT * FROM general_tests WHERE climber_id=$1 ORDER BY test_date DESC, created_at DESC',
          [req.params.climberId]
        );
    res.json(rows.map(rowToTest));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/general-tests/:climberId — créer (ou mettre à jour si id déjà connu) un test
router.post('/:climberId', async (req, res) => {
  const b = req.body;
  if (!b.id || !b.category || !b.testType || !b.testDate) {
    return res.status(400).json({ error: 'id, category, testType et testDate sont requis' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO general_tests (id, climber_id, category, test_type, test_date, payload, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET
         category=$3, test_type=$4, test_date=$5, payload=$6, notes=$7
       RETURNING *`,
      [b.id, req.params.climberId, b.category, b.testType, b.testDate, JSON.stringify(b.payload || {}), b.notes || '']
    );
    res.json({ ok: true, test: rowToTest(rows[0]) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/general-tests/:climberId/:testId
router.delete('/:climberId/:testId', async (req, res) => {
  try {
    await pool.query('DELETE FROM general_tests WHERE id=$1 AND climber_id=$2', [req.params.testId, req.params.climberId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
