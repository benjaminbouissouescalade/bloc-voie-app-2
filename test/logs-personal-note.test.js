// test/logs-personal-note.test.js
// Commentaire libre PRIVÉ de l'athlète : renvoyé uniquement à son auteur (jamais au coach), et un
// enregistrement venant d'un autre compte (sans le champ) ne l'efface pas.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'a-sufficiently-long-test-secret-value-not-a-real-one-1234567890';

const { pool } = require('../src/db/schema');
const express = require('express');
const logsRouter = require('../src/routes/logs');

const ATH = { id: 'u_ath', email: 'a@x.c', name: 'A', role: 'athlete', climber_id: 'c_ath', password_changed_at: null };
const COACH = { id: 'u_coach', email: 'c@x.c', name: 'C', role: 'coach', climber_id: 'c_coach', password_changed_at: null };
const users = new Map([[ATH.id, ATH], [COACH.id, COACH]]);
let upsertParams;
function fakeQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (s.includes('FROM users WHERE id=$1')) { const u = users.get(params[0]); return { rows: u ? [u] : [], rowCount: u ? 1 : 0 }; }
  if (s.includes('FROM coach_athletes')) return { rows: [{ '?column?': 1 }], rowCount: 1 };
  if (s.startsWith('SELECT * FROM logs WHERE climber_id')) {
    return { rows: [{ id: 'l1', date: new Date('2026-10-10'), type: 'bloc', minutes: 60, intensity: 3, shape: 'normal', ascents: [], personal_note: 'mon secret', personal_note_shared: false, client_updated_at: 1 }], rowCount: 1 };
  }
  if (s.startsWith('INSERT INTO logs')) { upsertParams = params; return { rows: [{ id: params[0] }], rowCount: 1 }; }
  if (s.startsWith('SELECT') && s.includes('planning')) return { rows: [], rowCount: 0 };
  throw new Error('Requête SQL non simulée : ' + s.slice(0, 140));
}
pool.query = async (sql, params) => fakeQuery(sql, params);

let server, baseUrl;
test.before(async () => {
  const app = express(); app.use(express.json()); app.use('/api/logs', logsRouter);
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
const tok = u => jwt.sign({ id: u.id }, process.env.JWT_SECRET);
const get = async u => (await fetch(`${baseUrl}/api/logs/c_ath`, { headers: { Authorization: `Bearer ${tok(u)}` } })).json();

test("l'athlète retrouve son commentaire privé", async () => {
  const logs = await get(ATH);
  assert.equal(logs[0].personalNote, 'mon secret');
});

test('le coach ne reçoit jamais le commentaire privé', async () => {
  const logs = await get(COACH);
  assert.equal('personalNote' in logs[0] && logs[0].personalNote !== undefined, false);
  assert.equal(JSON.stringify(logs).includes('mon secret'), false);
});

test("un enregistrement sans commentaire (ex. fait par le coach) envoie NULL pour ne pas l'effacer", async () => {
  upsertParams = null;
  await fetch(`${baseUrl}/api/logs/c_ath`, { method: 'POST', headers: { Authorization: `Bearer ${tok(COACH)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'l1', date: '2026-10-10', type: 'bloc', clientUpdatedAt: 5 }) });
  assert.ok(upsertParams, 'upsert exécuté');
  assert.equal(upsertParams[26], null);
  assert.equal(upsertParams[27], null);
});
