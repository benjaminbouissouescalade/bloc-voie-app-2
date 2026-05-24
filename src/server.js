Voici le fichier `server.js` complet à copier-coller :

```javascript
// src/server.js
require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { initDB } = require('./db/schema');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '../public')));

app.use('/api/auth',     require('./routes/auth'));
app.use('/api/climbers', require('./routes/climbers'));
app.use('/api/logs',     require('./routes/logs'));
app.use('/api/bank',     require('./routes/bank'));
app.use('/api/ai',       require('./routes/ai'));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

async function start() {
  try {
    await initDB();
    app.listen(PORT, () => {
      console.log(`Bloc & Voie - serveur demarre sur http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Impossible de demarrer:', err.message);
    process.exit(1);
  }
}

start();
```

Supprime tout le contenu de `server.js` sur GitHub, colle ça, et commite.
