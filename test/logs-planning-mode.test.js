// test/logs-planning-mode.test.js
// Tests d'intégration pour les droits d'écriture sur les séances PLANIFIÉES (mode coach_only —
// coach_athletes.planning_mode, cf. src/lib/planningMode.js et checkPlannedWriteAllowed() dans
// src/routes/logs.js). Fait tourner le VRAI routeur logs.js derrière un serveur HTTP en mémoire,
// avec un pool Postgres simulé reproduisant fidèlement : requireAuth (table users), requireClimberAccess
// (table coach_athletes), getPlanningModeInfo (jointure coach_athletes + users), et les deux routes
// d'écriture (POST /:climberId et POST /:climberId/sync).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'a-sufficiently-long-test-secret-value-not-a-real-one-1234567890';

const { pool } = require('../src/db/schema');
const express = require('express');
const logsRouter = require('../src/routes/logs');

// ─── Pool Postgres simulé ────────────────────────────────────────────────────────────────────
let logsTable, usersTable, coachAthletesTable;
function resetFakeDb() {
  logsTable = new Map();
  usersTable = new Map();
  coachAthletesTable = []; // [{coach_id, climber_id, planning_mode}]
}

function fakeQuery(sql, params = []) {
  const s = sql.replace(/\s+/g, ' ').trim();

  if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [], rowCount: 0 };

  // requireAuth : lecture de l'utilisateur courant
  if (s.includes('FROM users WHERE id=$1')) {
    const u = usersTable.get(params[0]);
    return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
  }

  // requireClimberAccess (middleware/access.js) : un coach a-t-il accès à CET athlète ?
  if (s.includes('FROM coach_athletes WHERE coach_id=$1 AND climber_id=$2')) {
    const [coachId, climberId] = params;
    const found = coachAthletesTable.some(r => r.coach_id === coachId && r.climber_id === climberId);
    return { rows: found ? [{ '?column?': 1 }] : [], rowCount: found ? 1 : 0 };
  }

  // getPlanningModeInfo (src/lib/planningMode.js) : mode + nom du coach pour CE climberId
  if (s.includes('FROM coach_athletes ca') && s.includes('JOIN users u')) {
    const [climberId] = params;
    const rows = coachAthletesTable
      .filter(r => r.climber_id === climberId)
      .map(r => ({ planning_mode: r.planning_mode, coach_name: (usersTable.get(r.coach_id) || {}).name || '?' }));
    return { rows, rowCount: rows.length };
  }

  // GET /api/logs/:climberId
  if (s.includes('FROM logs WHERE climber_id=$1 AND deleted=false')) {
    const [climberId] = params;
    const rows = [...logsTable.values()].filter(r => r.climber_id === climberId && !r.deleted);
    return { rows, rowCount: rows.length };
  }

  // POST /api/logs/:climberId (séance unique) — se termine par "RETURNING *", seule route dans ce cas
  if (s.endsWith('RETURNING *')) {
    const [id, climberId, date, type, support, minutes, intensity, shape, location, notes,
      ascents, bNoGrade, planned, bankRef, cycleId, cycleName, source, assignedByCoachId,
      flexGoal, objectiveId, injury, injuryNote, customName, checklistDone, feeling, clientUpdatedAt] = params;
    const existing = logsTable.get(id);
    if (existing && clientUpdatedAt < (existing.client_updated_at || 0)) return { rows: [], rowCount: 0 };
    const row = {
      id, climber_id: climberId, date: new Date(date), type, support, minutes, intensity, shape,
      location, notes, ascents: JSON.parse(ascents), b_no_grade: JSON.parse(bNoGrade), planned,
      bank_ref: bankRef, cycle_id: cycleId, cycle_name: cycleName, source,
      assigned_by_coach_id: assignedByCoachId, flex_goal: flexGoal, objective_id: objectiveId,
      injury, injury_note: injuryNote, custom_name: customName,
      checklist_done: JSON.parse(checklistDone), feeling, client_updated_at: clientUpdatedAt,
      deleted: false, comments: (existing && existing.comments) || []
    };
    logsTable.set(id, row);
    return { rows: [row], rowCount: 1 };
  }

  // POST /api/logs/:climberId/sync — upsert par log
  if (s.includes('RETURNING id, deleted, client_updated_at, (xmax = 0) AS inserted')) {
    const [id, climberId, date, type, support, minutes, intensity, shape, location, notes,
      ascents, bNoGrade, planned, bankRef, cycleId, cycleName, source, assignedByCoachId,
      flexGoal, objectiveId, injury, injuryNote, customName, checklistDone, feeling, clientUpdatedAt] = params;
    const existing = logsTable.get(id);
    if (existing && clientUpdatedAt < (existing.client_updated_at || 0)) return { rows: [], rowCount: 0 };
    logsTable.set(id, {
      id, climber_id: climberId, date: new Date(date), type, support, minutes, intensity, shape,
      location, notes, ascents: JSON.parse(ascents), b_no_grade: JSON.parse(bNoGrade), planned,
      bank_ref: bankRef, cycle_id: cycleId, cycle_name: cycleName, source,
      assigned_by_coach_id: assignedByCoachId, flex_goal: flexGoal, objective_id: objectiveId,
      injury, injury_note: injuryNote, custom_name: customName,
      checklist_done: JSON.parse(checklistDone), feeling, client_updated_at: clientUpdatedAt,
      deleted: false, comments: (existing && existing.comments) || []
    });
    return { rows: [{ id, deleted: false, client_updated_at: clientUpdatedAt, inserted: !existing }], rowCount: 1 };
  }

  throw new Error('Requête SQL non simulée dans ce test : ' + s.slice(0, 160));
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

