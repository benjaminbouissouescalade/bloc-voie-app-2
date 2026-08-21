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
      const kudosForMe = kudos.filter(k => k.to_climber_id === m.id);
      const kudosByEmoji = {};
      kudosForMe.forEach(k => { kudosByEmoji[k.emoji || '👏'] = (kudosByEmoji[k.emoji || '👏'] || 0) + 1; });
      return {
        climberId: m.id, name: m.name, color: m.color,
        completedTotal, plannedTotal, adherence, byType,
        kudosReceived: kudosForMe.length, kudosByEmoji
      };
    });

    const myKudosGivenTo = {};
    kudos.filter(k => k.from_climber_id === req.user.climberId).forEach(k => { myKudosGivenTo[k.to_climber_id] = k.emoji || '👏'; });
    res.json({ weekStart: start, weekEnd: end, board, myKudosGivenTo });
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

// ═══ Charge — même formule que le frontend (public/index.html: ascentLoad/boulderLoad/
// sessionLoad/getRefGrade), dupliquée ici pour pouvoir classer plusieurs grimpeurs côté
// serveur. Garder synchronisé si la formule change côté frontend. ═══
const GRADES = ["4a","4a+","4b","4b+","4c","4c+","5a","5a+","5b","5b+","5c","5c+","6a","6a+","6b","6b+","6c","6c+","7a","7a+","7b","7b+","7c","7c+","8a","8a+","8b","8b+","8c","8c+","9a","9a+"];
const GRADE_IDX = Object.fromEntries(GRADES.map((g, i) => [g, i]));
const KAYA_BASE = 100, KAYA_GROWTH = 1.18;
const BOULDER_DIFF_OFFSET = {
  echauffement: -11.25, easy: -9.25, facile: -9.25,
  moyen: -7.75, easy_plus: -7.75,
  travail: -6.75, classic: -6.75,
  dur: -1.75, hard: -1.75
};
function ascentLoad(a, refGrade) {
  const gi = GRADE_IDX[a.grade], ri = GRADE_IDX[refGrade];
  if (gi === undefined || ri === undefined) return 0;
  const base = KAYA_BASE * Math.pow(KAYA_GROWTH, gi - ri);
  if (a.status === 'try') {
    const tries = Math.max(1, Number(a.tries || 1));
    const pct = Math.max(0.01, Math.min(1, (a.progress || 100) / 100));
    return Math.round(base * 0.8 * Math.sqrt(tries * pct));
  }
  const statusMul = { tete: 1.0, av: 1.10, flash: 1.10, moulinette: 0.85 }[a.status] || 1.0;
  return Math.round(base * statusMul);
}
function boulderLoad(b, refGrade) {
  if (!b) return 0;
  if (b.facileSent !== undefined || b.moyenSent !== undefined || b.travailSent !== undefined || b.travailTries !== undefined) {
    const facileSent = b.facileSent || 0, moyenSent = b.moyenSent || 0, travailSent = b.travailSent || 0, travailTries = b.travailTries || 0;
    if (!facileSent && !moyenSent && !travailSent && !travailTries) return 0;
    const baseFacile = KAYA_BASE * Math.pow(KAYA_GROWTH, BOULDER_DIFF_OFFSET.facile);
    const baseMoyen = KAYA_BASE * Math.pow(KAYA_GROWTH, BOULDER_DIFF_OFFSET.moyen);
    const travailOffset = travailTries > 6 ? BOULDER_DIFF_OFFSET.dur : BOULDER_DIFF_OFFSET.travail;
    const baseTravail = KAYA_BASE * Math.pow(KAYA_GROWTH, travailOffset);
    const volTravail = travailSent + 0.6 * travailTries;
    return Math.round((baseFacile * facileSent + baseMoyen * moyenSent + baseTravail * volTravail) * 0.5);
  }
  if (!b.sent && !b.tries) return 0;
  const offset = BOULDER_DIFF_OFFSET[b.diff] ?? BOULDER_DIFF_OFFSET.travail;
  const base = KAYA_BASE * Math.pow(KAYA_GROWTH, offset);
  const vol = (b.sent || 0) + 0.6 * (b.tries || 0) * ((b.progress || 60) / 100);
  return Math.round(base * vol * 0.5);
}
function logLoad(log, ref) {
  return (log.ascents || []).reduce((s, a) => s + ascentLoad(a, ref), 0) + boulderLoad(log.b_no_grade || {}, ref);
}
// Grade de référence (percentile 70%, ascensions enchaînées des 90 derniers jours) — même logique que getRefGrade() côté frontend.
function refGradeFromLogs(logs) {
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 90);
  const sent = logs
    .filter(l => new Date(l.date) >= cutoff)
    .flatMap(l => (l.ascents || []).filter(a => ['tete', 'moulinette', 'av', 'flash'].includes(a.status) && GRADE_IDX[a.grade] !== undefined))
    .map(a => GRADE_IDX[a.grade]).sort((a, b) => a - b);
  if (!sent.length) return '6b';
  return GRADES[sent[Math.min(Math.floor(sent.length * 0.7), sent.length - 1)]];
}

