// src/routes/logs.js
const express = require('express');
const router = express.Router();
const { pool } = require('../db/schema');
const { requireAuth } = require('../middleware/auth');
const { requireClimberAccess } = require('../middleware/access');
const { isCoachRole } = require('../lib/roles');
const { getPlanningModeInfo } = require('../lib/planningMode');

router.use(requireAuth);
router.use('/:climberId', requireClimberAccess('climberId'));

// ═══ Droits d'écriture sur une séance PLANIFIÉE (mode coach_only) ═══
//
// Retour utilisateur : "le mode coach_only est appliqué dans l'interface mais pas dans
// src/routes/logs.js" — planningBlockedForMe() (public/index.html) empêchait déjà l'athlète de
// planifier depuis l'UI normale, mais rien ne vérifiait la même règle côté serveur : un appel direct
// à l'API (hors interface, ou un client modifié) pouvait créer/modifier une séance planifiée sans
// passer par le coach, quel que soit le mode réglé. schema.js documentait ça comme une limite
// acceptée ("appliqué côté interface uniquement") en invoquant l'ancienne route /sync qui remplaçait
// tout l'historique d'un coup — cette raison n'existe plus depuis son passage en upsert par id
// (voir le commentaire au-dessus de POST /:climberId/sync) : chaque séance peut désormais être
// acceptée ou rejetée INDIVIDUELLEMENT, donc plus rien n'empêche de vérifier ici aussi.
//
// Matrice des droits (source de vérité désormais commune à l'UI ET au serveur, via
// src/lib/planningMode.js) :
//   - Owner       : toujours autorisé, sur n'importe quel grimpeur, séance planifiée ou réalisée.
//   - Coach       : toujours autorisé sur les grimpeurs qu'il coache (déjà vérifié plus haut par
//                   requireClimberAccess) — planifier POUR un athlète est précisément le rôle du
//                   coach en mode coach_only, jamais restreint.
//   - Athlete     : sur SON PROPRE climberId —
//       - séance RÉALISÉE (planned=false, y compris marquer "faite" une séance planifiée existante)
//         → toujours autorisé, quel que soit le mode. C'est le fonctionnement normal attendu :
//         l'athlète doit toujours pouvoir loguer ce qu'il a fait et son ressenti.
//       - séance qui RESTE planifiée (planned=true, création ou modification) → autorisé en mode
//         free/shared (comportement historique) ou sans coach du tout ; REFUSÉ (403) en mode
//         coach_only, où seul le coach doit pouvoir créer/déplacer/modifier le prévisionnel.
//
// Important (consigne explicite) : la décision ne se base JAMAIS sur req.body.source — ce champ est
// une simple métadonnée d'affichage envoyée par le client ("qui a l'air d'avoir créé cette séance"
// pour l'UI), pas une preuve d'identité. Les droits reposent uniquement sur req.user (relu en base à
// chaque requête par requireAuth, cf. middleware/auth.js — jamais un JWT non revérifié) et sur
// coach_athletes.planning_mode (en base, jamais envoyé par le client).
async function checkPlannedWriteAllowed(req, plannedValue) {
  if (!plannedValue) return null; // séance réalisée : jamais restreint, quel que soit l'appelant
  const climberId = req.params.climberId;
  const isSelfAthlete = req.user.climberId === climberId && !isCoachRole(req.user.role);
  if (!isSelfAthlete) return null; // coach/owner (ou owner agissant sur son propre profil) : jamais restreint
  const { mode, coachName } = await getPlanningModeInfo(climberId);
  if (mode !== 'coach_only') return null;
  const coach = coachName ? ` (${coachName})` : '';
  return { error: `Ton coach${coach} gère la planification de tes séances à venir. Tu peux enregistrer une séance déjà réalisée.` };
}

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
    const denial = await checkPlannedWriteAllowed(req, !!planned);
    if (denial) return res.status(403).json(denial);
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
    res.json({ ok: true, id: rows[0]?.id || id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/logs/:climberId/:logId — supprimer une séance
//
// Historique : "elle a supprimé la séance et elle est réapparue" — un vrai DELETE ne laisse plus
// aucune ligne en base pour la comparaison de fraîcheur : un autre appareil/onglet qui avait encore
// cette séance en mémoire locale (jamais rafraîchi depuis) la réinsère telle quelle dès qu'il
// resynchronise pour n'importe quelle raison, puisqu'il n'y a plus de conflit d'id pour déclencher
// la garde WHERE de POST /:climberId(/sync). Fix initial : suppression douce (UPDATE deleted=true).
//
// Suite (audit "pertes et réapparitions de séances") : ce simple UPDATE ne touchait rien
// (rowCount=0) quand la séance visée n'avait ENCORE JAMAIS été synchronisée sur le serveur — aucune
// ligne n'existait pour la marquer supprimée. Si une synchronisation concurrente (payload construit
// AVANT cette suppression, requête simplement plus lente) republiait cette même séance APRÈS ce
// DELETE, rien ne l'empêchait de la recréer : la garde de fraîcheur ne s'applique qu'à un CONFLIT
// d'id déjà existant, et ce DELETE n'en créait aucun dans ce cas précis. Fix : upsert — la ligne est
// désormais créée directement à l'état "supprimée" si elle n'existait pas encore (avec une date/un
// type de remplissage, sans conséquence : GET filtre deleted=false, cette ligne n'est jamais
// renvoyée à aucun client), sinon marquée supprimée comme avant. Résultat, dans les deux ordres
// d'arrivée possibles entre ce DELETE et une synchronisation périmée concurrente :
//  - DELETE en premier : crée la ligne "tombstone" → la sync périmée arrivant ensuite tombe sur un
//    conflit d'id, sa propre estampille (antérieure à la suppression) est plus ancienne que celle du
//    tombstone → la garde de fraîcheur déjà en place (WHERE $26 >= logs.client_updated_at, cf.
//    POST /:climberId(/sync) ci-dessous/au-dessus) bloque silencieusement sa tentative de réinsertion.
//  - Sync périmée en premier : insère normalement la séance (pas encore de conflit) → ce DELETE
//    arrivant ensuite passe par la branche ON CONFLICT DO UPDATE, sans condition de fraîcheur (une
//    suppression explicite gagne toujours) → marquée supprimée quoi qu'il arrive.
// climber_id reste vérifié même sur la branche UPDATE (WHERE logs.climber_id=$2) : un id existant
// mais appartenant à un AUTRE grimpeur (collision de clé, en pratique quasi impossible vu le format
// des ids) n'est jamais touché par erreur.
router.delete('/:climberId/:logId', async (req, res) => {
  try {
    const ts = Date.now();
    const result = await pool.query(
      `INSERT INTO logs (id, climber_id, date, type, deleted, client_updated_at)
       VALUES ($1, $2, CURRENT_DATE, 'supprime', true, $3)
       ON CONFLICT (id) DO UPDATE SET
         deleted = true,
         client_updated_at = GREATEST($3, logs.client_updated_at),
         updated_at = NOW()
       WHERE logs.climber_id = $2
       RETURNING id`,
      [req.params.logId, req.params.climberId, ts]
    );
    // rowCount=1 dans tous les cas normaux (création du tombstone ou mise à jour d'une ligne
    // existante). rowCount=0 signale spécifiquement que logId existe déjà mais appartient à un
    // AUTRE climber_id que celui demandé — cas anormal, digne d'être journalisé.
    if (result.rowCount === 0) {
      console.warn(`[DELETE log] climberId=${req.params.climberId} logId=${req.params.logId} : id existant appartenant à un autre grimpeur, suppression refusée`);
      return res.status(404).json({ ok: false, error: 'Séance introuvable pour ce grimpeur' });
    }
    res.json({ ok: true, rowCount: result.rowCount });
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
  // Même règle que POST /:climberId ci-dessus (cf. checkPlannedWriteAllowed), appliquée
  // séance par séance : un batch peut mélanger des séances réalisées (toujours acceptées) et des
  // séances planifiées (refusées une par une si coach_only, SANS faire échouer les autres séances du
  // même envoi — cf. `rejected` dans la réponse, plutôt qu'un rejet global du batch). Un seul appel à
  // checkPlannedWriteAllowed() pour tout le batch (le résultat ne dépend pas d'un log précis), et
  // seulement si le batch contient AU MOINS une séance planifiée — la très grande majorité des sync
  // (séances réalisées) n'a ainsi jamais besoin d'interroger coach_athletes.
  const hasPlannedLog = logs.some(l => l && l.planned);
  const denialIfPlanned = hasPlannedLog ? await checkPlannedWriteAllowed(req, true) : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rejected = [];
    for (const log of logs) {
      if (!log.id || !log.date) continue;
      if (log.planned && denialIfPlanned) { rejected.push(log.id); continue; }
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
    }
    await client.query('COMMIT');
    res.json({ ok: true, synced: logs.length - rejected.length, rejected });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
