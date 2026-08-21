// src/routes/partners.js
// Communauté v2 — connexions 1:1 "partenaires" (distinctes des crews). Sert de base au
// Feed, aux profils partenaires, aux séances communes, aux séances proposées, etc.
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { pool } = require('../db/schema');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

function inviteCode() {
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(6);
  return Array.from(bytes).map(b => charset[b % charset.length]).join('');
}
function partnershipId() { return 'pt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }
// Stocke toujours (climber_a, climber_b) triés pour éviter les doublons inversés.
function orderPair(x, y) { return x < y ? [x, y] : [y, x]; }

// ═══ Charge — même formule que public/index.html, crews.js et challenges.js (dupliquée, garder synchro) ═══
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

// POST /api/partners/invite — génère un code d'invitation personnel (partageable)
router.post('/invite', async (req, res) => {
  const climberId = req.user?.climberId;
  if (!climberId) return res.status(400).json({ error: 'Aucun profil grimpeur associé à ce compte' });
  const code = inviteCode();
  const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000); // 30 jours
  try {
    await pool.query(
      'INSERT INTO partner_invites (code, created_by, expires_at) VALUES ($1,$2,$3)',
      [code, climberId, expiresAt]
    );
    res.json({ ok: true, code });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/partners/accept — accepter une invitation via un code
router.post('/accept', async (req, res) => {
  const { code } = req.body;
  const climberId = req.user?.climberId;
  if (!climberId) return res.status(400).json({ error: 'Aucun profil grimpeur associé à ce compte' });
  if (!code) return res.status(400).json({ error: 'Code requis' });
  try {
    const { rows } = await pool.query('SELECT * FROM partner_invites WHERE code=$1', [code.trim().toUpperCase()]);
    if (!rows.length) return res.status(404).json({ error: 'Code invalide' });
    const invite = rows[0];
    if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Ce code a expiré' });
    }
    if (invite.created_by === climberId) {
      return res.status(400).json({ error: 'Tu ne peux pas te connecter à toi-même' });
    }
    const [a, b] = orderPair(invite.created_by, climberId);
    await pool.query(
      'INSERT INTO partnerships (id, climber_a, climber_b) VALUES ($1,$2,$3) ON CONFLICT (climber_a, climber_b) DO NOTHING',
      [partnershipId(), a, b]
    );
    const { rows: partnerRows } = await pool.query('SELECT id, name, color, level FROM climbers WHERE id=$1', [invite.created_by]);
    res.json({ ok: true, partner: partnerRows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/partners — liste de mes partenaires
router.get('/', async (req, res) => {
  const climberId = req.user?.climberId;
  if (!climberId) return res.json([]);
  try {
    const { rows } = await pool.query(
      `SELECT cl.id, cl.name, cl.color, cl.level
       FROM partnerships p
       JOIN climbers cl ON cl.id = (CASE WHEN p.climber_a = $1 THEN p.climber_b ELSE p.climber_a END)
       WHERE p.climber_a = $1 OR p.climber_b = $1
       ORDER BY cl.name ASC`,
      [climberId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/partners/:partnerId — retirer un partenaire
router.delete('/:partnerId', async (req, res) => {
  const climberId = req.user?.climberId;
  if (!climberId) return res.status(400).json({ error: 'Aucun profil grimpeur associé à ce compte' });
  try {
    const [a, b] = orderPair(climberId, req.params.partnerId);
    await pool.query('DELETE FROM partnerships WHERE climber_a=$1 AND climber_b=$2', [a, b]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/partners/feed — séances récentes réellement loguées par mes partenaires
// (respecte leur réglage de confidentialité "séances" — pas de post créé à la main,
// c'est toujours la vraie séance Digger).
router.get('/feed', async (req, res) => {
  const climberId = req.user?.climberId;
  if (!climberId) return res.json([]);
  try {
    const { rows: partners } = await pool.query(
      `SELECT cl.id, cl.name, cl.color, cl.profile
       FROM partnerships p
       JOIN climbers cl ON cl.id = (CASE WHEN p.climber_a = $1 THEN p.climber_b ELSE p.climber_a END)
       WHERE p.climber_a = $1 OR p.climber_b = $1`,
      [climberId]
    );
    const visible = partners.filter(p => (p.profile?.sharing?.seances || 'partenaires') !== 'prive');
    const partnerIds = visible.map(p => p.id);
    if (!partnerIds.length) return res.json([]);
    const { rows: logs } = await pool.query(
      `SELECT * FROM logs WHERE climber_id = ANY($1) AND planned = false ORDER BY date DESC, created_at DESC LIMIT 40`,
      [partnerIds]
    );
    const logIds = logs.map(l => l.id);
    let reactionRows = [];
    let linkRows = [];
    if (logIds.length) {
      const { rows } = await pool.query(
        `SELECT log_id, climber_id, reaction FROM session_reactions WHERE log_id = ANY($1)`,
        [logIds]
      );
      reactionRows = rows;
      const { rows: lr } = await pool.query(
        `SELECT sl.log_id AS origin_log_id, sl2.climber_id AS partner_id, cl.name, cl.color
         FROM session_links sl
         JOIN session_links sl2 ON sl2.id = sl.id AND sl2.climber_id <> sl.climber_id
         JOIN climbers cl ON cl.id = sl2.climber_id
         WHERE sl.log_id = ANY($1)`,
        [logIds]
      );
      linkRows = lr;
    }
    const partnerById = Object.fromEntries(visible.map(p => [p.id, p]));
    const feed = logs.map(l => {
      const reactions = reactionRows.filter(r => r.log_id === l.id);
      const reactionCounts = {};
      reactions.forEach(r => { reactionCounts[r.reaction] = (reactionCounts[r.reaction] || 0) + 1; });
      const myReaction = reactions.find(r => r.climber_id === climberId)?.reaction || null;
      const p = partnerById[l.climber_id];
      const withPartners = linkRows.filter(r => r.origin_log_id === l.id).map(r => ({ id: r.partner_id, name: r.name, color: r.color }));
      return {
        log: {
          id: l.id, date: l.date.toISOString().slice(0, 10), type: l.type, support: l.support,
          minutes: l.minutes, intensity: l.intensity, shape: l.shape, location: l.location,
          notes: l.notes, ascents: l.ascents || [], bNoGrade: l.b_no_grade || {}
        },
        climberId: l.climber_id,
        climberName: p?.name || '—',
        climberColor: p?.color || '#999',
        sharing: p?.profile?.sharing || {},
        reactionCounts, myReaction, withPartners
      };
    });
    res.json(feed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Les 5 réactions Digger (pas de like classique) — une seule active par utilisateur, modifiable.
const REACTION_TYPES = ['fort', 'propre', 'allez', 'jaloux', 'jepars'];

// POST /api/partners/feed/:logId/react — body {reaction} ('' ou absent pour retirer sa réaction
router.post('/feed/:logId/react', async (req, res) => {
  const climberId = req.user?.climberId;
  if (!climberId) return res.status(400).json({ error: 'Aucun profil grimpeur associé à ce compte' });
  const { reaction } = req.body;
  try {
    if (!reaction) {
      await pool.query('DELETE FROM session_reactions WHERE log_id=$1 AND climber_id=$2', [req.params.logId, climberId]);
      return res.json({ ok: true, reaction: null });
    }
    if (!REACTION_TYPES.includes(reaction)) return res.status(400).json({ error: 'Réaction invalide' });
    await pool.query(
      `INSERT INTO session_reactions (log_id, climber_id, reaction) VALUES ($1,$2,$3)
       ON CONFLICT (log_id, climber_id) DO UPDATE SET reaction=$3, created_at=NOW()`,
      [req.params.logId, climberId, reaction]
    );
    res.json({ ok: true, reaction });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/partners/:id/profile — profil d'un partenaire, filtré selon SES réglages de
// confidentialité par catégorie. Réutilise ses vraies séances (logs) et objectifs — ne
// duplique aucune donnée, ne calcule rien de nouveau qui n'existe pas déjà côté DIGGER.
router.get('/:id/profile', async (req, res) => {
  const climberId = req.user?.climberId;
  if (!climberId) return res.status(400).json({ error: 'Aucun profil grimpeur associé à ce compte' });
  const partnerId = req.params.id;
  try {
    const [a, b] = orderPair(climberId, partnerId);
    const { rows: linkRows } = await pool.query('SELECT 1 FROM partnerships WHERE climber_a=$1 AND climber_b=$2', [a, b]);
    if (!linkRows.length) return res.status(403).json({ error: "Ce grimpeur n'est pas dans tes partenaires" });

    const { rows: climberRows } = await pool.query('SELECT id, name, color, level, profile, objectives FROM climbers WHERE id=$1', [partnerId]);
    if (!climberRows.length) return res.status(404).json({ error: 'Introuvable' });
    const climber = climberRows[0];
    const sharing = climber.profile?.sharing || {};
    const visible = (cat) => (sharing[cat] || 'partenaires') !== 'prive';

    const { rows: logRows } = await pool.query(
      `SELECT * FROM logs WHERE climber_id=$1 AND planned=false AND date >= CURRENT_DATE - INTERVAL '90 days' ORDER BY date DESC`,
      [partnerId]
    );
    const logs = logRows.map(l => ({
      id: l.id, date: l.date.toISOString().slice(0, 10), type: l.type, minutes: l.minutes,
      ascents: l.ascents || [], b_no_grade: l.b_no_grade || {}
    }));
    const ref = refGradeFromLogs(logs);

    const profile = {
      id: climber.id, name: climber.name, color: climber.color, level: climber.level
    };

    if (visible('niveau')) {
      const sent = logs.flatMap(l => (l.ascents || []).filter(a => ['tete', 'moulinette', 'av', 'flash'].includes(a.status) && GRADE_IDX[a.grade] !== undefined));
      const bestIdx = sent.length ? Math.max(...sent.map(a => GRADE_IDX[a.grade])) : null;
      profile.niveau = { grade: bestIdx !== null ? GRADES[bestIdx] : null, sends90d: sent.length, refGrade: ref };
    }
    if (visible('seances')) {
      profile.seances = logs.slice(0, 5).map(l => ({
        date: l.date, type: l.type, minutes: l.minutes, ascentCount: (l.ascents || []).length
      }));
    }
    if (visible('statistiques')) {
      const weeks = Math.max(1, 90 / 7);
      profile.statistiques = { totalSessions90d: logs.length, avgPerWeek: Math.round((logs.length / weeks) * 10) / 10 };
    }
    if (visible('charge')) {
      const last7 = logs.filter(l => new Date(l.date) >= new Date(Date.now() - 7 * 86400000));
      const weeklyLoad = Math.round(last7.reduce((s, l) => s + logLoad(l, ref), 0));
      profile.charge = { weeklyLoad };
    }
    if (visible('tests')) {
      const { rows: testRows } = await pool.query(
        'SELECT test_date, rp_grade, mvc_kg_kg FROM finger_tests WHERE climber_id=$1 ORDER BY test_date DESC LIMIT 1',
        [partnerId]
      );
      profile.tests = testRows.length ? {
        date: testRows[0].test_date.toISOString().slice(0, 10),
        rpGrade: testRows[0].rp_grade, mvcKgKg: testRows[0].mvc_kg_kg
      } : null;
    }
    if (visible('objectifs')) {
      profile.objectifs = (climber.objectives || []).filter(o => o.status !== 'done').slice(0, 5);
    }
    if (visible('projets')) {
      const tries = logs.flatMap(l => (l.ascents || []).filter(a => a.status === 'try' && a.grade));
      const byGrade = {};
      tries.forEach(a => { byGrade[a.grade] = (byGrade[a.grade] || 0) + 1; });
      profile.projets = Object.entries(byGrade).sort((x, y) => (GRADE_IDX[y[0]] ?? 0) - (GRADE_IDX[x[0]] ?? 0)).slice(0, 5).map(([grade, tries]) => ({ grade, tries }));
    }

    res.json(profile);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
