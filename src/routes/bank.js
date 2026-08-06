// src/routes/bank.js
const express = require('express');
const router = express.Router();
const { pool } = require('../db/schema');

// GET /api/bank — toutes les séances de la banque
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM session_bank ORDER BY created_at DESC'
    );
    const items = rows.map(r => ({
      id: r.id, name: r.name, type: r.type, support: r.support,
      level: r.level, duration: r.duration, intensity: r.intensity,
      goal: r.goal, description: r.description,
      tags: r.tags || [], source: r.source,
      category: r.category || '', subcategory: r.subcategory || '',
      crossTags: r.cross_tags || [],
      createdAt: new Date(r.created_at).getTime()
    }));
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bank — créer ou mettre à jour une séance type
router.post('/', async (req, res) => {
  const { id, name, type, support, level, duration, intensity, goal, description, tags, source, category, subcategory, crossTags } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'id et name requis' });
  try {
    await pool.query(
      `INSERT INTO session_bank (id, name, type, support, level, duration, intensity, goal, description, tags, source, category, subcategory, cross_tags)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (id) DO UPDATE SET
         name=$2, type=$3, support=$4, level=$5, duration=$6, intensity=$7,
         goal=$8, description=$9, tags=$10, source=$11, category=$12, subcategory=$13, cross_tags=$14, updated_at=NOW()`,
      [id, name, type, support||'', level||'confirme', duration||90, intensity||3,
       goal||'projet', description||'', JSON.stringify(tags||[]), source||'manual',
       category||'', subcategory||'', JSON.stringify(crossTags||[])]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/bank/:id
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM session_bank WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bank/sync — sync complète de la banque
router.post('/sync', async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items[] requis' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM session_bank');
    for (const s of items) {
      await client.query(
        `INSERT INTO session_bank (id, name, type, support, level, duration, intensity, goal, description, tags, source, category, subcategory, cross_tags)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [s.id, s.name, s.type, s.support||'', s.level||'confirme',
         s.duration||90, s.intensity||3, s.goal||'projet',
         s.description||'', JSON.stringify(s.tags||[]), s.source||'manual',
         s.category||'', s.subcategory||'', JSON.stringify(s.crossTags||[])]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, synced: items.length });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