// Progression individuelle pour le défi collectif mensuel — mêmes 4 métriques que les
// challenges privés (src/routes/challenges.js computeProgress), dupliquée ici pour pouvoir
// sommer facilement sur tout un crew.
async function computeMemberProgress(climberId, metric, startDate, endDate) {
  const { rows: logs } = await pool.query(
    `SELECT * FROM logs WHERE climber_id=$1 AND planned=false AND date>=$2 AND date<=$3`,
    [climberId, startDate, endDate]
  );
  if (metric === 'seances') return logs.length;
  if (metric === 'jours') return new Set(logs.map(l => l.date.toISOString().slice(0, 10))).size;
  if (metric === 'blocs') {
    return logs.filter(l => l.type === 'bloc').reduce((s, l) => {
      const b = l.b_no_grade || {};
      const bng = (b.facileSent || 0) + (b.moyenSent || 0) + (b.travailSent || 0) + (b.sent || 0);
      return s + bng + (l.ascents || []).length;
    }, 0);
  }
  if (metric === 'charge') {
    const cutoff = new Date(startDate); cutoff.setDate(cutoff.getDate() - 90);
    const { rows: widerLogs } = await pool.query(
      `SELECT * FROM logs WHERE climber_id=$1 AND planned=false AND date>=$2 AND date<=$3`,
      [climberId, cutoff.toISOString().slice(0, 10), endDate]
    );
    const norm = widerLogs.map(l => ({ date: l.date.toISOString().slice(0, 10), ascents: l.ascents || [] }));
    const ref = refGradeFromLogs(norm);
    return Math.round(logs.reduce((s, l) => s + logLoad({ ascents: l.ascents || [], b_no_grade: l.b_no_grade || {} }, ref), 0));
  }
  return 0;
}
const MONTHLY_CHALLENGE_METRICS = ['seances', 'jours', 'charge', 'blocs'];
const MONTHLY_CHALLENGE_METRIC_LABELS = { seances: 'séances', jours: 'jours de grimpe', charge: 'points de charge', blocs: 'blocs/voies' };
function currentMonthBounds() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return { monthKey: start.toISOString().slice(0, 10), start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

// GET /api/crews/:crewId/monthly-challenge — défi collectif du mois en cours (s'il existe), avec progression d'équipe
router.get('/:crewId/monthly-challenge', requireCrewMembership(), async (req, res) => {
  try {
    const { monthKey, start, end } = currentMonthBounds();
    const { rows } = await pool.query(
      'SELECT * FROM crew_monthly_challenges WHERE crew_id=$1 AND month=$2',
      [req.params.crewId, monthKey]
    );
    if (!rows.length) return res.json(null);
    const ch = rows[0];
    const { rows: members } = await pool.query(
      `SELECT cl.id, cl.name, cl.color FROM crew_members cm
       JOIN climbers cl ON cl.id = cm.climber_id
       WHERE cm.crew_id = $1 ORDER BY cm.joined_at ASC`,
      [req.params.crewId]
    );
    const contributions = await Promise.all(members.map(async m => ({
      climberId: m.id, name: m.name, color: m.color,
      progress: await computeMemberProgress(m.id, ch.metric, start, end)
    })));
    const teamProgress = contributions.reduce((s, c) => s + c.progress, 0);
    const { rows: creatorRows } = await pool.query('SELECT name FROM climbers WHERE id=$1', [ch.created_by]);
    const daysLeft = Math.max(0, Math.ceil((new Date(end) - new Date()) / 86400000));
    res.json({
      id: ch.id, metric: ch.metric, metricLabel: MONTHLY_CHALLENGE_METRIC_LABELS[ch.metric] || ch.metric,
      target: Number(ch.target), monthStart: start, monthEnd: end, daysLeft,
      createdBy: ch.created_by, createdByName: creatorRows[0]?.name || '—',
      teamProgress, contributions: contributions.sort((a, b) => b.progress - a.progress)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/crews/:crewId/monthly-challenge — lancer (ou remplacer) le défi collectif du mois en cours
router.post('/:crewId/monthly-challenge', requireCrewMembership(), async (req, res) => {
  const { metric, target } = req.body;
  if (!MONTHLY_CHALLENGE_METRICS.includes(metric)) return res.status(400).json({ error: 'Métrique invalide' });
  const targetNum = Number(target);
  if (!targetNum || targetNum <= 0) return res.status(400).json({ error: 'Objectif requis (> 0)' });
  try {
    const { monthKey } = currentMonthBounds();
    const id = 'cmc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    await pool.query(
      `INSERT INTO crew_monthly_challenges (id, crew_id, month, metric, target, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (crew_id, month) DO UPDATE SET metric=$4, target=$5, created_by=$6`,
      [id, req.params.crewId, monthKey, metric, targetNum, req.user.climberId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/crews/:crewId/monthly-challenge — annuler le défi collectif du mois en cours
router.delete('/:crewId/monthly-challenge', requireCrewMembership(), async (req, res) => {
  try {
    const { monthKey } = currentMonthBounds();
    await pool.query('DELETE FROM crew_monthly_challenges WHERE crew_id=$1 AND month=$2', [req.params.crewId, monthKey]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const LB_PERIOD_DAYS = { '7j': 7, '30j': 30, annee: 365 };
const LB_METRIC_SHARE_KEY = { niveau: 'niveau', regularite: 'seances', charge: 'charge', progression: 'statistiques', seances: 'seances' };

// GET /api/crews/:crewId/leaderboard?metric=niveau|regularite|charge|progression|seances&period=7j|30j|annee
router.get('/:crewId/leaderboard', requireCrewMembership(), async (req, res) => {
  const metric = ['niveau', 'regularite', 'charge', 'progression', 'seances'].includes(req.query.metric) ? req.query.metric : 'niveau';
  const period = LB_PERIOD_DAYS[req.query.period] ? req.query.period : '7j';
  const days = LB_PERIOD_DAYS[period];
  try {
    const { rows: members } = await pool.query(
      `SELECT cl.id, cl.name, cl.color, cl.profile FROM crew_members cm
       JOIN climbers cl ON cl.id = cm.climber_id
       WHERE cm.crew_id=$1 ORDER BY cm.joined_at ASC`,
      [req.params.crewId]
    );
    const shareKey = LB_METRIC_SHARE_KEY[metric];
    const visible = members.filter(m => (m.profile?.sharing?.[shareKey] || 'partenaires') !== 'prive');
    const memberIds = visible.map(m => m.id);
    if (!memberIds.length) return res.json({ metric, period, ranking: [] });

    const end = new Date(); end.setHours(0, 0, 0, 0);
    const start = new Date(end); start.setDate(start.getDate() - days + 1);
    const startStr = start.toISOString().slice(0, 10);
    const endStr = end.toISOString().slice(0, 10);
    const refCutoff = new Date(end); refCutoff.setDate(refCutoff.getDate() - 90);
    let prevStartStr = null, prevEndStr = null, fetchFromStr = refCutoff.toISOString().slice(0, 10);
    if (metric === 'progression') {
      const prevEnd = new Date(start); prevEnd.setDate(prevEnd.getDate() - 1);
      const prevStart = new Date(prevEnd); prevStart.setDate(prevStart.getDate() - days + 1);
      prevStartStr = prevStart.toISOString().slice(0, 10);
      prevEndStr = prevEnd.toISOString().slice(0, 10);
      if (prevStartStr < fetchFromStr) fetchFromStr = prevStartStr;
    }
    if (startStr < fetchFromStr) fetchFromStr = startStr;

    const { rows: logs } = await pool.query(
      `SELECT * FROM logs WHERE climber_id = ANY($1) AND planned=false AND date >= $2 AND date <= $3`,
      [memberIds, fetchFromStr, endStr]
    );
    const logsNorm = logs.map(l => ({ climberId: l.climber_id, date: l.date.toISOString().slice(0, 10), ascents: l.ascents || [], bNoGrade: l.b_no_grade || {} }));

    const ranking = visible.map(m => {
      const memberLogs = logsNorm.filter(l => l.climberId === m.id);
      const periodLogs = memberLogs.filter(l => l.date >= startStr && l.date <= endStr);
      let value = 0, sub = null;
      if (metric === 'niveau') {
        const sends = periodLogs.flatMap(l => (l.ascents || []).filter(a => ['tete', 'moulinette', 'av', 'flash'].includes(a.status) && GRADE_IDX[a.grade] !== undefined));
        const bestIdx = sends.length ? Math.max(...sends.map(a => GRADE_IDX[a.grade])) : -1;
        value = bestIdx;
        sub = { grade: bestIdx >= 0 ? GRADES[bestIdx] : '—', sends: sends.length };
      } else if (metric === 'regularite') {
        const trainDays = new Set(periodLogs.map(l => l.date)).size;
        value = Math.round((trainDays / days) * 1000) / 10;
        sub = { trainDays, totalDays: days };
      } else if (metric === 'charge') {
        const ref = refGradeFromLogs(memberLogs);
        value = Math.round(periodLogs.reduce((s, l) => s + logLoad({ ascents: l.ascents, b_no_grade: l.bNoGrade }, ref), 0));
        sub = { ref };
      } else if (metric === 'seances') {
        value = periodLogs.length;
      } else if (metric === 'progression') {
        const ref = refGradeFromLogs(memberLogs);
        const curLogs = periodLogs;
        const prevLogs = memberLogs.filter(l => l.date >= prevStartStr && l.date <= prevEndStr);
        const curLoad = curLogs.reduce((s, l) => s + logLoad({ ascents: l.ascents, b_no_grade: l.bNoGrade }, ref), 0);
        const prevLoad = prevLogs.reduce((s, l) => s + logLoad({ ascents: l.ascents, b_no_grade: l.bNoGrade }, ref), 0);
        value = prevLoad > 0 ? Math.round(((curLoad - prevLoad) / prevLoad) * 1000) / 10 : (curLoad > 0 ? 100 : 0);
        sub = { curLoad: Math.round(curLoad), prevLoad: Math.round(prevLoad) };
      }
      return { climberId: m.id, name: m.name, color: m.color, value, sub };
    }).sort((a, b) => b.value - a.value);

    res.json({ metric, period, ranking });
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

// GET /api/crews/:crewId/heatmap — activité du crew des 53 dernières semaines, façon GitHub
// (nombre de séances loguées par n'importe quel membre, par jour). Aucune donnée nouvelle
// stockée — agrégé à la volée depuis les vraies séances.
router.get('/:crewId/heatmap', requireCrewMembership(), async (req, res) => {
  try {
    const { rows: members } = await pool.query('SELECT climber_id FROM crew_members WHERE crew_id=$1', [req.params.crewId]);
    const memberIds = members.map(m => m.climber_id);
    const since = new Date(); since.setDate(since.getDate() - 370);
    let counts = [];
    if (memberIds.length) {
      const { rows } = await pool.query(
        `SELECT date, COUNT(*)::int AS n FROM logs
         WHERE climber_id = ANY($1) AND planned=false AND date >= $2
         GROUP BY date`,
        [memberIds, since.toISOString().slice(0, 10)]
      );
      counts = rows.map(r => ({ date: r.date.toISOString().slice(0, 10), count: r.n }));
    }
    res.json({ since: since.toISOString().slice(0, 10), days: counts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Choix d'emoji pour les kudos — même liste côté frontend (public/index.html KUDOS_EMOJIS).
const KUDOS_EMOJIS = ['👏', '💪', '🔥', '🧗', '🚀'];

// POST /api/crews/:crewId/kudos — envoyer un encouragement à un coéquipier pour la semaine en cours
router.post('/:crewId/kudos', requireCrewMembership(), async (req, res) => {
  const { toClimberId, emoji } = req.body;
  if (!toClimberId) return res.status(400).json({ error: 'toClimberId requis' });
  const chosenEmoji = KUDOS_EMOJIS.includes(emoji) ? emoji : '👏';
  try {
    const targetOk = await isCrewMember(toClimberId, req.params.crewId);
    if (!targetOk) return res.status(400).json({ error: 'Ce grimpeur ne fait pas partie du crew' });
    const { start } = currentWeekBounds();
    await pool.query(
      `INSERT INTO crew_kudos (id, crew_id, from_climber_id, to_climber_id, week_start, emoji) VALUES ($1,$2,$3,$4,$5,$6)`,
      [kudosId(), req.params.crewId, req.user.climberId, toClimberId, start, chosenEmoji]
    );
    res.json({ ok: true, emoji: chosenEmoji });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
