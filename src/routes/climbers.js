// src/routes/climbers.js
const express = require('express');
const router = express.Router();
const { pool } = require('../db/schema');
const { requireAuth } = require('../middleware/auth');
const { canAccessClimber } = require('../middleware/access');
const { isOwnerRole, isCoachRole } = require('../lib/roles');

router.use(requireAuth);

// Fusionne par id plutôt que de remplacer le tableau en bloc. syncToBackend() (frontend) renvoie
// TOUT l'état local de chaque grimpeur à chaque saveDB() — c'est-à-dire après quasi n'importe
// quelle action, pas seulement quand on touche ses cycles. Si un client était resté ouvert avec un
// état local périmé pour un grimpeur (onglet ouvert longtemps, objectif ajouté entretemps depuis un
// autre appareil ou par l'athlète lui-même), le prochain sync — déclenché par une action totalement
// sans rapport — effaçait silencieusement les objectifs de cycle absents de ce payload périmé
// ("des cycles qui disparaissent"). Même cause, même famille de fix que le bug historique
// "séance effacée" sur /api/logs/:climberId/sync : upsert par id, jamais de remplacement en bloc.
// La suppression d'un objectif passe donc exclusivement par la route DELETE dédiée plus bas.
function mergeCycleObjectivesById(existingArr, incomingArr) {
  const map = new Map((existingArr || []).map(o => [o.id, o]));
  (incomingArr || []).forEach(o => { if (o && o.id) map.set(o.id, o); });
  return Array.from(map.values());
}

// GET /api/climbers — les grimpeurs accessibles à l'utilisateur connecté
// (son propre profil + les athlètes qu'il coach ; un owner voit tous les profils)
router.get('/', async (req, res) => {
  try {
    if (isOwnerRole(req.user.role)) {
      const { rows } = await pool.query('SELECT * FROM climbers ORDER BY created_at ASC');
      return res.json(rows);
    }
    const { rows } = await pool.query(
      `SELECT DISTINCT c.* FROM climbers c
       WHERE c.id = $1
          OR c.id IN (SELECT climber_id FROM coach_athletes WHERE coach_id = $2)
       ORDER BY c.created_at ASC`,
      [req.user.climberId, req.user.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/climbers/:id — un grimpeur (si accessible)
router.get('/:id', async (req, res) => {
  try {
    const ok = await canAccessClimber(req.user, req.params.id);
    if (!ok) return res.status(403).json({ error: 'Accès refusé à ce grimpeur' });
    const { rows } = await pool.query(
      'SELECT * FROM climbers WHERE id = $1', [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Grimpeur introuvable' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/climbers — créer ou mettre à jour un grimpeur
router.post('/', async (req, res) => {
  const { id, name, color, level, trips, profile, objectives, cycleObjectives } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'id et name requis' });
  try {
    const existing = await pool.query('SELECT id, profile, objectives, cycle_objectives FROM climbers WHERE id=$1', [id]);
    if (existing.rows.length) {
      // Mise à jour d'un grimpeur existant : il faut y avoir accès
      const ok = await canAccessClimber(req.user, id);
      if (!ok) return res.status(403).json({ error: 'Accès refusé à ce grimpeur' });
    } else {
      // Nouveau grimpeur : autorisé pour son propre profil, ou pour un coach/owner
      // qui crée un profil qu'il coachera lui-même
      if (id !== req.user.climberId && !isCoachRole(req.user.role)) {
        return res.status(403).json({ error: 'Seul un coach peut créer de nouveaux profils' });
      }
    }
    // Ne pas écraser un profil détaillé existant si le client n'en envoie pas (sync client "léger")
    const profileToSave = profile !== undefined ? profile : (existing.rows[0]?.profile || {});
    const objectivesToSave = objectives !== undefined ? objectives : (existing.rows[0]?.objectives || []);
    const cycleObjectivesToSave = cycleObjectives !== undefined
      ? mergeCycleObjectivesById(existing.rows[0]?.cycle_objectives || [], cycleObjectives)
      : (existing.rows[0]?.cycle_objectives || []);
    const { rows } = await pool.query(
      `INSERT INTO climbers (id, name, color, level, trips, profile, objectives, cycle_objectives)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET name=$2, color=$3, level=$4, trips=$5, profile=$6, objectives=$7, cycle_objectives=$8, updated_at=NOW()
       RETURNING *`,
      [id, name, color || '#2d5a3d', level || '7a', JSON.stringify(trips || []), JSON.stringify(profileToSave), JSON.stringify(objectivesToSave), JSON.stringify(cycleObjectivesToSave)]
    );
    if (!existing.rows.length && id !== req.user.climberId) {
      await pool.query(
        `INSERT INTO coach_athletes (coach_id, climber_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [req.user.id, id]
      );
    }
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/climbers/:id — modifier un grimpeur
router.put('/:id', async (req, res) => {
  const { name, color, level, trips, profile, objectives, cycleObjectives } = req.body;
  try {
    const ok = await canAccessClimber(req.user, req.params.id);
    if (!ok) return res.status(403).json({ error: 'Accès refusé à ce grimpeur' });
    const existing = await pool.query('SELECT profile, objectives, cycle_objectives FROM climbers WHERE id=$1', [req.params.id]);
    const profileToSave = profile !== undefined ? profile : (existing.rows[0]?.profile || {});
    const objectivesToSave = objectives !== undefined ? objectives : (existing.rows[0]?.objectives || []);
    const cycleObjectivesToSave = cycleObjectives !== undefined
      ? mergeCycleObjectivesById(existing.rows[0]?.cycle_objectives || [], cycleObjectives)
      : (existing.rows[0]?.cycle_objectives || []);
    const { rows } = await pool.query(
      `UPDATE climbers SET name=$1, color=$2, level=$3, trips=$4, profile=$5, objectives=$6, cycle_objectives=$7, updated_at=NOW()
       WHERE id=$8 RETURNING *`,
      [name, color, level, JSON.stringify(trips || []), JSON.stringify(profileToSave), JSON.stringify(objectivesToSave), JSON.stringify(cycleObjectivesToSave), req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Grimpeur introuvable' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/climbers/:id/cycle-objectives/:objectiveId — retire un objectif de période précis.
// Route dédiée : depuis que cycle_objectives est fusionné par id (upsert, cf.
// mergeCycleObjectivesById) et non plus remplacé en bloc, l'absence d'un objectif dans le payload
// de sync ne suffit plus à le supprimer — exactement comme DELETE /api/logs/:climberId/:logId pour
// les séances. Appelée par deleteCycle() et par generateCycle() (édition) côté frontend.
router.delete('/:id/cycle-objectives/:objectiveId', async (req, res) => {
  try {
    const ok = await canAccessClimber(req.user, req.params.id);
    if (!ok) return res.status(403).json({ error: 'Accès refusé à ce grimpeur' });
    const existing = await pool.query('SELECT cycle_objectives FROM climbers WHERE id=$1', [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Grimpeur introuvable' });
    const remaining = (existing.rows[0].cycle_objectives || []).filter(o => o.id !== req.params.objectiveId);
    await pool.query('UPDATE climbers SET cycle_objectives=$1, updated_at=NOW() WHERE id=$2', [JSON.stringify(remaining), req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/climbers/:id — supprimer un grimpeur (cascade sur les logs)
router.delete('/:id', async (req, res) => {
  try {
    const ok = await canAccessClimber(req.user, req.params.id);
    if (!ok) return res.status(403).json({ error: 'Accès refusé à ce grimpeur' });
    await pool.query('DELETE FROM climbers WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