const ATHLETE_ID = 'u_athlete';
const ATHLETE_CLIMBER_ID = 'c_athlete';
const COACH_ID = 'u_coach';
const COACH_CLIMBER_ID = 'c_coach';
const OWNER_ID = 'u_owner';
const OWNER_CLIMBER_ID = 'c_owner';

function authHeaderFor(userId) {
  const token = jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: '30d' });
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}
function plannedLogPayload(id, overrides = {}) {
  return { id, date: '2026-12-25', type: 'bloc', ascents: [], bNoGrade: {}, planned: true, clientUpdatedAt: Date.now(), ...overrides };
}
function realizedLogPayload(id, overrides = {}) {
  return { id, date: '2026-09-20', type: 'bloc', ascents: [{ status: 'tete', grade: '6b' }], bNoGrade: {}, planned: false, feeling: 'bien', clientUpdatedAt: Date.now(), ...overrides };
}
async function apiPost(climberId, payload, asUserId) {
  const r = await fetch(`${baseUrl}/api/logs/${climberId}`, {
    method: 'POST', headers: authHeaderFor(asUserId), body: JSON.stringify(payload)
  });
  return { status: r.status, body: await r.json() };
}
async function apiSync(climberId, logs, asUserId) {
  const r = await fetch(`${baseUrl}/api/logs/${climberId}/sync`, {
    method: 'POST', headers: authHeaderFor(asUserId), body: JSON.stringify({ logs })
  });
  return { status: r.status, body: await r.json() };
}
async function apiGet(climberId, asUserId) {
  const r = await fetch(`${baseUrl}/api/logs/${climberId}`, { headers: authHeaderFor(asUserId) });
  return { status: r.status, body: await r.json() };
}

test.beforeEach(() => {
  resetFakeDb();
  usersTable.set(ATHLETE_ID, { id: ATHLETE_ID, email: 'a@x.c', name: 'Athlète', role: 'athlete', climber_id: ATHLETE_CLIMBER_ID, password_changed_at: null });
  usersTable.set(COACH_ID, { id: COACH_ID, email: 'c@x.c', name: 'Coach', role: 'coach', climber_id: COACH_CLIMBER_ID, password_changed_at: null });
  usersTable.set(OWNER_ID, { id: OWNER_ID, email: 'o@x.c', name: 'Owner', role: 'owner', climber_id: OWNER_CLIMBER_ID, password_changed_at: null });
  coachAthletesTable.push({ coach_id: COACH_ID, climber_id: ATHLETE_CLIMBER_ID, planning_mode: 'shared' });
});

test('athlète, mode coach_only : créer une séance qui reste planifiée est refusé (403)', async () => {
  coachAthletesTable[0].planning_mode = 'coach_only';
  const res = await apiPost(ATHLETE_CLIMBER_ID, plannedLogPayload('log_p1'), ATHLETE_ID);
  assert.equal(res.status, 403);
  const g = await apiGet(ATHLETE_CLIMBER_ID, ATHLETE_ID);
  assert.equal(g.body.length, 0, 'la séance refusée ne doit pas avoir été enregistrée');
});

test('athlète, mode coach_only : enregistrer une séance RÉALISÉE reste toujours autorisé', async () => {
  coachAthletesTable[0].planning_mode = 'coach_only';
  const res = await apiPost(ATHLETE_CLIMBER_ID, realizedLogPayload('log_r1'), ATHLETE_ID);
  assert.equal(res.status, 200);
  const g = await apiGet(ATHLETE_CLIMBER_ID, ATHLETE_ID);
  assert.equal(g.body.length, 1);
});

