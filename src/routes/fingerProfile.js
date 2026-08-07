// src/routes/fingerProfile.js
const express = require('express');
const router = express.Router();
const { pool } = require('../db/schema');
const { requireAuth } = require('../middleware/auth');
const { requireClimberAccess } = require('../middleware/access');
const fingerProfile = require('../lib/fingerProfile');

router.use(requireAuth);
router.use('/:climberId', requireClimberAccess('climberId'));

function rowToTest(r) {
  return {
    id: r.id,
    climberId: r.climber_id,
    testDate: r.test_date.toISOString().slice(0, 10),
    datasetId: r.reference_dataset_id,
    bodyMassKg: r.body_mass_kg !== null ? Number(r.body_mass_kg) : null,
    rpGrade: r.rp_grade,
    rpIrcra: r.rp_ircra,
    mvcKg: r.mvc_kg !== null ? Number(r.mvc_kg) : null,
    mvcKgKg: r.mvc_kg_kg !== null ? Number(r.mvc_kg_kg) : null,
    intermittentKgSKg: r.intermittent_kg_s_kg !== null ? Number(r.intermittent_kg_s_kg) : null,
    continuousKgSKg: r.continuous_kg_s_kg !== null ? Number(r.continuous_kg_s_kg) : null,
    fingerHangS: r.finger_hang_s !== null ? Number(r.finger_hang_s) : null,
    qualityFlags: r.quality_flags || {},
    comparisonMode: r.comparison_mode,
    notes: r.notes || ''
  };
}

function testToResults(t) {
  return {
    mvc_kg_kg: t.mvcKgKg,
    intermittent_kg_s_kg: t.intermittentKgSKg,
    continuous_kg_s_kg: t.continuousKgSKg,
    finger_hang_s: t.fingerHangS
  };
}

// GET /api/finger-profile/:climberId — historique des campagnes de test d'un grimpeur
router.get('/:climberId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM finger_tests WHERE climber_id=$1 ORDER BY test_date DESC`,
      [req.params.climberId]
    );
    res.json(rows.map(rowToTest));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/finger-profile/:climberId — créer/mettre à jour une campagne de test
router.post('/:climberId', async (req, res) => {
  const b = req.body;
  if (!b.id || !b.testDate || !b.rpIrcra) {
    return res.status(400).json({ error: 'id, testDate et rpIrcra sont requis' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO finger_tests
        (id, climber_id, test_date, reference_dataset_id, body_mass_kg, rp_grade, rp_ircra,
         mvc_kg, mvc_kg_kg, intermittent_kg_s_kg, continuous_kg_s_kg, finger_hang_s,
         quality_flags, comparison_mode, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (id) DO UPDATE SET
         test_date=$3, reference_dataset_id=$4, body_mass_kg=$5, rp_grade=$6, rp_ircra=$7,
         mvc_kg=$8, mvc_kg_kg=$9, intermittent_kg_s_kg=$10, continuous_kg_s_kg=$11, finger_hang_s=$12,
         quality_flags=$13, comparison_mode=$14, notes=$15
       RETURNING *`,
      [
        b.id, req.params.climberId, b.testDate, b.datasetId || 'berta_2024',
        b.bodyMassKg ?? null, b.rpGrade || null, b.rpIrcra,
        b.mvcKg ?? null, b.mvcKgKg ?? null, b.intermittentKgSKg ?? null,
        b.continuousKgSKg ?? null, b.fingerHangS ?? null,
        JSON.stringify(b.qualityFlags || {}), b.comparisonMode || 'same_sex', b.notes || ''
      ]
    );
    res.json({ ok: true, test: rowToTest(rows[0]) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/finger-profile/:climberId/:testId
router.delete('/:climberId/:testId', async (req, res) => {
  try {
    await pool.query('DELETE FROM finger_tests WHERE id=$1 AND climber_id=$2', [req.params.testId, req.params.climberId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/finger-profile/:climberId/:testId/report?gender=male&mode=same_sex
// Recalcule le rapport de comparaison (percentiles, distribution) pour un test existant.
// gender/mode en query permettent de basculer le mode de comparaison sans re-sauver le test.
router.get('/:climberId/:testId/report', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM finger_tests WHERE id=$1 AND climber_id=$2',
      [req.params.testId, req.params.climberId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Test introuvable' });
    const t = rowToTest(rows[0]);
    const gender = req.query.gender || null;
    const mode = req.query.mode || t.comparisonMode || 'same_sex';
    if (mode === 'same_sex' && !gender) {
      return res.status(400).json({ error: 'gender requis en mode same_sex (fourni via ?gender=male|female)' });
    }
    const report = fingerProfile.buildFingerProfileReport({
      ircraTarget: t.rpIrcra,
      gender,
      mode,
      datasetId: t.datasetId,
      results: testToResults(t)
    });
    res.json({ test: t, report });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

// Route indépendante (pas de climberId) : "Expected profile for climbing level"
// Montée séparément dans server.js sur /api/finger-profile-expected pour rester en dehors
// du middleware requireClimberAccess ci-dessus (aucun grimpeur concerné, juste des distributions).
const expectedRouter = express.Router();
expectedRouter.use(requireAuth);
expectedRouter.get('/', (req, res) => {
  try {
    const ircraTarget = parseInt(req.query.ircra, 10);
    if (!Number.isFinite(ircraTarget)) return res.status(400).json({ error: 'ircra requis (entier)' });
    const gender = req.query.gender || null;
    const mode = req.query.mode || 'global';
    if (mode === 'same_sex' && !gender) {
      return res.status(400).json({ error: 'gender requis en mode same_sex' });
    }
    const datasetId = req.query.datasetId || 'berta_2024';
    const profile = fingerProfile.expectedProfileForLevel(ircraTarget, { gender, mode, datasetId });
    res.json(profile);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
module.exports.expectedRouter = expectedRouter;
