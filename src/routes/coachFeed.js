// src/routes/coachFeed.js
// Fil d'activité pour le coach : dernières séances validées (non planifiées) par ses athlètes —
// alimente le panneau "Activité récente" du dashboard coach (page "Mes athlètes"). Un owner voit
// l'activité de tous les grimpeurs, un coach seulement celle de ses propres athlètes (table
// coach_athletes, même règle que climbers.js/access.js).
const express = require('express');
const router = express.Router();
const { pool } = require('../db/schema');
const { requireAuth } = require('../middleware/auth');
const { isOwnerRole, isCoachRole } = require('../lib/roles');

router.use(requireAuth);

// GET /api/coach-feed/recent?limit=25
router.get('/recent', async (req, res) => {
  if (!isCoachRole(req.user.role) && !isOwnerRole(req.user.role)) {
    return res.status(403).json({ error: 'Coach requis' });
  }
  const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
  // Un coach est souvent aussi son propre athlète (climber_id renseigné sur son compte) : ses
  // propres séances ont déjà leur place dans son carnet perso, les remontrer ici ferait doublon
  // et noierait l'activité des vrais athlètes coachés (cf. retour "je vois mes séances, ça
  // surcharge pour rien"). On les exclut donc systématiquement du fil, owner compris.
  const ownClimberId = req.user.climberId || null;
  try {
    let query, params;
    // Tri : les séances commentées passent TOUJOURS avant celles qui ne le sont pas (peu importe
    // leur ancienneté), sinon un commentaire posté sur une séance un peu plus vieille pouvait être
    // évincé du LIMIT par des séances plus récentes mais sans intérêt particulier — cf. retour
    // "certaines séances avec commentaire n'apparaissent pas". Dans chaque groupe, la plus
    // récente activité (création ou dernier commentaire) d'abord.
    const orderClause = `ORDER BY (jsonb_array_length(COALESCE(l.comments,'[]'::jsonb)) > 0) DESC, GREATEST(l.created_at, l.updated_at) DESC LIMIT $1`;
    if (isOwnerRole(req.user.role)) {
      query = `SELECT l.id, l.climber_id, l.date, l.type, l.support, l.minutes, l.intensity, l.notes,
                      l.comments, l.created_at, l.updated_at, c.name AS climber_name, c.color AS climber_color
               FROM logs l JOIN climbers c ON c.id = l.climber_id
               WHERE l.planned = false
                 AND l.climber_id IS DISTINCT FROM $2
               ${orderClause}`;
      params = [limit, ownClimberId];
    } else {
      query = `SELECT l.id, l.climber_id, l.date, l.type, l.support, l.minutes, l.intensity, l.notes,
                      l.comments, l.created_at, l.updated_at, c.name AS climber_name, c.color AS climber_color
               FROM logs l JOIN climbers c ON c.id = l.climber_id
               WHERE l.planned = false
                 AND l.climber_id IN (SELECT climber_id FROM coach_athletes WHERE coach_id=$2)
                 AND l.climber_id IS DISTINCT FROM $3
               ${orderClause}`;
      params = [limit, req.user.id, ownClimberId];
    }
    const { rows } = await pool.query(query, params);
    res.json(rows.map(r => {
      const comments = r.comments || [];
      return {
        id: r.id,
        climberId: r.climber_id,
        climberName: r.climber_name,
        climberColor: r.climber_color,
        date: r.date.toISOString().slice(0, 10),
        type: r.type,
        support: r.support,
        minutes: r.minutes,
        intensity: r.intensity,
        notes: r.notes,
        comments,
        commentsCount: comments.length,
        createdAt: r.created_at
      };
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
