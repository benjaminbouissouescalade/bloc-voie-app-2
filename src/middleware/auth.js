const jwt = require('jsonwebtoken');
const { isCoachRole } = require('../lib/roles');
const { pool } = require('../db/schema');

// Audit sécurité : un secret de secours codé en dur ('bloc-voie-secret-change-in-prod') vivait ici
// auparavant. Si JWT_SECRET n'était pas configuré sur l'environnement de déploiement (rien ne le
// garantissait), n'importe qui connaissant cette chaîne — visible dans le dépôt — pouvait forger un
// token valide pour n'importe quel rôle, y compris owner. On fait donc désormais échouer le
// démarrage du serveur avec un message explicite plutôt que de démarrer silencieusement avec un
// secret prévisible. MIN_JWT_SECRET_LENGTH=32 est une longueur minimale raisonnable pour un secret
// HMAC (jsonwebtoken utilise HS256 par défaut) — pas une exigence cryptographique stricte, mais
// assez pour repérer un oubli/une valeur triviale ("secret", "changeme"...) au démarrage plutôt
// qu'en production.
const MIN_JWT_SECRET_LENGTH = 32;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < MIN_JWT_SECRET_LENGTH) {
  throw new Error(
    `JWT_SECRET manquant ou trop court (minimum ${MIN_JWT_SECRET_LENGTH} caractères). ` +
    'Configure la variable d\'environnement JWT_SECRET avec une valeur longue et aléatoire avant de démarrer le serveur ' +
    '(ex. génère-la une seule fois avec: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))" ' +
    'puis colle le résultat dans les variables d\'environnement de ton hébergeur — ne la régénère jamais après coup, ' +
    'ça invaliderait tous les tokens et déconnecterait tout le monde).'
  );
}

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
    const { rows } = await pool.query('SELECT id, email, name, role, climber_id, password_changed_at FROM users WHERE id=$1', [decoded.id]);
    if (!rows.length) return res.status(401).json({ error: 'Compte introuvable' });
    const u = rows[0];
    // Audit sécurité : révocation des tokens émis avant un changement de mot de passe. Un JWT reste
    // valide 30 jours (cf. jwt.sign côté auth.js) — sans cette vérification, changer son mot de
    // passe (ou se le faire réinitialiser par un coach via admin-reset-password) ne protégeait rien
    // : un token déjà émis continuait de fonctionner jusqu'à expiration naturelle. `iat` (issued-at,
    // claim standard JWT, en secondes) est comparé à password_changed_at (colonne ajoutée en base,
    // écrite par change-password/admin-reset-password) — NULL pour un compte qui n'a jamais changé
    // son mot de passe depuis ce correctif, donc aucun impact sur les tokens déjà en circulation
    // tant que personne ne change son mot de passe.
    if (u.password_changed_at && decoded.iat && decoded.iat * 1000 < new Date(u.password_changed_at).getTime()) {
      return res.status(401).json({ error: 'Session expirée suite à un changement de mot de passe — reconnecte-toi' });
    }
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
