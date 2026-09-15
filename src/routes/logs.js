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
    // deleted=false : cf. schema.js (suppression douce) — une séance supprimée ne doit plus jamais
    // revenir vers aucun client, même périmé.
    const { rows } = await pool.query(
      `SELECT * FROM logs WHERE climber_id=$1 AND deleted=false ORDER BY date DESC`,
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
      injuryNote: r.injury_note || '',
      customName: r.custom_name || '',
      checklistDone: r.checklist_done || [],
      feeling: r.feeling || '',
      // cf. schema.js (client_updated_at) — round-trip nécessaire : un log rechargé doit repartir
      // avec sa vraie estampille, sinon la toute prochaine sync le traiterait comme "jamais modifié"
      // (0) et pourrait se faire écraser par un autre appareil pourtant plus périmé que lui.
      clientUpdatedAt: parseInt(r.client_updated_at, 10) || 0
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
//
// Retour utilisateur : "des séances de la semaine passée sont passées en prévisionnel" — cf. le
// commentaire détaillé sur client_updated_at dans schema.js. La clause WHERE du DO UPDATE ci-dessous
// fait que cette route n'écrase plus jamais une version plus récente déjà en base avec une version
// plus ancienne envoyée par un client périmé : si clientUpdatedAt (payload) < client_updated_at déjà
// stocké, l'UPDATE est silencieusement ignoré (la ligne existante n'est pas touchée) et rows[0] est
// alors vide — d'où le fallback sur l'id du payload plutôt que rows[0].id.
router.post('/:climberId', async (req, res) => {
  const { id, date, type, support, minutes, intensity, shape, location, notes, ascents, bNoGrade, planned, bankRef, cycleId, cycleName, source, assignedByCoachId, flexGoal, objectiveId, injury, injuryNote, customName, checklistDone, feeling, clientUpdatedAt } = req.body;
  if (!id || !date) return res.status(400).json({ error: 'id et date requis' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO logs (id, climber_id, date, type, support, minutes, intensity, shape, location, notes, ascents, b_no_grade, planned, bank_ref, cycle_id, cycle_name, source, assigned_by_coach_id, flex_goal, objective_id, injury, injury_note, custom_name, checklist_done, feeling, client_updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)
       ON CONFLICT (id) DO UPDATE SET
         date=$3, type=$4, support=$5, minutes=$6, intensity=$7, shape=$8,
         location=$9, notes=$10, ascents=$11, b_no_grade=$12, planned=$13, bank_ref=$14, cycle_id=$15, cycle_name=$16,
         source=$17, assigned_by_coach_id=$18, flex_goal=$19, objective_id=$20, injury=$21, injury_note=$22, custom_name=$23, checklist_done=$24, feeling=$25, client_updated_at=$26, updated_at=NOW()
       WHERE $26 >= logs.client_updated_at
       RETURNING *`,
      [id, req.params.climberId, date, type, support||'', minutes||90, intensity||3,
       shape||'normal', location||'', notes||'',
       JSON.stringify(ascents||[]), JSON.stringify(bNoGrade||{}), !!planned, bankRef||null,
       cycleId||null, cycleName||null, source||'self', assignedByCoachId||null, flexGoal||null, objectiveId||null,
       !!injury, injuryNote||'', customName||'', JSON.stringify(checklistDone||[]), feeling||'', clientUpdatedAt||0]
    );
    // TRACE TEMPORAIRE (retour "elle a supprimé et elle est réapparue") — à retirer une fois la
    // cause confirmée, cf. même trace sur /sync.
    if (planned || !rows.length) {
      console.log(`[SAVE log] climberId=${req.params.climberId} id=${id} date=${date} planned=${planned} clientUpdatedAt=${clientUpdatedAt||0} rowCount=${rows.length} result=${JSON.stringify(rows[0]||null)}`);
    }
    res.json({ ok: true, id: rows[0]?.id || id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/logs/:climberId/:logId — supprimer une séance
//
// Retour utilisateur : "elle a supprimé la séance et elle est réapparue" — un vrai DELETE ne
// laisse plus aucune ligne en base pour la comparaison de fraîcheur : un autre appareil/onglet qui
// avait encore cette séance en mémoire locale (jamais rafraîchi depuis) la réinsère telle quelle
// dès qu'il resynchronise pour n'importe quelle raison, puisqu'il n'y a plus de conflit d'id pour
// déclencher la garde WHERE de POST /:climberId(/sync). Fix : suppression douce — la ligne reste en
// base (deleted=true) avec un client_updated_at fixé à MAINTENANT, donc largement plus récent que
// tout ce qu'un client périmé pourrait encore avoir en mémoire ; la garde de fraîcheur déjà en
// place bloque alors silencieusement toute tentative de réinsertion. GET filtre deleted=false, donc
// aucun client (même à jour) ne revoit jamais cette séance.
router.delete('/:climberId/:logId', async (req, res) => {
  try {
    const ts = Date.now();
    const result = await pool.query(
      'UPDATE logs SET deleted=true, client_updated_at=$3, updated_at=NOW() WHERE id=$1 AND climber_id=$2',
      [req.params.logId, req.params.climberId, ts]
    );
    // TRACE TEMPORAIRE (retour "elle a supprimé et elle est réapparue") — à retirer une fois la
    // cause confirmée. rowCount à 0 veut dire que le WHERE id/climber_id n'a matché aucune ligne
    // (id ou climberId inattendu) : la suppression n'aurait alors jamais rien touché du tout.
    console.log(`[DELETE log] climberId=${req.params.climberId} logId=${req.params.logId} ts=${ts} rowCount=${result.rowCount}`);
    res.json({ ok: true, rowCount: result.rowCount });
  } catch (err) {
    console.log(`[DELETE log] ERROR climberId=${req.params.climberId} logId=${req.params.logId}:`, err.message);
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
//
// ATTENTION — suite de l'historique : l'upsert non destructif ci-dessus a corrigé la perte
// SILENCIEUSE de séances (absentes du payload), mais pas l'écrasement d'une séance qui EXISTE
// des deux côtés avec des valeurs différentes. Cette route est appelée pour TOUS les grimpeurs
// connus du client à CHAQUE saveDB() (cf. syncToBackend), pas seulement pour le grimpeur
// concerné par l'action en cours — un onglet resté ouvert longtemps republie donc, à la moindre
// action sans rapport, son état périmé pour TOUS les autres grimpeurs qu'il connaît. Sans garde,
// l'upsert écrasait alors purement et simplement une version plus récente déjà en base (ex.
// planned redevenu true alors que la séance avait été faite entre-temps depuis un autre appareil
// — retour utilisateur : "des séances de la semaine passée sont passées en prévisionnel", vécu
// par plusieurs athlètes indépendamment). Fix : cf. client_updated_at (schema.js) — la clause
// WHERE du DO UPDATE n'applique la mise à jour que si la valeur envoyée est >= à celle déjà
// stockée ; un envoi périmé est donc maintenant silencieusement ignoré pour CE log précis, sans
// empêcher la sync des autres logs du même payload qui sont eux à jour.
router.post('/:climberId/sync', async (req, res) => {
  const { logs } = req.body;
  if (!Array.isArray(logs)) return res.status(400).json({ error: 'logs[] requis' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const log of logs) {
      if (!log.id || !log.date) continue;
      const result = await client.query(
        `INSERT INTO logs (id, climber_id, date, type, support, minutes, intensity, shape, location, notes, ascents, b_no_grade, planned, bank_ref, cycle_id, cycle_name, source, assigned_by_coach_id, flex_goal, objective_id, injury, injury_note, custom_name, checklist_done, feeling, client_updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
         ON CONFLICT (id) DO UPDATE SET
           date=$3, type=$4, support=$5, minutes=$6, intensity=$7, shape=$8,
           location=$9, notes=$10, ascents=$11, b_no_grade=$12, planned=$13, bank_ref=$14,
           cycle_id=$15, cycle_name=$16, source=$17, assigned_by_coach_id=$18, flex_goal=$19,
           objective_id=$20, injury=$21, injury_note=$22, custom_name=$23, checklist_done=$24, feeling=$25, client_updated_at=$26, updated_at=NOW()
         WHERE $26 >= logs.client_updated_at
         RETURNING id, deleted, client_updated_at, (xmax = 0) AS inserted`,
        [log.id, req.params.climberId, log.date, log.type, log.support||'',
         log.minutes||90, log.intensity||3, log.shape||'normal',
         log.location||'', log.notes||'',
         JSON.stringify(log.ascents||[]), JSON.stringify(log.bNoGrade||{}),
         !!log.planned, log.bankRef||null, log.cycleId||null, log.cycleName||null,
         log.source||'self', log.assignedByCoachId||null, log.flexGoal||null, log.objectiveId||null,
         !!log.injury, log.injuryNote||'', log.customName||'', JSON.stringify(log.checklistDone||[]), log.feeling||'', log.clientUpdatedAt||0]
      );
      // TRACE TEMPORAIRE (retour "elle a supprimé et elle est réapparue") — à retirer une fois la
      // cause confirmée. inserted=true veut dire NOUVELLE ligne (pas de conflit d'id) : si ça
      // arrive pour un log planned:true dont la date est déjà passée, c'est la preuve qu'un client
      // périmé (ancien id JAMAIS connu du serveur, ou déjà supprimé et donc absent) republie une
      // séance qu'on croyait avoir traitée — rowCount=0 (pas de ligne RETURNING) veut dire que la
      // garde de fraîcheur a bloqué une tentative de mise à jour/résurrection sur une ligne EXISTANTE.
      if (log.planned || result.rowCount === 0 || result.rows[0]?.inserted) {
        console.log(`[SYNC log] climberId=${req.params.climberId} id=${log.id} date=${log.date} planned=${log.planned} clientUpdatedAt=${log.clientUpdatedAt||0} rowCount=${result.rowCount} result=${JSON.stringify(result.rows[0]||null)}`);
      }
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
