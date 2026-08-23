// src/lib/roles.js
// Modèle de rôles DIGGER : owner > coach > athlete, séparé du profil grimpeur (climber).
//
// 'admin' est l'ancien nom du rôle "coach unique" utilisé avant l'introduction d'owner/coach.
// Il est migré en base vers 'owner' (voir schema.js), mais on le garde accepté ici en alias
// le temps que les JWT existants (signés avant la migration, valables jusqu'à 30 jours) expirent
// ou soient renouvelés — un JWT est auto-porteur et n'est jamais revérifié contre la base.
function isOwnerRole(role) {
  return role === 'owner' || role === 'admin';
}

// Coach "actif" au sens large : owner (qui a tous les droits coach) ou coach dédié.
function isCoachRole(role) {
  return isOwnerRole(role) || role === 'coach';
}

function requireOwner(req, res, next) {
  if (!isOwnerRole(req.user?.role)) return res.status(403).json({ error: 'Owner requis' });
  next();
}

function requireCoach(req, res, next) {
  if (!isCoachRole(req.user?.role)) return res.status(403).json({ error: 'Coach requis' });
  next();
}

module.exports = { isOwnerRole, isCoachRole, requireOwner, requireCoach };
