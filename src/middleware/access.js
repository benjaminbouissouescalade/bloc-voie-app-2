// src/middleware/access.js
// Vérifie qu'un utilisateur a le droit de voir/modifier les données d'un grimpeur donné.
// Règles :
//  - tout utilisateur a toujours accès à son propre climber_id
//  - un owner a accès à TOUS les climbers (rôle transversal, voir src/lib/roles.js)
//  - un coach a en plus accès aux climber_id de ses athlètes (table coach_athletes)
const { pool } = require('../db/schema');
const { isOwnerRole, isCoachRole } = require('../lib/roles');

async function canAccessClimber(user, climberId) {
  if (!user || !climberId) return false;
  if (user.climberId === climberId) return true;
  if (isOwnerRole(user.role)) return true;
  if (isCoachRole(user.role)) {
    const { rows } = await pool.query(
      'SELECT 1 FROM coach_athletes WHERE coach_id=$1 AND climber_id=$2',
      [user.id, climberId]
    );
    return rows.length > 0;
  }
  return false;
}

// Middleware Express : vérifie req.params.climberId (ou :id) contre req.user
function requireClimberAccess(paramName = 'climberId') {
  return async (req, res, next) => {
    try {
      const climberId = req.params[paramName];
      const ok = await canAccessClimber(req.user, climberId);
      if (!ok) return res.status(403).json({ error: 'Accès refusé à ce grimpeur' });
      next();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };
}

module.exports = { canAccessClimber, requireClimberAccess };
