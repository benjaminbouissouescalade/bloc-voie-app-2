// src/server.js
require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { initDB } = require('./db/schema');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// Sert les fichiers statiques (ton HTML + assets)
app.use(express.static(path.join(__dirname, '../public')));

// ── Routes API ─────────────────────────────────────────────
app.use('/api/climbers', require('./routes/climbers'));
app.use('/api/logs',     require('./routes/logs'));
app.use('/api/bank',     require('./routes/bank'));
app.use('/api/ai',       require('./routes/ai'));

// Health check pour Railway
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Toutes les autres routes → app HTML (Single Page App)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── Démarrage ──────────────────────────────────────────────
async function start() {
  try {
    await initDB();
    app.listen(PORT, () => {
      console.log(`🧗 Bloc & Voie — serveur démarré sur http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Impossible de démarrer:', err.message);
    process.exit(1);
  }
}

start();
