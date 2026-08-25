// src/routes/gyms.js
// Référentiel partagé des salles/lieux d'entraînement (un seul, pas par coach) — nom + équipements
// disponibles (voies, bloc, vitesse, muscu, pan, poutre, smartboard). Consulté par tout compte
// connecté (un athlète doit pouvoir choisir sa salle en déclarant sa disponibilité), mais seul un
// coach/owner peut créer, modifier ou supprimer une salle de la liste partagée.
const express = require('express');
const router = express.Router();
const { pool } = require('../db/schema');
const { requireAuth } = require('../middleware/auth');
const { requireCoach } = require('../lib/roles');

router.use(requireAuth);

function rowToGym(r) {
  return {
    id: r.id,
    name: r.name,
    facilities: r.facilities || {},
    notes: r.notes || '',
    createdAt: r.created_at
  };
}

// GET /api/gyms — liste complète, accessible à tout compte connecté
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM gyms ORDER BY name ASC');
    res.json(rows.map(rowToGym));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/gyms — créer ou mettre à jour (id fourni par le client) — coach/owner uniquement
router.post('/', requireCoach, async (req, res) => {
  const b = req.body;
  if (!b.id || !b.name) return res.status(400).json({ error: 'id et name sont requis' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO gyms (id, name, facilities, notes)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET
         name=$2, facilities=$3, notes=$4, updated_at=NOW()
       RETURNING *`,
      [b.id, b.name, JSON.stringify(b.facilities || {}), b.notes || '']
    );
    res.json({ ok: true, gym: rowToGym(rows[0]) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/gyms/:id — coach/owner uniquement
router.delete('/:id', requireCoach, async (req, res) => {
  try {
    await pool.query('DELETE FROM gyms WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
