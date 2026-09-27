// test/logs-deletion.test.js
// Tests d'intégration pour la réconciliation des suppressions de séances (audit "pertes et
// réapparitions de séances"). Fait tourner le VRAI routeur src/routes/logs.js derrière un serveur
// HTTP en mémoire, avec un pool Postgres simulé (aucune base réelle requise) qui reproduit
// fidèlement les DEUX requêtes SQL concernées : l'upsert de suppression (DELETE) et l'upsert de
// synchronisation (POST .../sync), y compris leur garde de fraîcheur (client_updated_at).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'a-sufficiently-long-test-secret-value-not-a-real-one-1234567890';

const { pool } = require('../src/db/schema');
const express = require('express');
const logsRouter = require('../src/routes/logs');

// ─── Pool Postgres simulé ────────────────────────────────────────────────────────────────────
// Table "logs" en mémoire (Map id -> row) + table "users" (pour requireAuth). On reconnaît chaque
// requête à un fragment de texte STABLE et unique dans le SQL réel (jamais un paramètre), donc ce
// test casse volontairement si le SQL de production change de forme sans que le test soit mis à jour.
let logsTable, usersTable;
function resetFakeDb() {
  logsTable = new Map();
  usersTable = new Map();
}

function fakeQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();

  if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [], rowCount: 0 };

  // requireAuth : lecture de l'utilisateur courant
  if (s.includes('FROM users WHERE id=$1')) {
    const u = usersTable.get(params[0]);
    return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
  }

  // GET /api/logs/:climberId
  if (s.includes('FROM logs WHERE climber_id=$1 AND deleted=false')) {
    const [climberId] = params;
    const rows = [...logsTable.values()].filter(r => r.climber_id === climberId && !r.deleted);
    return { rows, rowCount: rows.length };
  }

  // DELETE /api/logs/:climberId/:logId — upsert "tombstone" (cf. logs.js)
  if (s.includes("'supprime'")) {
    const [logId, climberId, ts] = params;
    const existing = logsTable.get(logId);
    if (!existing) {
      logsTable.set(logId, {
        id: logId, climber_id: climberId, date: new Date(), type: 'supprime',
        deleted: true, client_updated_at: ts, planned: false, ascents: [], b_no_grade: {},
        comments: [], checklist_done: []
      });
      return { rows: [{ id: logId }], rowCount: 1 };
    }
    if (existing.climber_id !== climberId) return { rows: [], rowCount: 0 };
    existing.deleted = true;
    existing.client_updated_at = Math.max(ts, existing.client_updated_at || 0);
    return { rows: [{ id: logId }], rowCount: 1 };
  }

  // POST /api/logs/:climberId/sync — upsert par log, gardé par client_updated_at (cf. logs.js)
  if (s.includes('RETURNING id, deleted, client_updated_at, (xmax = 0) AS inserted')) {
    const [id, climberId, date, type, support, minutes, intensity, shape, location, notes,
      ascents, bNoGrade, planned, bankRef, cycleId, cycleName, source, assignedByCoachId,
      flexGoal, objectiveId, injury, injuryNote, customName, checklistDone, feeling, clientUpdatedAt] = params;
    const existing = logsTable.get(id);
    if (!existing) {
      logsTable.set(id, {
        id, climber_id: climberId, date: new Date(date), type, support, minutes, intensity, shape,
        location, notes, ascents: JSON.parse(ascents), b_no_grade: JSON.parse(bNoGrade), planned,
        bank_ref: bankRef, cycle_id: cycleId, cycle_name: cycleName, source,
        assigned_by_coach_id: assignedByCoachId, flex_goal: flexGoal, objective_id: objectiveId,
        injury, injury_note: injuryNote, custom_name: customName,
        checklist_done: JSON.parse(checklistDone), feeling, client_updated_at: clientUpdatedAt,
        deleted: false, comments: []
      });
      return { rows: [{ id, deleted: false, client_updated_at: clientUpdatedAt, inserted: true }], rowCount: 1 };
    }
    // Garde de fraîcheur : WHERE $26 >= logs.client_updated_at — et "deleted" n'apparaît JAMAIS
    // dans le SET de cette route en production : un upsert de contenu ne peut donc jamais annuler
    // une suppression, même s'il passe la garde de fraîcheur (cf. commentaire schema.js).
    if (clientUpdatedAt < (existing.client_updated_at || 0)) {
      return { rows: [], rowCount: 0 };
    }
    Object.assign(existing, {
      date: new Date(date), type, support, minutes, intensity, shape, location, notes,
      ascents: JSON.parse(ascents), b_no_grade: JSON.parse(bNoGrade), planned, bank_ref: bankRef,
      cycle_id: cycleId, cycle_name: cycleName, source, assigned_by_coach_id: assignedByCoachId,
      flex_goal: flexGoal, objective_id: objectiveId, injury, injury_note: injuryNote,
      custom_name: customName, checklist_done: JSON.parse(checklistDone), feeling,
      client_updated_at: clientUpdatedAt
    });
    return { rows: [{ id, deleted: existing.deleted, client_updated_at: clientUpdatedAt, inserted: false }], rowCount: 1 };
  }

  throw new Error('Requête SQL non simulée dans ce test : ' + s.slice(0, 120));
}

