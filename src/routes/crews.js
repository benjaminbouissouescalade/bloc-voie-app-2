// src/routes/crews.js
// "Communauté" / mode jeu — crews d'entraînement entre grimpeurs, indépendants de la
// relation coach-athlète (un crew peut réunir des grimpeurs de coachs différents via
// un code d'invitation partagé, comme les liens d'invitation coach existants).
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { pool } = require('../db/schema');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

function crewId() { return 'crew_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }
function activityId() { return 'ca_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }
function kudosId() { return 'ck_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }
// Code court, lisible à voix haute (sans caractères ambigus 0/O/1/I)
function inviteCode() {
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(6);
  return Array.from(bytes).map(b => charset[b % charset.length]).join('');
}

async function isCrewMember(climberId, crewId) {
  if (!climberId || !crewId) return false;
  const { rows } = await pool.query(
    'SELECT 1 FROM crew_members WHERE crew_id=$1 AND climber_id=$2',
    [crewId, climberId]
  );
  return rows.length > 0;
}

function requireCrewMembership() {
  return async (req, res, next) => {
    try {
      const climberId = req.user?.climberId;
      const ok = await isCrewMember(climberId, req.params.crewId);
      if (!ok) return res.status(403).json({ error: 'Tu ne fais pas partie de ce crew' });
      next();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };
}

// Semaine ISO (lundi → dimanche) contenant la date courante
function currentWeekBounds() {
  const now = new Date();
  const day = now.getDay(); // 0=dim, 1=lun, ...
  const diffToMonday = (day === 0 ? -6 : 1 - day);
  const monday = new Date(now);
  monday.setDate(now.getDate() + diffToMonday);
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { start: monday.toISOString().slice(0, 10), end: sunday.toISOString().slice(0, 10) };
}

// POST /api/crews — créer un crew (le créateur devient automatiquement membre)
router.post('/', async (req, res) => {
  const { name } = req.body;
  const climberId = req.user?.climberId;
  if (!climberId) return res.status(400).json({ error: 'Aucun profil grimpeur associé à ce compte' });
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nom du crew requis' });
  const id = crewId();
  try {
    await pool.query('INSERT INTO crews (id, name, created_by) VALUES ($1,$2,$3)', [id, name.trim(), climberId]);
    await pool.query('INSERT INTO crew_members (crew_id, climber_id) VALUES ($1,$2)', [id, climberId]);
    res.json({ ok: true, crew: { id, name: name.trim() } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/crews — liste des crews du grimpeur connecté, avec leurs membres
router.get('/', async (req, res) => {
  const climberId = req.user?.climberId;
  if (!climberId) return res.json([]);
  try {
    const { rows: myCrews } = await pool.query(
      `SELECT c.id, c.name FROM crews c
       JOIN crew_members cm ON cm.crew_id = c.id
       WHERE cm.climber_id = $1 ORDER BY c.created_at DESC`,
      [climberId]
    );
    const crews = [];
    for (const c of myCrews) {
      const { rows: members } = await pool.query(
        `SELECT cl.id, cl.name, cl.color FROM crew_members cm
         JOIN climbers cl ON cl.id = cm.climber_id
         WHERE cm.crew_id = $1 ORDER BY cm.joined_at ASC`,
        [c.id]
      );
      crews.push({ id: c.id, name: c.name, members });
    }
    res.json(crews);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/crews/:crewId/invite — générer un code d'invitation (membres uniquement)
router.post('/:crewId/invite', requireCrewMembership(), async (req, res) => {
  const code = inviteCode();
  const expiresAt = new Date(Date.now() + 14 * 24 * 3600 * 1000); // 14 jours
  try {
    await pool.query(
      'INSERT INTO crew_invites (code, crew_id, created_by, expires_at) VALUES ($1,$2,$3,$4)',
      [code, req.params.crewId, req.user.climberId, expiresAt]
    );
    res.json({ ok: true, code });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/crews/join — rejoindre un crew via un code d'invitation
router.post('/join', async (req, res) => {
  const { code } = req.body;
  const climberId = req.user?.climberId;
  if (!climberId) return res.status(400).json({ error: 'Aucun profil grimpeur associé à ce compte' });
  if (!code) return res.status(400).json({ error: 'Code requis' });
  try {
    const { rows } = await pool.query('SELECT * FROM crew_invites WHERE code=$1', [code.trim().toUpperCase()]);
    if (!rows.length) return res.status(404).json({ error: 'Code invalide' });
    const invite = rows[0];
    if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Ce code a expiré' });
    }
    await pool.query(
      'INSERT INTO crew_members (crew_id, climber_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [invite.crew_id, climberId]
    );
    const { rows: crewRows } = await pool.query('SELECT id, name FROM crews WHERE id=$1', [invite.crew_id]);
    res.json({ ok: true, crew: crewRows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/crews/:crewId/leave
router.delete('/:crewId/leave', requireCrewMembership(), async (req, res) => {
  try {
    await pool.query('DELETE FROM crew_members WHERE crew_id=$1 AND climber_id=$2', [req.params.crewId, req.user.climberId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/crews/:crewId/board — activité de la semaine par membre (nombre de séances par type + adhérence programme)
router.get('/:crewId/board', requireCrewMembership(), async (req, res) => {
  try {
    const { rows: members } = await pool.query(
      `SELECT cl.id, cl.name, cl.color FROM crew_members cm
       JOIN climbers cl ON cl.id = cm.climber_id
       WHERE cm.crew_id = $1 ORDER BY cm.joined_at ASC`,
      [req.params.crewId]
    );
    const memberIds = members.map(m => m.id);
    const { start, end } = currentWeekBounds();
    let counts = [];
    if (memberIds.length) {
      const { rows } = await pool.query(
        `SELECT climber_id, type, planned, COUNT(*) as cnt
         FROM logs WHERE climber_id = ANY($1) AND date >= $2 AND date <= $3
         GROUP BY climber_id, type, planned`,
        [memberIds, start, end]
      );
      counts = rows;
    }
    // Kudos déjà donnés cette semaine dans ce crew (pour ne pas re-proposer un doublon dans l'UI)
    const { rows: kudos } = await pool.query(
      `SELECT from_climber_id, to_climber_id, emoji FROM crew_kudos
       WHERE crew_id=$1 AND week_start=$2`,
      [req.params.crewId, start]
    );

    const board = members.map(m => {
      const byType = {};
      let completedTotal = 0, plannedTotal = 0;
      counts.filter(c => c.climber_id === m.id).forEach(c => {
        const n = parseInt(c.cnt, 10);
        if (c.planned) { plannedTotal += n; }
        else {
          completedTotal += n;
          byType[c.type] = (byType[c.type] || 0) + n;
        }
      });
      const adherence = plannedTotal > 0 ? Math.round((Math.min(completedTotal, plannedTotal) / plannedTotal) * 100) : null;
      return {
        climberId: m.id, name: m.name, color: m.color,
        completedTotal, plannedTotal, adherence, byType,
        kudosReceived: kudos.filter(k => k.to_climber_id === m.id).length
      };
    });

    res.json({ weekStart: start, weekEnd: end, board, myKudosGivenTo: kudos.filter(k => k.from_climber_id === req.user.climberId).map(k => k.to_climber_id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Zone cible du ratio jours d'entraînement / jours de repos — volontairement simple
// (v1, à affiner plus tard) : quelque part entre "une séance tous les ~3 jours" et
// "un jour sur deux". Constantes nommées pour rester facilement ajustables.
const BALANCE_RATIO_TARGET_MIN = 0.35;
const BALANCE_RATIO_TARGET_MAX = 1.0;

// GET /api/crews/:crewId/balance?months=1|2|3 — classement équilibre entraînement/repos
// Fonctionne pour tout le monde, y compris ceux qui ne suivent aucun cycle/programme —
// basé uniquement sur les séances réellement loggées (planned=false).
router.get('/:crewId/balance', requireCrewMembership(), async (req, res) => {
  const months = [1, 2, 3].includes(parseInt(req.query.months, 10)) ? parseInt(req.query.months, 10) : 1;
  try {
    const end = new Date(); end.setHours(0, 0, 0, 0);
    const start = new Date(end); start.setMonth(start.getMonth() - months);
    const startStr = start.toISOString().slice(0, 10);
    const endStr = end.toISOString().slice(0, 10);
    const totalDays = Math.round((end - start) / 86400000) + 1;

    const { rows: members } = await pool.query(
      `SELECT cl.id, cl.name, cl.color FROM crew_members cm
       JOIN climbers cl ON cl.id = cm.climber_id
       WHERE cm.crew_id=$1 ORDER BY cm.joined_at ASC`,
      [req.params.crewId]
    );
    const memberIds = members.map(m => m.id);
    let trainingDaysRows = [];
    if (memberIds.length) {
      const { rows } = await pool.query(
        `SELECT climber_id, COUNT(DISTINCT date) as training_days
         FROM logs WHERE climber_id = ANY($1) AND planned = false AND date >= $2 AND date <= $3
         GROUP BY climber_id`,
        [memberIds, startStr, endStr]
      );
      trainingDaysRows = rows;
    }
    const targetCenter = (BALANCE_RATIO_TARGET_MIN + BALANCE_RATIO_TARGET_MAX) / 2;
    const ranking = members.map(m => {
      const row = trainingDaysRows.find(r => r.climber_id === m.id);
      const trainingDays = row ? parseInt(row.training_days, 10) : 0;
      const restDays = Math.max(1, totalDays - trainingDays);
      const ratio = Math.round((trainingDays / restDays) * 100) / 100;
      const inTarget = ratio >= BALANCE_RATIO_TARGET_MIN && ratio <= BALANCE_RATIO_TARGET_MAX;
      const distance = Math.abs(ratio - targetCenter);
      return { climberId: m.id, name: m.name, color: m.color, trainingDays, restDays, ratio, inTarget, distance };
    }).sort((a, b) => a.distance - b.distance);

    res.json({ months, totalDays, targetMin: BALANCE_RATIO_TARGET_MIN, targetMax: BALANCE_RATIO_TARGET_MAX, ranking });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/crews/:crewId/activity — fil d'activité récent (démarrages de cycle, etc.)
router.get('/:crewId/activity', requireCrewMembership(), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.id, a.climber_id, a.kind, a.payload, a.created_at, cl.name AS climber_name
       FROM crew_activity a
       JOIN climbers cl ON cl.id = a.climber_id
       WHERE a.crew_id=$1 ORDER BY a.created_at DESC LIMIT 30`,
      [req.params.crewId]
    );
    res.json(rows.map(r => ({
      id: r.id, climberId: r.climber_id, climberName: r.climber_name,
      kind: r.kind, payload: r.payload || {}, createdAt: r.created_at
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/crews/:crewId/activity — publier un événement (utilisé par ex. au lancement d'un cycle)
router.post('/:crewId/activity', requireCrewMembership(), async (req, res) => {
  const { kind, payload } = req.body;
  if (!kind) return res.status(400).json({ error: 'kind requis' });
  try {
    await pool.query(
      'INSERT INTO crew_activity (id, crew_id, climber_id, kind, payload) VALUES ($1,$2,$3,$4,$5)',
      [activityId(), req.params.crewId, req.user.climberId, kind, JSON.stringify(payload || {})]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/crews/:crewId/kudos — envoyer un encouragement à un coéquipier pour la semaine en cours
router.post('/:crewId/kudos', requireCrewMembership(), async (req, res) => {
  const { toClimberId, emoji } = req.body;
  if (!toClimberId) return res.status(400).json({ error: 'toClimberId requis' });
  try {
    const targetOk = await isCrewMember(toClimberId, req.params.crewId);
    if (!targetOk) return res.status(400).json({ error: 'Ce grimpeur ne fait pas partie du crew' });
    const { start } = currentWeekBounds();
    await pool.query(
      `INSERT INTO crew_kudos (id, crew_id, from_climber_id, to_climber_id, week_start, emoji) VALUES ($1,$2,$3,$4,$5,$6)`,
      [kudosId(), req.params.crewId, req.user.climberId, toClimberId, start, emoji || '👏']
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
