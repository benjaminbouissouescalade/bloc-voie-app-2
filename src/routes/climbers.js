// src/routes/climbers.js
const express = require('express');
const router = express.Router();
const { pool } = require('../db/schema');

// GET /api/climbers — liste tous les grimpeurs
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM climbers ORDER BY created_at ASC'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/climbers/:id — un grimpeur
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM climbers WHERE id = $1', [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Grimpeur introuvable' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/climbers — créer un grimpeur
router.post('/', async (req, res) => {
  const { id, name, color, level } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'id et name requis' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO climbers (id, name, color, level)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET name=$2, color=$3, level=$4, updated_at=NOW()
       RETURNING *`,
      [id, name, color || '#2d5a3d', level || '7a']
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/climbers/:id — modifier un grimpeur
router.put('/:id', async (req, res) => {
  const { name, color, level } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE climbers SET name=$1, color=$2, level=$3, updated_at=NOW()
       WHERE id=$4 RETURNING *`,
      [name, color, level, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Grimpeur introuvable' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/climbers/:id — supprimer un grimpeur (cascade sur les logs)
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM climbers WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
