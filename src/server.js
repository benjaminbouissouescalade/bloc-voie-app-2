require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { initDB } = require('./db/schema');
const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json({ limit: '5mb' }));
// no-store sur le HTML/JS servi : évite qu'un proxy/CDN devant l'app (ou le navigateur)
// continue de servir une ancienne version après un déploiement.
app.use(express.static(path.join(__dirname, '../public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
  }
}));
app.use('/api/auth',     require('./routes/auth'));
app.use('/api/climbers', require('./routes/climbers'));
app.use('/api/logs',     require('./routes/logs'));
app.use('/api/bank',     require('./routes/bank'));
app.use('/api/plans',    require('./routes/plans'));
app.use('/api/ai',       require('./routes/ai'));
app.use('/api/news',     require('./routes/news'));
const fingerProfileRoutes = require('./routes/fingerProfile');
app.use('/api/finger-profile', fingerProfileRoutes);
app.use('/api/finger-profile-expected', fingerProfileRoutes.expectedRouter);
app.use('/api/general-tests', require('./routes/generalTests'));
app.use('/api/crews', require('./routes/crews'));
app.use('/api/partners', require('./routes/partners'));
app.use('/api/challenges', require('./routes/challenges'));
app.use('/api/session-links', require('./routes/sessionLinks'));
app.use('/api/proposed-sessions', require('./routes/proposedSessions'));
app.use('/api/gyms', require('./routes/gyms'));
app.use('/api/availability', require('./routes/availability'));
app.get('/api/health', (req, res) => { res.json({ status: 'ok' }); });
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, '../public/index.html'));
});
async function start() {
  try {
    await initDB();
    app.listen(PORT, () => { console.log('Serveur demarre port ' + PORT); });
  } catch (err) { console.error(err.message); process.exit(1); }
}
start();
