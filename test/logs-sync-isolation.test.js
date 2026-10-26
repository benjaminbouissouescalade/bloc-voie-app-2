// test/logs-sync-isolation.test.js
// Bug "les séances d'Agathe ne remontent plus" : tout le lot de POST /api/logs/:climberId/sync partait
// dans UNE transaction — une seule séance refusée par la base annulait TOUTES les autres, à chaque
// synchronisation, indéfiniment. Désormais un SAVEPOINT par séance : la séance invalide est signalée
// (422 + failed[]), les séances valides sont bien enregistrées. Teste aussi l'arrondi durée/intensité.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'a-sufficiently-long-test-secret-value-not-a-real-one-1234567890';

const { pool } = require('../src/db/schema');
const express = require('express');
const logsRouter = require('../src/routes/logs');

let saved, statements, usersTable;
function fakeQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  statements.push(s.split(' ').slice(0, 3).join(' '));
  if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK' || s.startsWith('SAVEPOINT') || s.startsWith('RELEASE SAVEPOINT') || s.startsWith('ROLLBACK TO SAVEPOINT')) return { rows: [], rowCount: 0 };
  if (s.includes('FROM users WHERE id=$1')) {
    const u = usersTable.get(params[0]);
    return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
  }
  if (s.includes('RETURNING id, deleted, client_updated_at, (xmax = 0) AS inserted')) {
    const [id, , , , , minutes, intensity] = params;
    if (id === 'log_bad') throw new Error('invalid input syntax for type integer');
    saved.set(id, { id, minutes, intensity });
    return { rows: [{ id }], rowCount: 1 };
  }
  throw new Error('Requête SQL non simulée : ' + s.slice(0, 140));
}
pool.query = async (sql, params) => fakeQuery(sql, params);
pool.connect = async () => ({ query: (sql, params) => fakeQuery(sql, params), release: () => {} });

let server, baseUrl;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/logs', logsRouter);
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); });

const USER = 'u_ath', CLIMBER = 'c_ath';
test.beforeEach(() => {
  saved = new Map(); statements = [];
  usersTable = new Map([[USER, { id: USER, email: 'a@x.c', name: 'A', role: 'athlete', climber_id: CLIMBER, password_changed_at: null }]]);
});
async function sync(logs) {
  const token = jwt.sign({ id: USER }, process.env.JWT_SECRET);
  const r = await fetch(`${baseUrl}/api/logs/${CLIMBER}/sync`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ logs }) });
  return { status: r.status, body: await r.json() };
}
const mk = (id, extra = {}) => ({ id, date: '2026-10-10', type: 'bloc', ascents: [], bNoGrade: {}, planned: false, clientUpdatedAt: 1, ...extra });

test('une séance refusée par la base ne bloque plus les autres : elles sont enregistrées, la fautive est signalée', async () => {
  const res = await sync([mk('log_a'), mk('log_bad'), mk('log_c')]);
  assert.equal(res.status, 422, 'le client doit voir une erreur (il garde "non synchronisé" et réessaie)');
  assert.deepEqual(res.body.failed.map(f => f.id), ['log_bad']);
  assert.equal(res.body.synced, 2);
  assert.ok(saved.has('log_a') && saved.has('log_c'), 'les séances valides sont bien enregistrées');
  assert.ok(!saved.has('log_bad'));
  assert.ok(statements.includes('ROLLBACK TO SAVEPOINT'), 'la séance fautive est annulée seule, pas toute la transaction');
});

test('lot entièrement valide : 200 ok, rien de signalé', async () => {
  const res = await sync([mk('log_a'), mk('log_b')]);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.synced, 2);
});

test('durée et intensité non entières sont arrondies (cause probable des refus de la base)', async () => {
  await sync([mk('log_a', { minutes: 62.5, intensity: 3.7 }), mk('log_b', { minutes: '45', intensity: 'x' })]);
  assert.equal(saved.get('log_a').minutes, 63);
  assert.equal(saved.get('log_a').intensity, 4);
  assert.equal(saved.get('log_b').minutes, 45);
  assert.equal(saved.get('log_b').intensity, 3, 'valeur illisible : défaut 3');
});
