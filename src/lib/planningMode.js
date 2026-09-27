// src/lib/planningMode.js
// Mode de planification effectif d'un grimpeur (voir la colonne coach_athletes.planning_mode dans
// src/db/schema.js) — factorisé ici pour n'avoir qu'UNE SEULE implémentation de la règle "le plus
// restrictif gagne quand un athlète a plusieurs coachs", utilisée à la fois par :
//   - GET /api/auth/my-planning-mode (src/routes/auth.js) : ce que le FRONTEND affiche/désactive,
//   - la vérification des droits d'écriture dans src/routes/logs.js : ce que le SERVEUR autorise.
// Avant ce module, seule la route auth.js implémentait cette règle ; logs.js ne vérifiait rien côté
// serveur (voir le commentaire — désormais obsolète — sur la colonne dans schema.js), un athlète en
// mode coach_only pouvait donc toujours créer/modifier une séance planifiée en appelant l'API
// directement (hors interface). Les deux endroits utilisent maintenant ce même code : impossible que
// l'UI et le serveur se retrouvent en désaccord sur la règle appliquée.
const { pool } = require('../db/schema');

const PLANNING_MODE_RANK = { free: 0, shared: 1, coach_only: 2 };

// { mode, coachName } — mode le plus restrictif parmi tous les coachs de ce grimpeur, ou
// { mode: 'free', coachName: null } s'il n'a aucun coach (cf. section "Athlete" du modèle de rôles :
// un athlète sans coach doit pouvoir utiliser l'appli librement).
async function getPlanningModeInfo(climberId) {
  const { rows } = await pool.query(
    `SELECT ca.planning_mode, u.name AS coach_name FROM coach_athletes ca
     JOIN users u ON u.id = ca.coach_id WHERE ca.climber_id = $1`,
    [climberId]
  );
  if (!rows.length) return { mode: 'free', coachName: null };
  let best = rows[0];
  for (const r of rows) {
    if ((PLANNING_MODE_RANK[r.planning_mode] || 0) > (PLANNING_MODE_RANK[best.planning_mode] || 0)) best = r;
  }
  return { mode: best.planning_mode || 'shared', coachName: best.coach_name };
}

module.exports = { getPlanningModeInfo, PLANNING_MODE_RANK };
