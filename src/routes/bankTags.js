// src/routes/bankTags.js
// Tags "styles travaillés" ajoutés à la volée (case "+ Autre…" du picker Tags du formulaire de
// création/édition de fiche), en plus de la liste fixe STYLES côté frontend. Même principe que
// bankTaxonomy.js : global et permanent comme la banque elle-même, cf. commentaire sur la table
// dans schema.js.
const express = require('express');
const router = express.Router();
const { pool } = require('../db/schema');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

// GET /api/bank-tags — ["Nom du tag", ...]
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT name FROM bank_tags_custom ORDER BY created_at ASC');
    res.json(rows.map(r => r.name));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bank-tags — { name } — ajoute un tag, sans doublon (ON CONFLICT sur le nom).
router.post('/', async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name requis' });
  try {
    await pool.query('INSERT INTO bank_tags_custom (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [name]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
