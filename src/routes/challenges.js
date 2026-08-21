// src/routes/challenges.js
// Communauté v2 — challenges privés (crew entier ou partenaires sélectionnés).
// Pas d'étape d'acceptation séparée : les participants invités par un membre déjà
// connecté (partenaire/crew) sont ajoutés directement, comme demandé dans le brief.
const express = require('express');
const router = express.Router();
const { pool } = require('../db/schema');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

function challengeId() { return 'ch_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }

const METRICS = ['seances', 'jours', 'charge', 'blocs', 'session'];
const METRIC_LABELS = { seances: 'séances', jours: 'jours de grimpe', charge: 'points de charge', blocs: 'blocs/voies', session: 'séance ciblée' };

// ═══ Charge — même formule que public/index.html et crews.js (dupliquée, garder synchro) ═══
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
function refGradeFromLogs(logs) {
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 90);
  const sent = logs
    .filter(l => new Date(l.date) >= cutoff)
    .flatMap(l => (l.ascents || []).filter(a => ['tete', 'moulinette', 'av', 'flash'].includes(a.status) && GRADE_IDX[a.grade] !== undefined))
    .map(a => GRADE_IDX[a.grade]).sort((a, b) => a - b);
  if (!sent.length) return '6b';
  return GRADES[sent[Math.min(Math.floor(sent.length * 0.7), sent.length - 1)]];
}

async function computeProgress(climberId, metric, startDate, endDate, bankId) {
  if (metric === 'session') {
    if (!bankId) return 0;
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM logs WHERE climber_id=$1 AND planned=false AND bank_ref=$2 AND date>=$3 AND date<=$4`,
      [climberId, bankId, startDate, endDate]
    );
    return rows[0].n;
  }
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

// POST /api/challenges — créer un challenge (participantIds = crew entier ou partenaires sélectionnés)
router.post('/', async (req, res) => {
  const climberId = req.user?.climberId;
  if (!climberId) return res.status(400).json({ error: 'Aucun profil grimpeur associé à ce compte' });
  const { name, description, metric, target, startDate, endDate, participantIds, bankId } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nom requis' });
  if (!METRICS.includes(metric)) return res.status(400).json({ error: 'Métrique invalide' });
  if (metric === 'session' && !bankId) return res.status(400).json({ error: 'Séance ciblée requise' });
  const targetNum = Number(target);
  if (!targetNum || targetNum <= 0) return res.status(400).json({ error: 'Objectif requis (> 0)' });
  if (!startDate || !endDate || startDate > endDate) return res.status(400).json({ error: 'Dates invalides' });
  const id = challengeId();
  const participants = Array.from(new Set([climberId, ...(Array.isArray(participantIds) ? participantIds : [])]));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO challenges (id, created_by, name, description, metric, target, start_date, end_date, bank_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, climberId, name.trim(), (description || '').trim(), metric, targetNum, startDate, endDate, metric === 'session' ? bankId : null]
    );
    for (const pid of participants) {
      await client.query(
        'INSERT INTO challenge_participants (challenge_id, climber_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [id, pid]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, id });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/challenges — mes challenges (créés par moi ou où je participe), avec progression live
router.get('/', async (req, res) => {
  const climberId = req.user?.climberId;
  if (!climberId) return res.json([]);
  try {
    const { rows: challenges } = await pool.query(
      `SELECT DISTINCT c.* FROM challenges c
       JOIN challenge_participants cp ON cp.challenge_id = c.id
       WHERE cp.climber_id = $1
       ORDER BY c.end_date ASC`,
      [climberId]
    );
    const result = [];
    for (const ch of challenges) {
      const { rows: participants } = await pool.query(
        `SELECT cl.id, cl.name, cl.color FROM challenge_participants cp
         JOIN climbers cl ON cl.id = cp.climber_id
         WHERE cp.challenge_id = $1`,
        [ch.id]
      );
      let bankSession = null;
      if (ch.bank_id) {
        const { rows: bankRows } = await pool.query('SELECT id, name, type, description, category FROM session_bank WHERE id=$1', [ch.bank_id]);
        if (bankRows.length) bankSession = bankRows[0];
      }
      const startStr = ch.start_date.toISOString().slice(0, 10);
      const endStr = ch.end_date.toISOString().slice(0, 10);
      const withProgress = await Promise.all(participants.map(async p => ({
        climberId: p.id, name: p.name, color: p.color,
        progress: await computeProgress(p.id, ch.metric, startStr, endStr, ch.bank_id)
      })));
      withProgress.sort((a, b) => b.progress - a.progress);
      result.push({
        id: ch.id, name: ch.name, description: ch.description, metric: ch.metric,
        metricLabel: METRIC_LABELS[ch.metric] || ch.metric,
        target: Number(ch.target), startDate: startStr, endDate: endStr,
        createdBy: ch.created_by, isMine: ch.created_by === climberId,
        bankSession, participants: withProgress
      });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/challenges/:id — seul le créateur peut annuler
router.delete('/:id', async (req, res) => {
  const climberId = req.user?.climberId;
  try {
    const { rows } = await pool.query('SELECT created_by FROM challenges WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Challenge introuvable' });
    if (rows[0].created_by !== climberId) return res.status(403).json({ error: "Seul le créateur peut supprimer ce challenge" });
    await pool.query('DELETE FROM challenges WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
