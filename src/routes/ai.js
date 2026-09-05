// src/routes/ai.js
// Proxy sécurisé vers l'API Anthropic
// La clé API reste côté serveur, jamais exposée au navigateur

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');

// Cette route proxyait vers Anthropic SANS AUCUNE AUTHENTIFICATION — contrairement à toutes les
// autres routes de l'app (climbers, logs, bank...), qui exigent requireAuth. N'importe qui trouvant
// l'URL pouvait donc consommer la clé API (et donc la facture) sans même avoir de compte. On exige
// désormais d'être connecté, comme partout ailleurs.
router.use(requireAuth);

// Limite de génération IA par compte : simple compteur en mémoire, remis à zéro chaque jour civil
// (UTC). Volontairement pas de dépendance externe (express-rate-limit, redis...) — ce process
// tourne en instance unique sur Railway, un Map en mémoire suffit largement pour éviter l'abus
// (script qui spamme l'endpoint) sans complexifier le déploiement. Le compteur repart à zéro à
// chaque redémarrage du serveur, ce qui est sans conséquence pour ce cas d'usage.
const AI_DAILY_LIMIT = 150;
const aiUsageByUser = new Map(); // userId -> { day: 'YYYY-MM-DD', count: n }
function todayUTC() { return new Date().toISOString().slice(0, 10); }
function checkAndBumpAiQuota(userId) {
  const day = todayUTC();
  const entry = aiUsageByUser.get(userId);
  if (!entry || entry.day !== day) {
    aiUsageByUser.set(userId, { day, count: 1 });
    return true;
  }
  if (entry.count >= AI_DAILY_LIMIT) return false;
  entry.count += 1;
  return true;
}

// POST /api/ai/chat
router.post('/chat', async (req, res) => {
  const { messages } = req.body;
  // max_tokens plafonné côté serveur, quoi que le client envoie — évite qu'une requête modifiée
  // (ou un client malveillant) ne demande des réponses démesurément longues/coûteuses.
  const max_tokens = Math.min(Number(req.body.max_tokens) || 2048, 4096);

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Clé API Anthropic manquante sur le serveur' });
  }

  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'messages[] requis' });
  }

  if (!checkAndBumpAiQuota(req.user.id)) {
    return res.status(429).json({ error: `Limite de ${AI_DAILY_LIMIT} générations IA par jour atteinte pour ce compte — réessaie demain.` });
  }

  try {
    const { default: fetch } = await import('node-fetch');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: max_tokens || 4096,
        messages
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Erreur API Anthropic (status ' + response.status + '):', JSON.stringify(data));
      return res.status(response.status).json({
        error: data.error?.message || 'Erreur API Anthropic'
      });
    }

    const hasText = Array.isArray(data.content) && data.content.some(b => b && b.type === 'text' && b.text);
    if (!hasText) {
      console.error('Réponse Anthropic sans texte exploitable:', JSON.stringify(data));
    }

    res.json(data);
  } catch (err) {
    console.error('Erreur proxy AI:', err.message);
    res.status(500).json({ error: 'Erreur de connexion à l\'API Anthropic' });
  }
});

module.exports = router;
