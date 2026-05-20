const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'bloc-voie-secret-change-in-prod';

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'Non authentifié' });
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch (e) { res.status(401).json({ error: 'Token invalide' }); }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin requis' });
  next();
}

module.exports = { requireAuth, requireAdmin, JWT_SECRET };
