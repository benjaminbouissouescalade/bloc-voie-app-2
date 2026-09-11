// src/routes/bank.js
const express = require('express');
const router = express.Router();
const { pool } = require('../db/schema');
const { requireAuth } = require('../middleware/auth');
const { isCoachRole, isOwnerRole } = require('../lib/roles');

router.use(requireAuth);

// ─────────────────────────────────────────────────────────────────────────
// Routes spécifiques déclarées AVANT la route générique DELETE /:id, pour
// éviter tout conflit de matching Express (ex. /favorites/:id vs /:id).
// Ordre : GET / , POST / , POST /sync , GET+POST+DELETE /favorites... ,
// GET /recent , puis DELETE /:id en dernier.
// ─────────────────────────────────────────────────────────────────────────

function rowToItem(r) {
  return {
    id: r.id, name: r.name, type: r.type, support: r.support,
    level: r.level, duration: r.duration, intensity: r.intensity,
    goal: r.goal, description: r.description,
    tags: r.tags || [], source: r.source,
    category: r.category || '', subcategory: r.subcategory || '',
    crossTags: r.cross_tags || [],
    contentType: r.content_type || 'seance',
    videoUrl: r.video_url || '',
    // videoUrls remplace videoUrl (unique) — fallback sur l'ancien champ pour une fiche jamais
    // resauvegardée depuis la migration (video_urls encore à '[]' mais video_url non vide).
    videoUrls: (r.video_urls && r.video_urls.length) ? r.video_urls : (r.video_url ? [r.video_url] : []),
    images: r.images || [],
    checklist: r.checklist || [],
    createdBy: r.created_by || '',
    visibility: r.visibility || 'shared',
    // Retour utilisateur : bouton "⚠️ Alerte récupération" — délai de récupération minimum (en
    // heures) avant de refaire cette séance ; 0 = pas d'alerte (cf. schema.js).
    minRestHours: r.min_rest_hours || 0,
    // Retour utilisateur : timer d'effort optionnel — effort / repos entre répétitions / nombre de
    // répétitions PAR série / nombre de séries / repos entre séries. 0 partout = pas de timer sur
    // cette fiche (cf. schema.js).
    timerEffortSec: r.timer_effort_sec || 0,
    timerRestSec: r.timer_rest_sec || 0,
    timerReps: r.timer_reps || 0,
    timerSeries: r.timer_series || 0,
    timerSeriesRestSec: r.timer_series_rest_sec || 0,
    createdAt: new Date(r.created_at).getTime()
  };
}

// Un coach/owner peut gérer (modifier/supprimer) une fiche s'il en est le créateur, ou s'il est
// owner (droits globaux). Un simple coach ne peut jamais gérer la fiche d'un AUTRE coach, même si
// elle lui est visible parce que partagée ou parce qu'il coache un de ses athlètes.
function canManage(user, row) {
  return isOwnerRole(user?.role) || (row.created_by && row.created_by === user?.id);
}

