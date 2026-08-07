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
app.use('/api/plans',    require('./routes/plans'));
app.use('/api/ai',       require('./routes/ai'));
app.use('/api/news',     require('./routes/news'));
const fingerProfileRoutes = require('./routes/fingerProfile');
app.use('/api/finger-profile', fingerProfileRoutes);
app.use('/api/finger-profile-expected', fingerProfileRoutes.expectedRouter);
app.get('/api/health', (req, res) => { res.json({ status: 'ok' }); });
app.get('*', (req, res) => { res.sendFile(path.join(__dirname, '../public/index.html')); });
async function start() {
  try {
    await initDB();
    app.listen(PORT, () => { console.log('Serveur demarre port ' + PORT); });
  } catch (err) { console.error(err.message); process.exit(1); }
}
start();
