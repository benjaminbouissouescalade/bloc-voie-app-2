// src/routes/exceptions.js
// Persistance minimale pour la vue coach "exceptions" (page "Mes athlètes") : les exceptions
// elles-mêmes (séance manquée, douleur signalée, hausse de charge, objectif sans progrès) sont
// calculées côté client à partir des données déjà chargées — voir computeCoachExceptions() dans
// public/index.html et le commentaire sur la table exception_dismissals dans src/db/schema.js. Ce
// qui doit survivre à une reconnexion ou changer d'appareil, c'est uniquement le fait qu'un coach a
// déjà marqué une exception donnée comme "Vu".
const express = require('express');
const router = express.Router();
const { pool } = require('../db/schema');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

// GET /api/exceptions/dismissed — ["exception_key", ...] déjà marquées "Vu" par le compte connecté.
// Scope par req.user.id (pas par climberId) : un coach ET un owner peuvent tous deux consulter "Mes
// athlètes" (cf. .coach-only-btn côté frontend), chacun avec ses propres exceptions masquées —
// aucune vérification de rôle supplémentaire nécessaire ici, requireAuth suffit.
router.get('/dismissed', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT exception_key FROM exception_dismissals WHERE coach_id=$1',
      [req.user.id]
    );
    res.json(rows.map(r => r.exception_key));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/exceptions/dismiss — { exceptionKey } — idempotent (ON CONFLICT DO NOTHING : cliquer
// "Vu" deux fois, ou depuis deux onglets, ne fait rien de spécial la deuxième fois).
router.post('/dismiss', async (req, res) => {
  const exceptionKey = (req.body.exceptionKey || '').trim();
  if (!exceptionKey) return res.status(400).json({ error: 'exceptionKey requis' });
  try {
    await pool.query(
      'INSERT INTO exception_dismissals (coach_id, exception_key) VALUES ($1, $2) ON CONFLICT (coach_id, exception_key) DO NOTHING',
      [req.user.id, exceptionKey]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
