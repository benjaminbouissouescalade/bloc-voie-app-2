// test/exceptions.test.js
// Tests d'intégration pour src/routes/exceptions.js (persistance des exceptions "Vu" pour la vue
// coach "À vérifier"). Fait tourner le VRAI routeur derrière un serveur HTTP en mémoire, avec un
// pool Postgres simulé.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'a-sufficiently-long-test-secret-value-not-a-real-one-1234567890';

const { pool } = require('../src/db/schema');
const express = require('express');
const exceptionsRouter = require('../src/routes/exceptions');

let usersTable, dismissalsTable; // dismissalsTable: array of {coach_id, exception_key}
function resetFakeDb() {
  usersTable = new Map();
  dismissalsTable = [];
}
function fakeQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (s.includes('FROM users WHERE id=$1')) {
    const u = usersTable.get(params[0]);
    return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
  }
  if (s.includes('SELECT exception_key FROM exception_dismissals')) {
    const [coachId] = params;
    const rows = dismissalsTable.filter(d => d.coach_id === coachId).map(d => ({ exception_key: d.exception_key }));
    return { rows, rowCount: rows.length };
  }
  if (s.includes('INSERT INTO exception_dismissals')) {
    const [coachId, key] = params;
    if (!dismissalsTable.some(d => d.coach_id === coachId && d.exception_key === key)) {
      dismissalsTable.push({ coach_id: coachId, exception_key: key });
    }
    return { rows: [], rowCount: 1 };
  }
  throw new Error('Requête SQL non simulée : ' + s.slice(0, 120));
}
pool.query = async (sql, params) => fakeQuery(sql, params);

let server, baseUrl;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/exceptions', exceptionsRouter);
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); });

const COACH_A = 'u_coach_a';
const COACH_B = 'u_coach_b';
function authHeaderFor(userId) {
  const token = jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: '30d' });
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}
async function getDismissed(userId) {
  const r = await fetch(`${baseUrl}/api/exceptions/dismissed`, { headers: authHeaderFor(userId) });
  return { status: r.status, body: await r.json() };
}
async function postDismiss(userId, exceptionKey) {
  const r = await fetch(`${baseUrl}/api/exceptions/dismiss`, {
    method: 'POST', headers: authHeaderFor(userId), body: JSON.stringify({ exceptionKey })
  });
  return { status: r.status, body: await r.json() };
}

test.beforeEach(() => {
  resetFakeDb();
  usersTable.set(COACH_A, { id: COACH_A, email: 'a@x.c', name: 'Coach A', role: 'coach', climber_id: 'c_a', password_changed_at: null });
  usersTable.set(COACH_B, { id: COACH_B, email: 'b@x.c', name: 'Coach B', role: 'coach', climber_id: 'c_b', password_changed_at: null });
});

test('aucune exception masquée au départ', async () => {
  const res = await getDismissed(COACH_A);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, []);
});

test('marquer "Vu" persiste la clé, retrouvée au prochain GET', async () => {
  await postDismiss(COACH_A, 'missed:log_1');
  const res = await getDismissed(COACH_A);
  assert.deepEqual(res.body, ['missed:log_1']);
});

test('idempotent : marquer "Vu" deux fois ne crée pas de doublon', async () => {
  await postDismiss(COACH_A, 'pain:log_2');
  await postDismiss(COACH_A, 'pain:log_2');
  const res = await getDismissed(COACH_A);
  assert.deepEqual(res.body, ['pain:log_2']);
});

test('les dismissals sont scopés par coach : le coach B ne voit pas ceux du coach A', async () => {
  await postDismiss(COACH_A, 'load:c_a:2026-09-21');
  const resA = await getDismissed(COACH_A);
  const resB = await getDismissed(COACH_B);
  assert.deepEqual(resA.body, ['load:c_a:2026-09-21']);
  assert.deepEqual(resB.body, []);
});

test('exceptionKey vide est refusé (400)', async () => {
  const res = await postDismiss(COACH_A, '');
  assert.equal(res.status, 400);
});

test('sans token -> 401', async () => {
  const r = await fetch(`${baseUrl}/api/exceptions/dismissed`);
  assert.equal(r.status, 401);
});
