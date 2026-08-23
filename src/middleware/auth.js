const jwt = require('jsonwebtoken');
const { isCoachRole } = require('../lib/roles');
const JWT_SECRET = process.env.JWT_SECRET || 'bloc-voie-secret-change-in-prod';

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'Non authentifié' });
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch (e) { res.status(401).json({ error: 'Token invalide' }); }
}

// Conservé pour compatibilité (non utilisé actuellement par les routes) — voir src/lib/roles.js
// pour requireOwner/requireCoach, les équivalents à jour du modèle de rôles owner/coach/athlete.
function requireAdmin(req, res, next) {
  if (!isCoachRole(req.user?.role)) return res.status(403).json({ error: 'Coach requis' });
  next();
}

module.exports = { requireAuth, requireAdmin, JWT_SECRET };
