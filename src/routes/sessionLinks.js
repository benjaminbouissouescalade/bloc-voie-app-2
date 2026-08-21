// src/routes/sessionLinks.js
// Communauté v2 — "On grimpe ensemble" : relie plusieurs vraies séances DIGGER (une par
// participant) comme faisant partie d'une même sortie commune. Ne duplique jamais une
// séance : on ne fait que relier des logs déjà existants entre eux.
const express = require('express');
const router = express.Router();
const { pool } = require('../db/schema');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

function linkId() { return 'sl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); }
function orderPair(x, y) { return x < y ? [x, y] : [y, x]; }

// POST /api/session-links — { logId, partnerIds: [...] }
// Tague des partenaires comme ayant grimpé avec toi lors de cette séance. Si un partenaire
// a déjà loggé une vraie séance à la même date, les deux logs sont reliés (aucune copie).
router.post('/', async (req, res) => {
  const climberId = req.user?.climberId;
  if (!climberId) return res.status(400).json({ error: 'Aucun profil grimpeur associé à ce compte' });
  const { logId, partnerIds } = req.body;
  if (!logId) return res.status(400).json({ error: 'logId requis' });
  try {
    const { rows: logRows } = await pool.query(
      'SELECT id, date FROM logs WHERE id=$1 AND climber_id=$2 AND planned=false',
      [logId, climberId]
    );
    if (!logRows.length) return res.status(404).json({ error: 'Séance introuvable' });
    const dateStr = logRows[0].date.toISOString().slice(0, 10);

    const ids = Array.isArray(partnerIds) ? partnerIds.filter(id => id && id !== climberId) : [];
    let validPartnerIds = [];
    if (ids.length) {
      const pairs = ids.map(id => orderPair(climberId, id));
      const { rows: partnershipRows } = await pool.query(
        `SELECT climber_a, climber_b FROM partnerships WHERE (climber_a, climber_b) IN (${pairs.map((_, i) => `($${i * 2 + 1},$${i * 2 + 2})`).join(',')})`,
        pairs.flat()
      );
      const validSet = new Set(partnershipRows.map(r => (r.climber_a === climberId ? r.climber_b : r.climber_a)));
      validPartnerIds = ids.filter(id => validSet.has(id));
    }

    // Récupère ou crée l'id de groupe pour cette séance.
    const { rows: existingLink } = await pool.query('SELECT id FROM session_links WHERE log_id=$1', [logId]);
    const groupId = existingLink.length ? existingLink[0].id : linkId();
    if (!existingLink.length) {
      await pool.query('INSERT INTO session_links (id, log_id, climber_id) VALUES ($1,$2,$3)', [groupId, logId, climberId]);
    }

    const linkedNames = [];
    const notLinkedNames = [];
    for (const partnerId of validPartnerIds) {
      const { rows: partnerLogRows } = await pool.query(
        'SELECT id FROM logs WHERE climber_id=$1 AND date=$2 AND planned=false LIMIT 1',
        [partnerId, dateStr]
      );
      const { rows: partnerInfo } = await pool.query('SELECT name FROM climbers WHERE id=$1', [partnerId]);
      const partnerName = partnerInfo[0]?.name || 'ce partenaire';
      if (!partnerLogRows.length) { notLinkedNames.push(partnerName); continue; }
      await pool.query(
        `INSERT INTO session_links (id, log_id, climber_id) VALUES ($1,$2,$3)
         ON CONFLICT ON CONSTRAINT session_links_log_unique DO UPDATE SET id=$1`,
        [groupId, partnerLogRows[0].id, partnerId]
      );
      linkedNames.push(partnerName);
    }

    res.json({ ok: true, groupId, linkedNames, notLinkedNames });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/session-links/:logId — les autres participants du même groupe que cette séance.
router.get('/:logId', async (req, res) => {
  const climberId = req.user?.climberId;
  if (!climberId) return res.json([]);
  try {
    const { rows: linkRows } = await pool.query('SELECT id FROM session_links WHERE log_id=$1', [req.params.logId]);
    if (!linkRows.length) return res.json([]);
    const { rows } = await pool.query(
      `SELECT cl.id, cl.name, cl.color FROM session_links sl
       JOIN climbers cl ON cl.id = sl.climber_id
       WHERE sl.id = $1 AND sl.climber_id <> $2`,
      [linkRows[0].id, climberId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/session-links/:logId — retire ma propre séance du groupe (les autres restent liés).
router.delete('/:logId', async (req, res) => {
  const climberId = req.user?.climberId;
  if (!climberId) return res.status(400).json({ error: 'Aucun profil grimpeur associé à ce compte' });
  try {
    await pool.query(
      'DELETE FROM session_links WHERE log_id=$1 AND climber_id=$2',
      [req.params.logId, climberId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