test('athlète, mode coach_only : marquer une séance planifiée existante comme FAITE (planned:false) reste autorisé', async () => {
  // Le coach a créé la séance planifiée.
  await apiPost(ATHLETE_CLIMBER_ID, plannedLogPayload('log_done', { clientUpdatedAt: 1000 }), COACH_ID);
  coachAthletesTable[0].planning_mode = 'coach_only';
  // L'athlète la marque faite : planned passe à false dans le payload.
  const res = await apiPost(ATHLETE_CLIMBER_ID, realizedLogPayload('log_done', { clientUpdatedAt: 2000 }), ATHLETE_ID);
  assert.equal(res.status, 200, 'renseigner une séance réalisée doit toujours fonctionner, même issue d\'un prévisionnel du coach');
  const g = await apiGet(ATHLETE_CLIMBER_ID, ATHLETE_ID);
  assert.equal(g.body[0].planned, false);
});

test('athlète, mode shared (par défaut) : peut toujours créer une séance planifiée', async () => {
  const res = await apiPost(ATHLETE_CLIMBER_ID, plannedLogPayload('log_p2'), ATHLETE_ID);
  assert.equal(res.status, 200);
});

test('athlète sans coach du tout (mode "free" implicite) : peut planifier librement', async () => {
  coachAthletesTable.length = 0; // aucune relation coach_athletes
  const res = await apiPost(ATHLETE_CLIMBER_ID, plannedLogPayload('log_p3'), ATHLETE_ID);
  assert.equal(res.status, 200);
});

test('coach, mode coach_only : peut toujours planifier POUR son athlète (c\'est le sens même du mode)', async () => {
  coachAthletesTable[0].planning_mode = 'coach_only';
  const res = await apiPost(ATHLETE_CLIMBER_ID, plannedLogPayload('log_p4'), COACH_ID);
  assert.equal(res.status, 200);
});

test('owner : toujours autorisé à planifier pour n\'importe quel grimpeur, quel que soit le mode', async () => {
  coachAthletesTable[0].planning_mode = 'coach_only';
  const res = await apiPost(ATHLETE_CLIMBER_ID, plannedLogPayload('log_p5'), OWNER_ID);
  assert.equal(res.status, 200);
});

test('le champ "source" envoyé par le client est ignoré pour la décision de droits (anti-spoofing)', async () => {
  coachAthletesTable[0].planning_mode = 'coach_only';
  // L'athlète prétend que la séance vient du coach ("source":"coach") — ça ne doit rien changer :
  // seuls req.user (relu en base) et coach_athletes.planning_mode comptent.
  const res = await apiPost(ATHLETE_CLIMBER_ID, plannedLogPayload('log_spoof', { source: 'coach' }), ATHLETE_ID);
  assert.equal(res.status, 403, 'le champ source du payload ne doit jamais permettre de contourner la restriction');
});

test('sync : un batch mixte est traité séance par séance, pas tout ou rien', async () => {
  coachAthletesTable[0].planning_mode = 'coach_only';
  const res = await apiSync(ATHLETE_CLIMBER_ID, [
    plannedLogPayload('log_blocked'),
    realizedLogPayload('log_allowed')
  ], ATHLETE_ID);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.rejected, ['log_blocked']);
  assert.equal(res.body.synced, 1);
  const g = await apiGet(ATHLETE_CLIMBER_ID, ATHLETE_ID);
  assert.equal(g.body.length, 1);
  assert.equal(g.body[0].id, 'log_allowed');
});

test('sync : le coach peut toujours tout envoyer, y compris des séances planifiées, pour son athlète', async () => {
  coachAthletesTable[0].planning_mode = 'coach_only';
  const res = await apiSync(ATHLETE_CLIMBER_ID, [
    plannedLogPayload('log_c1'),
    plannedLogPayload('log_c2')
  ], COACH_ID);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.rejected, []);
  assert.equal(res.body.synced, 2);
});

test('sync : l\'athlète sous coach_only peut resynchroniser librement tant que rien n\'est planifié', async () => {
  coachAthletesTable[0].planning_mode = 'coach_only';
  const res = await apiSync(ATHLETE_CLIMBER_ID, [
    realizedLogPayload('log_r_a'),
    realizedLogPayload('log_r_b')
  ], ATHLETE_ID);
  assert.equal(res.status, 200);
  assert.equal(res.body.synced, 2);
  assert.equal(res.body.rejected.length, 0);
});
