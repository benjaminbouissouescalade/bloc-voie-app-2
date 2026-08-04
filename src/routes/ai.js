// src/routes/ai.js
// Proxy sécurisé vers l'API Anthropic
// La clé API reste côté serveur, jamais exposée au navigateur

const express = require('express');
const router = express.Router();

// POST /api/ai/chat
router.post('/chat', async (req, res) => {
  const { messages, max_tokens } = req.body;

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Clé API Anthropic manquante sur le serveur' });
  }

  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'messages[] requis' });
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
        max_tokens: max_tokens || 1000,
        messages
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data.error?.message || 'Erreur API Anthropic'
      });
    }

    res.json(data);
  } catch (err) {
    console.error('Erreur proxy AI:', err.message);
    res.status(500).json({ error: 'Erreur de connexion à l\'API Anthropic' });
  }
});

module.exports = router;
