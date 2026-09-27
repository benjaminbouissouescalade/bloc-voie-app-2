// test/auth.test.js
// Tests ciblés pour le correctif d'authentification (secret JWT + révocation après changement de
// mot de passe). Utilise le test runner intégré de Node (aucune dépendance supplémentaire),
// disponible nativement à partir de Node 18. Lancer avec: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const jwt = require('jsonwebtoken');

const TEST_SECRET = 'a-sufficiently-long-test-secret-value-not-a-real-one-1234567890';

test('le serveur refuse de démarrer si JWT_SECRET est absent', () => {
  // Process séparé : le middleware lève une erreur au chargement du module (require), donc on ne
  // peut pas tester ce cas dans le process de test principal sans polluer son état pour les autres
  // tests (qui ont besoin d'un JWT_SECRET valide déjà en place).
  const result = spawnSync(process.execPath, ['-e', "require('./src/middleware/auth')"], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, JWT_SECRET: '' },
    encoding: 'utf8'
  });
  assert.notEqual(result.status, 0, 'le process aurait dû quitter avec une erreur');
  assert.match(result.stderr, /JWT_SECRET manquant ou trop court/);
});

test('le serveur refuse de démarrer si JWT_SECRET est trop faible', () => {
  const result = spawnSync(process.execPath, ['-e', "require('./src/middleware/auth')"], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, JWT_SECRET: 'trop-court' },
    encoding: 'utf8'
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /JWT_SECRET manquant ou trop court/);
});

// À partir d'ici, JWT_SECRET valide dans l'environnement du process de test AVANT de charger le
// middleware (il lève une erreur sinon, cf. les deux tests ci-dessus).
process.env.JWT_SECRET = TEST_SECRET;
const { pool } = require('../src/db/schema');
const { requireAuth } = require('../src/middleware/auth');

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}
function fakeReq(token) {
  return { headers: { authorization: token ? `Bearer ${token}` : undefined } };
}

test('connexion normale : un token valide pour un compte sans changement de mot de passe passe', async () => {
  const fakeUser = { id: 'u_test1', email: 'test@example.com', name: 'Test', role: 'athlete', climber_id: 'c_test1', password_changed_at: null };
  pool.query = async () => ({ rows: [fakeUser] });
  const token = jwt.sign({ id: fakeUser.id, email: fakeUser.email, name: fakeUser.name, role: fakeUser.role, climberId: fakeUser.climber_id }, TEST_SECRET, { expiresIn: '30d' });
  const req = fakeReq(token);
  const res = fakeRes();
  let nextCalled = false;
  await requireAuth(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
  assert.deepEqual(req.user, { id: fakeUser.id, email: fakeUser.email, name: fakeUser.name, role: fakeUser.role, climberId: fakeUser.climber_id });
});

test('un token émis AVANT un changement de mot de passe est rejeté (révocation)', async () => {
  const fakeUser = { id: 'u_test2', email: 'test2@example.com', name: 'Test2', role: 'athlete', climber_id: 'c_test2', password_changed_at: new Date(Date.now() + 5000) };
  pool.query = async () => ({ rows: [fakeUser] });
  const token = jwt.sign({ id: fakeUser.id, email: fakeUser.email, name: fakeUser.name, role: fakeUser.role, climberId: fakeUser.climber_id }, TEST_SECRET, { expiresIn: '30d' });
  const req = fakeReq(token);
  const res = fakeRes();
  let nextCalled = false;
  await requireAuth(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.match(res.body.error, /Session expirée/);
});

test('un token émis APRÈS le dernier changement de mot de passe reste valide', async () => {
  const fakeUser = { id: 'u_test3', email: 'test3@example.com', name: 'Test3', role: 'athlete', climber_id: 'c_test3', password_changed_at: new Date(Date.now() - 60000) };
  pool.query = async () => ({ rows: [fakeUser] });
  const token = jwt.sign({ id: fakeUser.id, email: fakeUser.email, name: fakeUser.name, role: fakeUser.role, climberId: fakeUser.climber_id, iat: Math.floor(Date.now() / 1000) }, TEST_SECRET, { expiresIn: '30d' });
  const req = fakeReq(token);
  const res = fakeRes();
  let nextCalled = false;
  await requireAuth(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});

test('pas de token -> 401 sans toucher a la base', async () => {
  pool.query = async () => { throw new Error('ne devrait jamais etre appele'); };
  const req = fakeReq(null);
  const res = fakeRes();
  let nextCalled = false;
  await requireAuth(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('token signe avec un mauvais secret -> 401', async () => {
  const token = jwt.sign({ id: 'u_x' }, 'un-mauvais-secret-qui-ne-correspond-pas-du-tout');
  const req = fakeReq(token);
  const res = fakeRes();
  let nextCalled = false;
  await requireAuth(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});