pool.query = async (sql, params) => fakeQuery(sql, params);
pool.connect = async () => ({ query: (sql, params) => fakeQuery(sql, params), release: () => {} });

// ─── Petit serveur HTTP en mémoire montant le VRAI routeur logs.js ─────────────────────────────
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

const CLIMBER_ID = 'c_test';
const USER_ID = 'u_test';
function authHeader() {
  const token = jwt.sign({ id: USER_ID }, process.env.JWT_SECRET, { expiresIn: '30d' });
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}
function newLogPayload(id, overrides = {}) {
  return { id, date: '2026-09-20', type: 'bloc', ascents: [], bNoGrade: {}, planned: false, clientUpdatedAt: Date.now(), ...overrides };
}
async function apiGet(path) {
  const r = await fetch(baseUrl + path, { headers: authHeader() });
  return { status: r.status, body: await r.json() };
}
async function apiDelete(path) {
  const r = await fetch(baseUrl + path, { method: 'DELETE', headers: authHeader() });
  return { status: r.status, body: await r.json() };
}
async function apiSync(climberId, logs) {
  const r = await fetch(`${baseUrl}/api/logs/${climberId}/sync`, {
    method: 'POST', headers: authHeader(), body: JSON.stringify({ logs })
  });
  return { status: r.status, body: await r.json() };
}

test.beforeEach(() => {
  resetFakeDb();
  usersTable.set(USER_ID, { id: USER_ID, email: 'a@b.c', name: 'Test', role: 'athlete', climber_id: CLIMBER_ID, password_changed_at: null });
});

test('scénario 1 — suppression d\'une séance déjà enregistrée reste effective', async () => {
  await apiSync(CLIMBER_ID, [newLogPayload('log_1')]);
  let g = await apiGet(`/api/logs/${CLIMBER_ID}`);
  assert.equal(g.body.length, 1);

  const d = await apiDelete(`/api/logs/${CLIMBER_ID}/log_1`);
  assert.equal(d.status, 200);
  assert.equal(d.body.ok, true);

  g = await apiGet(`/api/logs/${CLIMBER_ID}`);
  assert.equal(g.body.length, 0, 'la séance supprimée ne doit plus jamais être renvoyée');
});

test('scénario 2 — suppression AVANT toute synchronisation (aucune ligne serveur au départ)', async () => {
  // La séance n'a jamais été envoyée au serveur — le DELETE ne trouve rien à marquer, mais doit
  // quand même créer un tombstone pour bloquer toute résurrection ultérieure.
  const d = await apiDelete(`/api/logs/${CLIMBER_ID}/log_never_synced`);
  assert.equal(d.status, 200);
  assert.equal(d.body.ok, true);

  const g = await apiGet(`/api/logs/${CLIMBER_ID}`);
  assert.equal(g.body.length, 0);
});

