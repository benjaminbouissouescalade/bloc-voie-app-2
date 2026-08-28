// src/routes/bankTaxonomy.js
// Dossiers/sous-dossiers de la banque de séances ajoutés à la volée (bouton "+ Nouveau…" du
// formulaire de création de fiche), en plus de la taxonomie fixe BANK_TAXONOMY côté frontend.
// Globale et permanente comme la banque elle-même : cf. commentaire sur la table dans schema.js.
const express = require('express');
const router = express.Router();
const { pool } = require('../db/schema');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

// GET /api/bank-taxonomy — { "NomDossier": ["SousDossier1", "SousDossier2", ...], ... }
// Une entrée avec subcategory=NULL crée quand même la clé (dossier vide) si elle n'existe pas
// déjà, pour qu'un dossier créé sans sous-dossier reste visible.
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT category, subcategory FROM bank_taxonomy_custom ORDER BY created_at ASC'
    );
    const out = {};
    rows.forEach(r => {
      if (!out[r.category]) out[r.category] = [];
      if (r.subcategory && !out[r.category].includes(r.subcategory)) out[r.category].push(r.subcategory);
    });
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bank-taxonomy — { category, subcategory? } — ajoute un dossier (subcategory omis)
// ou un sous-dossier (category + subcategory), sans doublon. Ouvert à tout compte authentifié,
// comme la création de fiche elle-même (POST /api/bank, cf. ce fichier).
router.post('/', async (req, res) => {
  const category = (req.body.category || '').trim();
  const subcategory = (req.body.subcategory || '').trim() || null;
  if (!category) return res.status(400).json({ error: 'category requis' });
  try {
    if (subcategory === null) {
      // PostgreSQL ne considère jamais deux NULL comme égaux, donc ON CONFLICT ne dédoublonne
      // pas ce cas (category seule, sans sous-dossier) — on vérifie donc à la main.
      const existing = await pool.query(
        'SELECT 1 FROM bank_taxonomy_custom WHERE category=$1 AND subcategory IS NULL',
        [category]
      );
      if (!existing.rows.length) {
        await pool.query('INSERT INTO bank_taxonomy_custom (category, subcategory) VALUES ($1,NULL)', [category]);
      }
    } else {
      await pool.query(
        `INSERT INTO bank_taxonomy_custom (category, subcategory) VALUES ($1,$2)
         ON CONFLICT (category, subcategory) DO NOTHING`,
        [category, subcategory]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
