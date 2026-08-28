// src/routes/bank.js
const express = require('express');
const router = express.Router();
const { pool } = require('../db/schema');
const { requireAuth } = require('../middleware/auth');
const { isCoachRole } = require('../lib/roles');

router.use(requireAuth);

// ─────────────────────────────────────────────────────────────────────────
// Routes spécifiques déclarées AVANT la route générique DELETE /:id, pour
// éviter tout conflit de matching Express (ex. /favorites/:id vs /:id).
// Ordre : GET / , POST / , POST /sync , GET+POST+DELETE /favorites... ,
// GET /recent , puis DELETE /:id en dernier.
// ─────────────────────────────────────────────────────────────────────────

// GET /api/bank — toutes les séances de la banque
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM session_bank ORDER BY created_at DESC'
    );
    const items = rows.map(r => ({
      id: r.id, name: r.name, type: r.type, support: r.support,
      level: r.level, duration: r.duration, intensity: r.intensity,
      goal: r.goal, description: r.description,
      tags: r.tags || [], source: r.source,
      category: r.category || '', subcategory: r.subcategory || '',
      crossTags: r.cross_tags || [],
      contentType: r.content_type || 'seance',
      videoUrl: r.video_url || '',
      createdAt: new Date(r.created_at).getTime()
    }));
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bank — créer ou mettre à jour une séance type
router.post('/', async (req, res) => {
  const { id, name, type, support, level, duration, intensity, goal, description, tags, source, category, subcategory, crossTags, contentType, videoUrl } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'id et name requis' });
  try {
    await pool.query(
      `INSERT INTO session_bank (id, name, type, support, level, duration, intensity, goal, description, tags, source, category, subcategory, cross_tags, content_type, video_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (id) DO UPDATE SET
         name=$2, type=$3, support=$4, level=$5, duration=$6, intensity=$7,
         goal=$8, description=$9, tags=$10, source=$11, category=$12, subcategory=$13, cross_tags=$14, content_type=$15, video_url=$16, updated_at=NOW()`,
      [id, name, type, support||'', level||'confirme', duration||90, intensity||3,
       goal||'projet', description||'', JSON.stringify(tags||[]), source||'manual',
       category||'', subcategory||'', JSON.stringify(crossTags||[]), contentType === 'exercice' ? 'exercice' : 'seance',
       videoUrl||'']
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bank/sync — sync complète de la banque (destructive : vide puis reconstruit
// toute la table). La banque est globale/partagée entre tous les comptes : on réserve donc
// cette route aux coachs (role=admin) pour éviter qu'un compte athlète ne puisse effacer/
// reconstruire la bibliothèque commune.
router.post('/sync', async (req, res) => {
  if (!isCoachRole(req.user?.role)) {
    return res.status(403).json({ error: 'Seul un coach peut resynchroniser la banque de séances' });
  }
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items[] requis' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM session_bank');
    for (const s of items) {
      await client.query(
        `INSERT INTO session_bank (id, name, type, support, level, duration, intensity, goal, description, tags, source, category, subcategory, cross_tags, content_type, video_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [s.id, s.name, s.type, s.support||'', s.level||'confirme',
         s.duration||90, s.intensity||3, s.goal||'projet',
         s.description||'', JSON.stringify(s.tags||[]), s.source||'manual',
         s.category||'', s.subcategory||'', JSON.stringify(s.crossTags||[]),
         s.contentType === 'exercice' ? 'exercice' : 'seance', s.videoUrl||'']
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, synced: items.length });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/bank/favorites — mes fiches favorites (liste d'ids)
// Rattaché au COMPTE connecté (users.id), pas à l'athlète actuellement affiché dans
// l'interface : un coach garde ses favoris quel que soit le profil qu'il consulte.
router.get('/favorites', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.json([]);
  try {
    const { rows } = await pool.query('SELECT bank_id FROM session_bank_favorites WHERE user_id=$1', [userId]);
    res.json(rows.map(r => r.bank_id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bank/favorites/:id — marquer une fiche comme favorite
router.post('/favorites/:id', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(400).json({ error: 'Compte non authentifié' });
  try {
    await pool.query(
      'INSERT INTO session_bank_favorites (user_id, bank_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [userId, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/bank/favorites/:id — retirer une fiche des favoris
router.delete('/favorites/:id', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(400).json({ error: 'Compte non authentifié' });
  try {
    await pool.query('DELETE FROM session_bank_favorites WHERE user_id=$1 AND bank_id=$2', [userId, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/bank/recent — fiches récemment utilisées (loguées ou programmées) par le
// grimpeur du compte connecté (même logique que /favorites : ancre = compte connecté).
router.get('/recent', async (req, res) => {
  const climberId = req.user?.climberId;
  if (!climberId) return res.json([]);
  try {
    // DISTINCT ON (bank_ref) + ORDER BY bank_ref, date DESC : garde, pour chaque fiche, la
    // ligne la plus récente (qu'elle soit passée/réalisée ou future/planifiée) — permet au
    // frontend d'afficher "Utilisée il y a Xj" ou "Programmée le ..." selon le cas.
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (bank_ref) bank_ref, date, planned FROM logs
       WHERE climber_id=$1 AND bank_ref IS NOT NULL AND bank_ref <> ''
       ORDER BY bank_ref, date DESC`,
      [climberId]
    );
    const items = rows
      .map(r => ({ bankId: r.bank_ref, date: r.date, planned: !!r.planned }))
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 20);
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/bank/:id — route générique à un seul segment : déclarée en dernier pour ne
// jamais intercepter par erreur une route plus spécifique (favorites/:id, sync, recent).
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM session_bank WHERE id=$1', [req.params.id]);
    await pool.query('DELETE FROM session_bank_favorites WHERE bank_id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