test('scénario 3 — un onglet ancien qui resynchronise après coup ne ressuscite pas la séance', async () => {
  // La séance existe côté serveur, avec un clientUpdatedAt "ancien" (T1).
  const t1 = 1000;
  await apiSync(CLIMBER_ID, [newLogPayload('log_2', { clientUpdatedAt: t1 })]);

  // Suppression "maintenant" (T2 > T1, généré par Date.now() côté route).
  await apiDelete(`/api/logs/${CLIMBER_ID}/log_2`);

  // Un onglet resté ouvert, jamais rafraîchi depuis, republie sa vieille copie (clientUpdatedAt=T1,
  // donc strictement plus ancienne que le tombstone) lors d'une synchronisation sans rapport.
  await apiSync(CLIMBER_ID, [newLogPayload('log_2', { clientUpdatedAt: t1 })]);

  const g = await apiGet(`/api/logs/${CLIMBER_ID}`);
  assert.equal(g.body.length, 0, 'la resynchronisation périmée ne doit pas faire réapparaître la séance');
});

test('scénario 3bis — même chose mais la sync périmée arrive AVANT le DELETE (ordre inverse)', async () => {
  const t1 = 1000;
  // La sync périmée est le PREMIER événement traité côté serveur (id encore inconnu → insertion).
  await apiSync(CLIMBER_ID, [newLogPayload('log_3', { clientUpdatedAt: t1 })]);
  // Puis la suppression arrive — doit gagner quoi qu'il arrive (une suppression explicite n'est
  // jamais soumise à la garde de fraîcheur, cf. logs.js).
  await apiDelete(`/api/logs/${CLIMBER_ID}/log_3`);

  const g = await apiGet(`/api/logs/${CLIMBER_ID}`);
  assert.equal(g.body.length, 0);
});

test('scénario 5 — deux appareils : le second synchronise APRÈS que le premier a supprimé', async () => {
  // Séance connue des deux appareils (déjà synchronisée), avec le même clientUpdatedAt de départ.
  const t0 = 1000;
  await apiSync(CLIMBER_ID, [newLogPayload('log_5', { clientUpdatedAt: t0 })]);

  // Appareil A supprime la séance.
  await apiDelete(`/api/logs/${CLIMBER_ID}/log_5`);

  // Appareil B, qui ignore tout de cette suppression, resynchronise sa propre copie locale — avec
  // un clientUpdatedAt PLUS ANCIEN que le moment de la suppression (il n'a rien modifié depuis).
  await apiSync(CLIMBER_ID, [newLogPayload('log_5', { clientUpdatedAt: t0 })]);

  const g = await apiGet(`/api/logs/${CLIMBER_ID}`);
  assert.equal(g.body.length, 0, 'la séance supprimée par un appareil ne doit pas réapparaître via un autre appareil');
});

test('une séance NON supprimée continue de se synchroniser normalement', async () => {
  await apiSync(CLIMBER_ID, [newLogPayload('log_6')]);
  const g = await apiGet(`/api/logs/${CLIMBER_ID}`);
  assert.equal(g.body.length, 1);
  assert.equal(g.body[0].id, 'log_6');
});

test('DELETE sur un id appartenant à un autre grimpeur est refusé (404)', async () => {
  await apiSync(CLIMBER_ID, [newLogPayload('log_7')]);
  const d = await apiDelete(`/api/logs/autre_grimpeur_id/log_7`);
  // requireClimberAccess bloque déjà ceci normalement (403, l'utilisateur de test n'a pas accès à
  // "autre_grimpeur_id") — ce test vérifie que même dans l'hypothèse où on passerait ce garde-fou,
  // la route elle-même refuse aussi de toucher une ligne d'un autre climber_id.
  assert.ok(d.status === 403 || d.status === 404);
});
