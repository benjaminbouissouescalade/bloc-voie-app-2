// src/routes/proposedSessions.js
// Communauté v2 — "Séances à venir / Je participe" : proposer une future sortie à des
// partenaires précis et laisser chacun s'inscrire ("je participe"). Pas de séance créée
// à l'avance pour personne — juste une invitation ; la vraie séance sera loguée normalement
// par chacun le jour J.
const express = require('express');
const router = express.Router();
const { pool } = require('../db/schema');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

function proposedId() { return 'ps_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }
function orderPair(x, y) { return x < y ? [x, y] : [y, x]; }

// POST /api/proposed-sessions — { type, date, timeLabel, location, inviteeIds }
router.post('/', async (req, res) => {
  const climberId = req.user?.climberId;
  if (!climberId) return res.status(400).json({ error: 'Aucun profil grimpeur associé à ce compte' });
  const { type, date, timeLabel, location, inviteeIds } = req.body;
  if (!type) return res.status(400).json({ error: 'Type de séance requis' });
  if (!date) return res.status(400).json({ error: 'Date requise' });

  const ids = Array.isArray(inviteeIds) ? inviteeIds.filter(id => id && id !== climberId) : [];
  let validInviteeIds = [];
  if (ids.length) {
    const pairs = ids.map(id => orderPair(climberId, id));
    const { rows: partnershipRows } = await pool.query(
      `SELECT climber_a, climber_b FROM partnerships WHERE (climber_a, climber_b) IN (${pairs.map((_, i) => `($${i * 2 + 1},$${i * 2 + 2})`).join(',')})`,
      pairs.flat()
    );
    const validSet = new Set(partnershipRows.map(r => (r.climber_a === climberId ? r.climber_b : r.climber_a)));
    validInviteeIds = ids.filter(id => validSet.has(id));
  }

  const id = proposedId();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO proposed_sessions (id, created_by, type, date, time_label, location, invitees)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, climberId, type, date, (timeLabel || '').trim(), (location || '').trim(), JSON.stringify(validInviteeIds)]
    );
    // Le créateur participe automatiquement à sa propre proposition.
    await client.query(
      'INSERT INTO proposed_session_participants (proposed_id, climber_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [id, climberId]
    );
    await client.query('COMMIT');
    res.json({ ok: true, id });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/proposed-sessions — mes propositions (créées par moi ou où je suis invité), à venir uniquement
router.get('/', async (req, res) => {
  const climberId = req.user?.climberId;
  if (!climberId) return res.json([]);
  try {
    const { rows: proposals } = await pool.query(
      `SELECT * FROM proposed_sessions
       WHERE date >= CURRENT_DATE AND (created_by = $1 OR invitees @> to_jsonb($1::text))
       ORDER BY date ASC`,
      [climberId]
    );
    const result = [];
    for (const p of proposals) {
      const inviteeIds = p.invitees || [];
      const nameRows = inviteeIds.length
        ? (await pool.query('SELECT id, name, color FROM climbers WHERE id = ANY($1)', [inviteeIds])).rows
        : [];
      const { rows: participants } = await pool.query(
        `SELECT cl.id, cl.name, cl.color FROM proposed_session_participants pp
         JOIN climbers cl ON cl.id = pp.climber_id
         WHERE pp.proposed_id = $1`,
        [p.id]
      );
      const { rows: creatorRows } = await pool.query('SELECT name, color FROM climbers WHERE id=$1', [p.created_by]);
      result.push({
        id: p.id, type: p.type, date: p.date.toISOString().slice(0, 10),
        timeLabel: p.time_label, location: p.location,
        createdBy: p.created_by, createdByName: creatorRows[0]?.name || '—', isMine: p.created_by === climberId,
        invitees: nameRows, participants,
        imParticipating: participants.some(pt => pt.id === climberId)
      });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/proposed-sessions/:id/join — "je participe"
router.post('/:id/join', async (req, res) => {
  const climberId = req.user?.climberId;
  if (!climberId) return res.status(400).json({ error: 'Aucun profil grimpeur associé à ce compte' });
  try {
    const { rows } = await pool.query('SELECT created_by, invitees FROM proposed_sessions WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Proposition introuvable' });
    const p = rows[0];
    const allowed = p.created_by === climberId || (p.invitees || []).includes(climberId);
    if (!allowed) return res.status(403).json({ error: "Tu n'es pas invité à cette séance" });
    await pool.query(
      'INSERT INTO proposed_session_participants (proposed_id, climber_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [req.params.id, climberId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/proposed-sessions/:id/join — se désinscrire
router.delete('/:id/join', async (req, res) => {
  const climberId = req.user?.climberId;
  if (!climberId) return res.status(400).json({ error: 'Aucun profil grimpeur associé à ce compte' });
  try {
    await pool.query('DELETE FROM proposed_session_participants WHERE proposed_id=$1 AND climber_id=$2', [req.params.id, climberId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/proposed-sessions/:id — annuler (créateur uniquement)
router.delete('/:id', async (req, res) => {
  const climberId = req.user?.climberId;
  try {
    const { rows } = await pool.query('SELECT created_by FROM proposed_sessions WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Proposition introuvable' });
    if (rows[0].created_by !== climberId) return res.status(403).json({ error: 'Seul le créateur peut annuler cette proposition' });
    await pool.query('DELETE FROM proposed_sessions WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
