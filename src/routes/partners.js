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
    if (logIds.length) {
      const { rows } = await pool.query(
        `SELECT log_id, climber_id, reaction FROM session_reactions WHERE log_id = ANY($1)`,
        [logIds]
      );
      reactionRows = rows;
    }
    const partnerById = Object.fromEntries(visible.map(p => [p.id, p]));
    const feed = logs.map(l => {
      const reactions = reactionRows.filter(r => r.log_id === l.id);
      const reactionCounts = {};
      reactions.forEach(r => { reactionCounts[r.reaction] = (reactionCounts[r.reaction] || 0) + 1; });
      const myReaction = reactions.find(r => r.climber_id === climberId)?.reaction || null;
      const p = partnerById[l.climber_id];
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
        reactionCounts, myReaction
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

module.exports = router;
