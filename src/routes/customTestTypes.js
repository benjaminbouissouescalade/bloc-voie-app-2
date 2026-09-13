// src/routes/customTestTypes.js
// CRUD pour les types de test physique CRÉÉS PAR L'UTILISATEUR (retour : "faire un mode création
// de test physique") — vient compléter les tests codés en dur (Finger Profile, SmartBoard, edge
// hang, tractions, tirage). Ne stocke que la DÉFINITION du type (nom, catégorie, unité) ; les
// résultats loggués réutilisent la table générique general_tests (test_type = id retourné ici),
// exactement comme pour les tests codés en dur — cf. src/routes/generalTests.js.
// Global/partagé (comme session_bank) : pas de notion de propriétaire unique, visible de tous les
// comptes du déploiement.
const express = require('express');
const router = express.Router();
const { pool } = require('../db/schema');
const { requireAuth } = require('../middleware/auth');
const { isCoachRole } = require('../lib/roles');

router.use(requireAuth);

function rowToType(r) {
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    unit: r.unit || '',
    higherIsBetter: r.higher_is_better !== false,
    description: r.description || '',
    createdBy: r.created_by || '',
    createdAt: new Date(r.created_at).getTime()
  };
}

// GET /api/custom-test-types — tous les types personnalisés
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM custom_test_types ORDER BY created_at DESC');
    res.json(rows.map(rowToType));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/custom-test-types — créer (ou mettre à jour si id déjà connu) un type de test
router.post('/', async (req, res) => {
  const { id, name, category, unit, higherIsBetter, description } = req.body;
  if (!id || !String(name || '').trim()) return res.status(400).json({ error: 'id et name requis' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO custom_test_types (id, name, category, unit, higher_is_better, description, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET
         name=$2, category=$3, unit=$4, higher_is_better=$5, description=$6
       RETURNING *`,
      [id, name.trim(), category || 'general', unit || '', higherIsBetter !== false, description || '', req.user?.id || '']
    );
    res.json({ ok: true, type: rowToType(rows[0]) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/custom-test-types/:id — supprime la définition du type (les résultats déjà loggués
// dans general_tests restent en base, orphelins de leur définition mais pas perdus — cohérent avec
// le fait que general_tests.test_type est une simple chaîne, pas une clé étrangère stricte).
// Réservé aux coachs : type global/partagé par tout le déploiement (cf. commentaire en tête de
// fichier), donc une suppression touche potentiellement les autres coachs — avant ce correctif,
// n'importe quel compte authentifié (y compris un simple athlète) pouvait en supprimer un.
router.delete('/:id', async (req, res) => {
  if (!isCoachRole(req.user?.role)) return res.status(403).json({ error: 'Réservé aux coachs.' });
  try {
    await pool.query('DELETE FROM custom_test_types WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