// GET /api/bank — les séances de la banque visibles par le compte connecté :
// - un owner voit tout, sans restriction ;
// - les autres voient leurs propres fiches (quelle que soit leur visibilité), les fiches
//   partagées par n'importe quel coach, et les fiches PRIVÉES du/des coach(s) qui l'encadrent
//   (retour utilisateur : "cloisonner" la banque entre coachs tout en gardant le choix de
//   partager — cf. schema.js pour le détail de la migration created_by/visibility).
router.get('/', async (req, res) => {
  try {
    let rows;
    if (isOwnerRole(req.user.role)) {
      ({ rows } = await pool.query('SELECT * FROM session_bank ORDER BY created_at DESC'));
    } else {
      ({ rows } = await pool.query(
        `SELECT * FROM session_bank
         WHERE visibility = 'shared'
            OR created_by = $1
            OR created_by IN (SELECT coach_id FROM coach_athletes WHERE climber_id = $2)
         ORDER BY created_at DESC`,
        [req.user.id, req.user.climberId || null]
      ));
    }
    res.json(rows.map(rowToItem));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bank — créer ou mettre à jour une séance type
router.post('/', async (req, res) => {
  const { id, name, type, support, level, duration, intensity, goal, description, tags, source, category, subcategory, crossTags, contentType, videoUrl, videoUrls, images, checklist, visibility, minRestHours, timerEffortSec, timerRestSec, timerReps, timerSeries, timerSeriesRestSec } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'id et name requis' });
  const urls = Array.isArray(videoUrls) ? videoUrls.filter(Boolean) : (videoUrl ? [videoUrl] : []);
  const vis = visibility === 'shared' ? 'shared' : 'private'; // défaut : privée, cohérent avec le cloisonnement par défaut d'une NOUVELLE fiche
  const restHours = Math.max(0, parseInt(minRestHours, 10) || 0);
  // Timer d'effort : effort/repos entre répétitions, répétitions par série, nombre de séries,
  // repos entre séries (retour utilisateur : "3s suspension, 7s de repos, 10 fois, 4mn de repos,
  // 3x la série").
  const timerEffort = Math.max(0, parseInt(timerEffortSec, 10) || 0);
  const timerRest = Math.max(0, parseInt(timerRestSec, 10) || 0);
  const timerRepsVal = Math.max(0, parseInt(timerReps, 10) || 0);
  const timerSeriesVal = Math.max(0, parseInt(timerSeries, 10) || 0);
  const timerSeriesRest = Math.max(0, parseInt(timerSeriesRestSec, 10) || 0);
  try {
    const existing = await pool.query('SELECT created_by FROM session_bank WHERE id=$1', [id]);
    if (existing.rows.length && !canManage(req.user, existing.rows[0])) {
      return res.status(403).json({ error: "Tu ne peux pas modifier la fiche d'un autre coach." });
    }
    // created_by ne bouge jamais après création (pas dans le SET du ON CONFLICT ci-dessous) — sur
    // un INSERT neuf, la valeur ci-dessous (le compte connecté) est utilisée ; sur une mise à jour,
    // la valeur déjà en base est conservée quoi qu'envoie le client.
    await pool.query(
      `INSERT INTO session_bank (id, name, type, support, level, duration, intensity, goal, description, tags, source, category, subcategory, cross_tags, content_type, video_url, video_urls, images, checklist, created_by, visibility, min_rest_hours, timer_effort_sec, timer_rest_sec, timer_series, timer_reps, timer_series_rest_sec)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
       ON CONFLICT (id) DO UPDATE SET
         name=$2, type=$3, support=$4, level=$5, duration=$6, intensity=$7,
         goal=$8, description=$9, tags=$10, source=$11, category=$12, subcategory=$13, cross_tags=$14, content_type=$15, video_url=$16, video_urls=$17, images=$18, checklist=$19, visibility=$21, min_rest_hours=$22, timer_effort_sec=$23, timer_rest_sec=$24, timer_series=$25, timer_reps=$26, timer_series_rest_sec=$27, updated_at=NOW()`,
      [id, name, type, support||'', level||'confirme', duration||90, intensity||3,
       goal||'projet', description||'', JSON.stringify(tags||[]), source||'manual',
       category||'', subcategory||'', JSON.stringify(crossTags||[]), contentType === 'exercice' ? 'exercice' : 'seance',
       urls[0]||'', JSON.stringify(urls), JSON.stringify(images||[]), JSON.stringify(checklist||[]),
       req.user.id, vis, restHours, timerEffort, timerRest, timerSeriesVal, timerRepsVal, timerSeriesRest]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bank/sync — sync complète, mais désormais SCOPÉE au compte connecté : ne touche que
// les fiches DONT IL EST LE CRÉATEUR (DELETE + réinsertion), jamais celles des autres coachs
// (partagées ou non). Avant le cloisonnement, cette route vidait TOUTE la table à chaque sync —
// avec plusieurs coachs, le premier qui synchronisait aurait effacé les fiches des autres. Les
// items du payload qui n'appartiennent pas au compte connecté sont silencieusement ignorés (déjà
// en base sous leur vrai propriétaire, jamais modifiés ici).
router.post('/sync', async (req, res) => {
  if (!isCoachRole(req.user?.role)) {
    return res.status(403).json({ error: 'Seul un coach peut resynchroniser la banque de séances' });
  }
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items[] requis' });
  const own = items.filter(s => !s.createdBy || s.createdBy === req.user.id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM session_bank WHERE created_by = $1', [req.user.id]);
    for (const s of own) {
      const urls = Array.isArray(s.videoUrls) ? s.videoUrls.filter(Boolean) : (s.videoUrl ? [s.videoUrl] : []);
      const vis = s.visibility === 'shared' ? 'shared' : 'private';
      const restHours = Math.max(0, parseInt(s.minRestHours, 10) || 0);
      const timerEffort = Math.max(0, parseInt(s.timerEffortSec, 10) || 0);
      const timerRest = Math.max(0, parseInt(s.timerRestSec, 10) || 0);
      const timerRepsVal = Math.max(0, parseInt(s.timerReps, 10) || 0);
      const timerSeriesVal = Math.max(0, parseInt(s.timerSeries, 10) || 0);
      const timerSeriesRest = Math.max(0, parseInt(s.timerSeriesRestSec, 10) || 0);
      await client.query(
        `INSERT INTO session_bank (id, name, type, support, level, duration, intensity, goal, description, tags, source, category, subcategory, cross_tags, content_type, video_url, video_urls, images, checklist, created_by, visibility, min_rest_hours, timer_effort_sec, timer_rest_sec, timer_series, timer_reps, timer_series_rest_sec)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)`,
        [s.id, s.name, s.type, s.support||'', s.level||'confirme',
         s.duration||90, s.intensity||3, s.goal||'projet',
         s.description||'', JSON.stringify(s.tags||[]), s.source||'manual',
         s.category||'', s.subcategory||'', JSON.stringify(s.crossTags||[]),
         s.contentType === 'exercice' ? 'exercice' : 'seance', urls[0]||'', JSON.stringify(urls),
         JSON.stringify(s.images||[]), JSON.stringify(s.checklist||[]), req.user.id, vis, restHours,
         timerEffort, timerRest, timerSeriesVal, timerRepsVal, timerSeriesRest]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, synced: own.length });
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
// Réservée au créateur de la fiche (ou à un owner) — cf. canManage.
router.delete('/:id', async (req, res) => {
  try {
    const existing = await pool.query('SELECT created_by FROM session_bank WHERE id=$1', [req.params.id]);
    if (!existing.rows.length) return res.json({ ok: true }); // déjà absente : idempotent
    if (!canManage(req.user, existing.rows[0])) {
      return res.status(403).json({ error: "Tu ne peux pas supprimer la fiche d'un autre coach." });
    }
    await pool.query('DELETE FROM session_bank WHERE id=$1', [req.params.id]);
    await pool.query('DELETE FROM session_bank_favorites WHERE bank_id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
