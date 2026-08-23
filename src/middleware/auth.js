const jwt = require('jsonwebtoken');
const { isCoachRole } = require('../lib/roles');
const { pool } = require('../db/schema');
const JWT_SECRET = process.env.JWT_SECRET || 'bloc-voie-secret-change-in-prod';

// req.user était rempli directement depuis le contenu du JWT (signé à la connexion, valable 30
// jours) sans jamais revérifier en base. Résultat : toute modification de users.climber_id après
// coup — réassociation de profil (cf. tâche "Fix: réassocier le compte Ben à son vrai profil"),
// changement de rôle, promotion/rétrogradation coach — restait invisible pour un token déjà émis,
// qui continuait de porter l'ANCIEN climberId jusqu'à sa prochaine reconnexion. Ça provoquait des
// erreurs de contrainte de clé étrangère (climberId inexistant/obsolète) sur toute route qui
// utilise req.user.climberId pour un INSERT référençant climbers(id), par ex. partner_invites.
// On revérifie donc systématiquement en base à chaque requête plutôt que de faire confiance au JWT.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'Non authentifié' });
  let decoded;
  try {
    decoded = jwt.verify(header.slice(7), JWT_SECRET);
  } catch (e) {
    return res.status(401).json({ error: 'Token invalide' });
  }
  try {
    const { rows } = await pool.query('SELECT id, email, name, role, climber_id FROM users WHERE id=$1', [decoded.id]);
    if (!rows.length) return res.status(401).json({ error: 'Compte introuvable' });
    const u = rows[0];
    req.user = { id: u.id, email: u.email, name: u.name, role: u.role, climberId: u.climber_id };
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// Conservé pour compatibilité (non utilisé actuellement par les routes) — voir src/lib/roles.js
// pour requireOwner/requireCoach, les équivalents à jour du modèle de rôles owner/coach/athlete.
function requireAdmin(req, res, next) {
  if (!isCoachRole(req.user?.role)) return res.status(403).json({ error: 'Coach requis' });
  next();
}

module.exports = { requireAuth, requireAdmin, JWT_SECRET };
