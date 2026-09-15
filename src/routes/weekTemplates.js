// src/routes/weekTemplates.js
// Modèles de semaines réutilisables (retour utilisateur : "il me faut une option de copie de
// semaine pour pouvoir copier 3 semaines ou 2 ou 1 ou plus, mais aussi la possibilité de les
// mémoriser et les nommer et les utiliser comme cycle") — un modèle capture un bloc de séances
// déjà présentes sur un calendrier (peu importe leur origine : banque ou saisie manuelle), sous
// forme de motif { dayIndex relatif au premier jour du bloc, contenu de séance }. La capture ET
// l'application (qui crée un vrai cycle — cycleId/cycleName — exactement comme generateCycle())
// vivent entièrement côté client (cf. cwCaptureBlock/cwBuildLogsForTarget/applyWeekTemplateSubmit
// dans public/index.html) : ce fichier ne fait que stocker/lister/supprimer le JSON du modèle,
// comme testAssignments.js le fait pour les prescriptions de tests.
const express = require('express');
const router = express.Router();
const { pool } = require('../db/schema');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

function rowToTemplate(r) {
  return {
    id: r.id,
    name: r.name,
    weeks: r.weeks,
    days: r.days || [],
    createdAt: new Date(r.created_at).getTime()
  };
}

// GET /api/week-templates/mine — bibliothèque de modèles de l'utilisateur connecté (coach ou
// athlète autonome — la fonctionnalité "cycle" n'est pas réservée aux coachs dans cette appli).
router.get('/mine', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM week_templates WHERE coach_id=$1 ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json(rows.map(rowToTemplate));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/week-templates — enregistre un nouveau modèle (ou remplace si même id, même logique
// d'upsert que bank.js/testAssignments.js).
router.post('/', async (req, res) => {
  const { id, name, weeks, days } = req.body;
  if (!id || !name || !weeks || !Array.isArray(days)) {
    return res.status(400).json({ error: 'id, name, weeks et days requis' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO week_templates (id, coach_id, name, weeks, days)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET name=$3, weeks=$4, days=$5
       RETURNING *`,
      [id, req.user.id, String(name).trim(), weeks, JSON.stringify(days)]
    );
    res.json({ ok: true, template: rowToTemplate(rows[0]) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/week-templates/:id — supprime un modèle (seulement le sien).
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM week_templates WHERE id=$1 AND coach_id=$2', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
