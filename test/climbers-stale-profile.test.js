// test/climbers-stale-profile.test.js
// Garde "profil périmé" de POST /api/climbers (tâche #391) : un appareil qui travaille sur une copie
// plus ancienne que le serveur ne doit jamais écraser un profil plus récent (modifié par un coach ou
// un autre appareil). Fait tourner le VRAI routeur climbers.js avec un pool Postgres simulé.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'a-sufficiently-long-test-secret-value-not-a-real-one-1234567890';

const { pool } = require('../src/db/schema');
const express = require('express');
const climbersRouter = require('../src/routes/climbers');

// ─── mergeStaleProfile (fonction pure) ──────────────────────────────────────────────────────────
const { mergeStaleProfile } = climbersRouter;

test('mergeStaleProfile : le serveur gagne en cas de conflit, rien n\'est perdu des deux côtés', () => {
  const merged = mergeStaleProfile(
    { gender: 'F', sickDays: ['2026-10-01'], sharing: { niveau: 'prive' }, coachRating: { x: 1 } },
    { gender: 'M', sickDays: ['2026-10-02'], sharing: { seances: 'crew' }, newKey: 2 }
  );
  assert.equal(merged.gender, 'F', 'valeur en conflit : serveur gagnant');
  assert.deepEqual(merged.sickDays.sort(), ['2026-10-01', '2026-10-02'], 'listes simples : union');
  assert.deepEqual(merged.sharing, { seances: 'crew', niveau: 'prive' }, 'objets : fusion récursive');
  assert.equal(merged.newKey, 2, 'clé présente seulement côté client : conservée');
  assert.deepEqual(merged.coachRating, { x: 1 }, 'clé présente seulement côté serveur : conservée');
});

// ─── Route POST / avec pool simulé ──────────────────────────────────────────────────────────────
let climbersTable, usersTable;
function fakeQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (s.includes('FROM users WHERE id=$1')) {
    const u = usersTable.get(params[0]);
    return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
  }
  if (s.startsWith('SELECT id, profile, objectives, cycle_objectives, trips, updated_at FROM climbers')) {
    const c = climbersTable.get(params[0]);
    return { rows: c ? [c] : [], rowCount: c ? 1 : 0 };
  }
  if (s.startsWith('INSERT INTO climbers')) {
    const [id, name, color, level, trips, profile, objectives, cycleObjectives] = params;
    const row = { id, name, color, level, trips: JSON.parse(trips), profile: JSON.parse(profile),
      objectives: JSON.parse(objectives), cycle_objectives: JSON.parse(cycleObjectives),
      updated_at: new Date(Date.now()).toISOString() };
    climbersTable.set(id, row);
    return { rows: [row], rowCount: 1 };
  }
  throw new Error('Requête SQL non simulée : ' + s.slice(0, 140));
}
pool.query = async (sql, params) => fakeQuery(sql, params);

let server, baseUrl;
test.before(async () => {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/climbers', climbersRouter);
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); });

const USER = 'u_ath', CLIMBER = 'c_ath';
const auth = () => ({ Authorization: `Bearer ${jwt.sign({ id: USER }, process.env.JWT_SECRET)}`, 'Content-Type': 'application/json' });
async function postClimber(body) {
  const r = await fetch(`${baseUrl}/api/climbers`, { method: 'POST', headers: auth(), body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
test.beforeEach(() => {
  climbersTable = new Map();
  usersTable = new Map([[USER, { id: USER, email: 'a@x.c', name: 'A', role: 'athlete', climber_id: CLIMBER, password_changed_at: null }]]);
});

test('copie à jour (baseUpdatedAt = version serveur) : le profil est enregistré tel quel, stale=false', async () => {
  const t = '2026-10-20T10:00:00.000Z';
  climbersTable.set(CLIMBER, { id: CLIMBER, name: 'A', profile: { gender: 'F' }, objectives: [], cycle_objectives: [], trips: [], updated_at: t });
  const res = await postClimber({ id: CLIMBER, name: 'A', profile: { gender: 'M', height: 170 }, baseUpdatedAt: t });
  assert.equal(res.status, 200);
  assert.equal(res.body.stale, false);
  assert.deepEqual(res.body.profile, { gender: 'M', height: 170 });
});

test('copie PÉRIMÉE (serveur plus récent) : fusion, le serveur gagne, stale=true et profil fusionné renvoyé', async () => {
  climbersTable.set(CLIMBER, { id: CLIMBER, name: 'A', profile: { gender: 'F', coachRating: { x: 9 } }, objectives: [], cycle_objectives: [], trips: [], updated_at: '2026-10-25T10:00:00.000Z' });
  const res = await postClimber({ id: CLIMBER, name: 'A', profile: { gender: 'M', photo: 'p' }, baseUpdatedAt: '2026-10-20T10:00:00.000Z' });
  assert.equal(res.status, 200);
  assert.equal(res.body.stale, true);
  assert.equal(res.body.profile.gender, 'F', 'le profil plus récent du serveur n\'est pas écrasé');
  assert.deepEqual(res.body.profile.coachRating, { x: 9 }, 'les données du coach sont conservées');
  assert.equal(res.body.profile.photo, 'p', 'ce que seul le client avait est conservé aussi');
});

test('sans baseUpdatedAt (sauvegarde explicite du Profil détaillé) : comportement inchangé, le profil envoyé est enregistré', async () => {
  climbersTable.set(CLIMBER, { id: CLIMBER, name: 'A', profile: { gender: 'F' }, objectives: [], cycle_objectives: [], trips: [], updated_at: '2026-10-25T10:00:00.000Z' });
  const res = await postClimber({ id: CLIMBER, name: 'A', profile: { gender: 'M' } });
  assert.equal(res.body.stale, false);
  assert.equal(res.body.profile.gender, 'M');
});
