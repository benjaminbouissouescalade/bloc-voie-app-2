// src/routes/logs.js
const express = require('express');
const router = express.Router();
const { pool } = require('../db/schema');
const { requireAuth } = require('../middleware/auth');
const { requireClimberAccess } = require('../middleware/access');

router.use(requireAuth);
router.use('/:climberId', requireClimberAccess('climberId'));

// GET /api/logs/:climberId — toutes les séances d'un grimpeur
router.get('/:climberId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM logs WHERE climber_id=$1 ORDER BY date DESC`,
      [req.params.climberId]
    );
    // Normalise pour le frontend
    const logs = rows.map(r => ({
      id: r.id,
      date: r.date.toISOString().slice(0, 10),
      type: r.type,
      support: r.support,
      minutes: r.minutes,
      intensity: r.intensity,
      shape: r.shape,
      location: r.location,
      notes: r.notes,
      ascents: r.ascents || [],
      bNoGrade: r.b_no_grade || {},
      planned: !!r.planned,
      bankRef: r.bank_ref || null,
      cycleId: r.cycle_id || null,
      cycleName: r.cycle_name || null,
      source: r.source || 'self',
      assignedByCoachId: r.assigned_by_coach_id || null,
      flexGoal: r.flex_goal || null,
      objectiveId: r.objective_id || null,
      comments: r.comments || [],
      injury: !!r.injury,
      injuryNote: r.injury_note || ''
    }));
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/logs/:climberId/:logId/comments — ajoute un commentaire (fil coach ↔ athlète) sur une
// séance déjà enregistrée. Jamais touché par le create/update normal ni par /sync (voir commentaire
// plus bas) : c'est le seul point d'écriture de cette colonne, en append-only via concat JSONB pour
// éviter toute perte en cas d'écritures concurrentes (coach + athlète en même temps).
router.post('/:climberId/:logId/comments', async (req, res) => {
  const message = (req.body.message || '').trim();
  if (!message) return res.status(400).json({ error: 'message requis' });
  const comment = {
    id: 'cm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    authorId: req.user.id,
    authorName: req.user.name,
    authorRole: req.user.role,
    message,
    createdAt: new Date().toISOString()
  };
  try {
    const { rows } = await pool.query(
      `UPDATE logs SET comments = COALESCE(comments, '[]'::jsonb) || $1::jsonb, updated_at = NOW()
       WHERE id=$2 AND climber_id=$3 RETURNING comments`,
      [JSON.stringify([comment]), req.params.logId, req.params.climberId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Séance introuvable' });
    res.json({ ok: true, comments: rows[0].comments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/logs/:climberId — créer ou mettre à jour une séance
router.post('/:climberId', async (req, res) => {
  const { id, date, type, support, minutes, intensity, shape, location, notes, ascents, bNoGrade, planned, bankRef, cycleId, cycleName, source, assignedByCoachId, flexGoal, objectiveId, injury, injuryNote } = req.body;
  if (!id || !date) return res.status(400).json({ error: 'id et date requis' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO logs (id, climber_id, date, type, support, minutes, intensity, shape, location, notes, ascents, b_no_grade, planned, bank_ref, cycle_id, cycle_name, source, assigned_by_coach_id, flex_goal, objective_id, injury, injury_note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
       ON CONFLICT (id) DO UPDATE SET
         date=$3, type=$4, support=$5, minutes=$6, intensity=$7, shape=$8,
         location=$9, notes=$10, ascents=$11, b_no_grade=$12, planned=$13, bank_ref=$14, cycle_id=$15, cycle_name=$16,
         source=$17, assigned_by_coach_id=$18, flex_goal=$19, objective_id=$20, injury=$21, injury_note=$22, updated_at=NOW()
       RETURNING *`,
      [id, req.params.climberId, date, type, support||'', minutes||90, intensity||3,
       shape||'normal', location||'', notes||'',
       JSON.stringify(ascents||[]), JSON.stringify(bNoGrade||{}), !!planned, bankRef||null,
       cycleId||null, cycleName||null, source||'self', assignedByCoachId||null, flexGoal||null, objectiveId||null,
       !!injury, injuryNote||'']
    );
    res.json({ ok: true, id: rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/logs/:climberId/:logId — supprimer une séance
router.delete('/:climberId/:logId', async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM logs WHERE id=$1 AND climber_id=$2',
      [req.params.logId, req.params.climberId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/logs/:climberId/sync — sync (upsert non destructif)
//
// ATTENTION — historique : cette route faisait auparavant un DELETE FROM logs WHERE
// climber_id=$1 puis réinsérait tout ce que le client envoyait. syncToBackend() (frontend)
// appelle cette route pour TOUS les grimpeurs connus du client à chaque saveDB(), c'est-à-dire
// après quasi n'importe quelle action dans l'app, pas seulement quand on modifie ce grimpeur.
// Si un client avait un état local incomplet ou périmé pour un grimpeur (onglet resté ouvert
// longtemps, séance ajoutée entre-temps depuis un autre appareil ou par l'athlète lui-même,
// etc.), le prochain resync — déclenché par une action totalement sans rapport — effaçait
// silencieusement et DÉFINITIVEMENT les séances absentes de ce payload périmé. C'est la cause
// confirmée du bug "une séance d'un athlète a été effacée".
//
// Fix : on ne supprime plus jamais rien ici. On fait un upsert par id (comme la route
// POST /:climberId ci-dessus, appelée une par une). L'absence d'une séance dans le payload ne
// veut plus dire "à supprimer" — la suppression passe exclusivement par l'appel explicite
// DELETE /api/logs/:climberId/:logId (voir delete-session-btn / deletePlannedSession côté
// frontend). La colonne comments n'apparaît pas dans le SET du DO UPDATE : elle n'est donc
// jamais touchée par cette route, quel que soit l'état (potentiellement périmé) du tableau
// comments renvoyé par le client — seul POST .../comments peut l'écrire.
router.post('/:climberId/sync', async (req, res) => {
  const { logs } = req.body;
  if (!Array.isArray(logs)) return res.status(400).json({ error: 'logs[] requis' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const log of logs) {
      if (!log.id || !log.date) continue;
      await client.query(
        `INSERT INTO logs (id, climber_id, date, type, support, minutes, intensity, shape, location, notes, ascents, b_no_grade, planned, bank_ref, cycle_id, cycle_name, source, assigned_by_coach_id, flex_goal, objective_id, injury, injury_note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
         ON CONFLICT (id) DO UPDATE SET
           date=$3, type=$4, support=$5, minutes=$6, intensity=$7, shape=$8,
           location=$9, notes=$10, ascents=$11, b_no_grade=$12, planned=$13, bank_ref=$14,
           cycle_id=$15, cycle_name=$16, source=$17, assigned_by_coach_id=$18, flex_goal=$19,
           objective_id=$20, injury=$21, injury_note=$22, updated_at=NOW()`,
        [log.id, req.params.climberId, log.date, log.type, log.support||'',
         log.minutes||90, log.intensity||3, log.shape||'normal',
         log.location||'', log.notes||'',
         JSON.stringify(log.ascents||[]), JSON.stringify(log.bNoGrade||{}),
         !!log.planned, log.bankRef||null, log.cycleId||null, log.cycleName||null,
         log.source||'self', log.assignedByCoachId||null, log.flexGoal||null, log.objectiveId||null,
         !!log.injury, log.injuryNote||'']
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, synced: logs.length });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
