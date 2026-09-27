// test/frontend-sync.test.js
// Teste le VRAI moteur de synchronisation frontend (public/index.html) : doSync()/syncToBackend()
// (envoi) et le verrou d'exclusion mutuelle avec loadFromBackend() (réception), extraits tels quels
// du fichier source (aucune réécriture/duplication de logique) et exécutés dans un bac à sable Node.
// Couvre l'audit "sync qui avale ses erreurs" : erreurs réseau, statuts 401/403/500, rechargement
// pendant une synchronisation en cours, et deux modifications rapprochées.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function extractFunction(marker) {
  const start = html.indexOf(marker);
  if (start === -1) throw new Error('Marqueur introuvable, le frontend a changé : ' + marker);
  let depth = 0, i = start, seenBrace = false;
  for (; i < html.length; i++) {
    const ch = html[i];
    if (ch === '{') { depth++; seenBrace = true; }
    else if (ch === '}') { depth--; if (seenBrace && depth === 0) { i++; break; } }
  }
  return html.slice(start, i);
}

// Extrait aussi les déclarations `let`/`window.x = ...` isolées (pas des fonctions) en cherchant
// jusqu'au premier point-virgule de fin d'instruction — utilisé pour les variables d'état module
// (backendOpChain, syncInProgress, etc.) déclarées à côté des fonctions ci-dessus.
function extractStatement(marker) {
  const start = html.indexOf(marker);
  if (start === -1) throw new Error('Marqueur introuvable : ' + marker);
  const end = html.indexOf(';', start);
  if (end === -1) throw new Error('Fin d\'instruction introuvable pour : ' + marker);
  return html.slice(start, end + 1);
}

const source = [
  extractStatement("window.syncStatus = 'saved';"),
  extractFunction('function paintSyncStatusEl('),
  extractFunction('function setSyncStatus('),
  extractFunction('function hasPendingLocalChanges('),
  extractFunction('function climberProfileSyncSnapshot('),
  extractStatement('let backendOpChain = Promise.resolve();'),
  extractFunction('function runExclusive('),
  extractStatement('let syncRetryTimer = null;'),
  extractStatement('let syncRetryDelay = 5000;'),
  extractFunction('function scheduleSyncRetry('),
  extractFunction('function cancelSyncRetry('),
  extractFunction('function markLogPendingDelete('),
  extractFunction('function clearPendingDelete('),
  extractFunction('async function attemptDelete('),
  extractFunction('async function attemptPendingDeletes('),
  extractFunction('async function doSync('),
  extractStatement('let syncInProgress = false;'),
  extractStatement('let syncQueuedAgain = false;'),
  extractFunction('async function syncToBackend('),
].join('\n\n');

function runInSandbox({ fetchImpl, storageBacking = {}, db }) {
  const localStorageStub = {
    getItem: k => (k in storageBacking ? storageBacking[k] : null),
    setItem: (k, v) => { storageBacking[k] = String(v); },
    removeItem: k => { delete storageBacking[k]; }
  };
  const timers = []; // setTimeout capturés pour pouvoir déclencher les nouveaux essais manuellement
  const sandbox = {
    console,
    localStorage: localStorageStub,
    fetch: fetchImpl,
    STORAGE_KEY: 'bv_db',
    authToken: () => 'fake-token',
    authHeaders: () => ({ 'Content-Type': 'application/json', Authorization: 'Bearer fake-token' }),
    setTimeout: (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; },
    clearTimeout: (h) => { const idx = timers.indexOf(h); if (idx !== -1) timers.splice(idx, 1); },
    document: { getElementById: () => null }, // pas de vrai DOM ici : le badge n'est pas testé au niveau UI
    db: db || { climbers: [], sessionBank: [], activeId: null, pendingDeletes: [] }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox._timers = timers;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox;
}

function mkClimber(id, logs) {
  return { id, name: 'Test', color: '#fff', level: '6a', trips: [], profile: {}, objectives: [], cycleObjectives: [], logs, pushedLogVersions: {} };
}
function mkLog(id, overrides = {}) {
  return { id, date: '2026-09-27', type: 'bloc', ascents: [], clientUpdatedAt: Date.now(), ...overrides };
}

test('erreur réseau : le statut passe à "error" et rien n\'est marqué comme envoyé', async () => {
  const db = { climbers: [mkClimber('c1', [mkLog('log1')])], sessionBank: [], pendingDeletes: [] };
  const sandbox = runInSandbox({ db, fetchImpl: async () => { throw new Error('réseau coupé'); } });
  await sandbox.syncToBackend();
  assert.equal(sandbox.window.syncStatus, 'error');
  assert.equal(db.climbers[0].pushedLogVersions['log1'], undefined, 'un envoi qui a échoué ne doit jamais être marqué confirmé');
  assert.equal(sandbox._timers.length, 1, 'un nouvel essai automatique doit être programmé après un échec');
});

test('statut HTTP 500 : traité comme une erreur, pas comme une confirmation', async () => {
  const db = { climbers: [mkClimber('c1', [mkLog('log1')])], sessionBank: [], pendingDeletes: [] };
  const sandbox = runInSandbox({
    db,
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) })
  });
  await sandbox.syncToBackend();
  assert.equal(sandbox.window.syncStatus, 'error');
  assert.equal(db.climbers[0].pushedLogVersions['log1'], undefined);
});

test('statut HTTP 401 : traité comme erreur (pas de confirmation), sans faire planter la sync', async () => {
  const db = { climbers: [mkClimber('c1', [mkLog('log1')])], sessionBank: [], pendingDeletes: [] };
  const sandbox = runInSandbox({
    db,
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: 'Non authentifié' }) })
  });
  await sandbox.syncToBackend();
  assert.equal(sandbox.window.syncStatus, 'error');
  assert.equal(db.climbers[0].pushedLogVersions['log1'], undefined);
});

test('statut HTTP 403 : idem, traité comme erreur', async () => {
  const db = { climbers: [mkClimber('c1', [mkLog('log1')])], sessionBank: [], pendingDeletes: [] };
  const sandbox = runInSandbox({
    db,
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ error: 'Interdit' }) })
  });
  await sandbox.syncToBackend();
  assert.equal(sandbox.window.syncStatus, 'error');
});

test('succès : le statut passe à "saved" et chaque log envoyé est marqué confirmé (clientUpdatedAt)', async () => {
  const db = { climbers: [mkClimber('c1', [mkLog('log1')])], sessionBank: [], pendingDeletes: [] };
  const sandbox = runInSandbox({
    db,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })
  });
  await sandbox.syncToBackend();
  assert.equal(sandbox.window.syncStatus, 'saved');
  assert.equal(db.climbers[0].pushedLogVersions['log1'], db.climbers[0].logs[0].clientUpdatedAt);
  assert.equal(sandbox._timers.length, 0, 'aucun nouvel essai ne doit être programmé après un succès');
});

test('une fois confirmé, un log inchangé n\'est plus renvoyé au prochain syncToBackend()', async () => {
  const db = { climbers: [mkClimber('c1', [mkLog('log1')])], sessionBank: [], pendingDeletes: [] };
  const calls = [];
  const sandbox = runInSandbox({
    db,
    fetchImpl: async (url, opts) => {
      calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
  });
  await sandbox.syncToBackend();
  const callsAfterFirst = calls.length;
  await sandbox.syncToBackend(); // rien n'a changé depuis
  assert.equal(calls.length, callsAfterFirst, 'aucune requête supplémentaire ne doit partir si rien n\'a changé');
});

test('deux modifications rapprochées sur la même séance : les deux finissent confirmées, pas de perte', async () => {
  const log1 = mkLog('log1', { notes: 'v1', clientUpdatedAt: 1000 });
  const db = { climbers: [mkClimber('c1', [log1])], sessionBank: [], pendingDeletes: [] };
  let resolveFirst;
  let callCount = 0;
  const sandbox = runInSandbox({
    db,
    fetchImpl: async () => {
      callCount++;
      if (callCount === 1) {
        // Le premier envoi part en vol ; on modifie la séance PENDANT qu'il est encore en cours.
        await new Promise(r => { resolveFirst = r; });
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
  });
  const p1 = sandbox.syncToBackend();
  // Pendant que le premier envoi est en vol, une deuxième modification arrive (retour utilisateur
  // scénario "deux modifications rapprochées") : clientUpdatedAt avance, et on redemande une sync.
  await new Promise(r => setTimeout(r, 5));
  log1.notes = 'v2';
  log1.clientUpdatedAt = 2000;
  const p2 = sandbox.syncToBackend(); // doit se coalescer (pas de deuxième requête EN PARALLÈLE)
  resolveFirst();
  await p1;
  await p2;
  // Un cycle de plus est nécessaire pour que la modification survenue pendant le premier envoi soit
  // captée (syncQueuedAgain) — on laisse le temps à la relance automatique de s'exécuter.
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  assert.equal(db.climbers[0].pushedLogVersions['log1'], 2000, 'la modification faite pendant l\'envoi précédent doit finir par être confirmée, pas perdue');
});

test('runExclusive : deux opérations ne s\'exécutent jamais en même temps (ordre préservé)', async () => {
  const sandbox = runInSandbox({ db: { climbers: [], sessionBank: [], pendingDeletes: [] }, fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  const order = [];
  let running = 0;
  let overlapped = false;
  async function op(label, delay) {
    return sandbox.runExclusive(async () => {
      running++;
      if (running > 1) overlapped = true;
      order.push('start:' + label);
      await new Promise(r => setTimeout(r, delay));
      order.push('end:' + label);
      running--;
    });
  }
  const p1 = op('sync', 20);
  const p2 = op('reload', 1); // "rechargement pendant une synchronisation" : arrive juste après, doit attendre
  await Promise.all([p1, p2]);
  assert.equal(overlapped, false, 'les deux opérations ne doivent jamais tourner en parallèle');
  assert.deepEqual(order, ['start:sync', 'end:sync', 'start:reload', 'end:reload']);
});

test('hasPendingLocalChanges détecte un log modifié jamais confirmé, et rien après confirmation', () => {
  const log1 = mkLog('log1', { clientUpdatedAt: 500 });
  const db = { climbers: [mkClimber('c1', [log1])], sessionBank: [], pendingDeletes: [] };
  const sandbox = runInSandbox({ db, fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  assert.equal(sandbox.hasPendingLocalChanges(), true);
  db.climbers[0].pushedLogVersions['log1'] = 500;
  db._syncedClimberProfile = { c1: sandbox.climberProfileSyncSnapshot(db.climbers[0]) };
  db._syncedBankJson = JSON.stringify(db.sessionBank || []);
  assert.equal(sandbox.hasPendingLocalChanges(), false);
});

test('une suppression encore en attente compte comme changement non confirmé (retentée à chaque sync)', async () => {
  const db = { climbers: [mkClimber('c1', [])], sessionBank: [], pendingDeletes: [{ climberId: 'c1', logId: 'log_del' }] };
  let deleteAttempts = 0;
  const sandbox = runInSandbox({
    db,
    fetchImpl: async (url, opts) => {
      if (opts && opts.method === 'DELETE') { deleteAttempts++; return { ok: false, status: 500, json: async () => ({}) }; }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
  });
  assert.equal(sandbox.hasPendingLocalChanges(), true);
  await sandbox.syncToBackend();
  assert.equal(deleteAttempts, 1, 'la suppression en attente doit être retentée pendant la sync');
  assert.equal(sandbox.window.syncStatus, 'error', 'tant que la suppression n\'est pas confirmée, le statut global reste en erreur');
});

test('rechargement pendant une synchronisation : le GET attend que la sync en cours se termine (pas d\'entrelacement)', async () => {
  // Extrait aussi loadFromBackendUnlocked() pour ce test précis, en plus du moteur de sync déjà
  // chargé dans `source` — les deux se partagent le même runExclusive()/backendOpChain.
  const loadSrc = extractFunction('async function loadFromBackend(') + '\n\n' + extractFunction('async function loadFromBackendUnlocked(');
  const log1 = mkLog('log1', { clientUpdatedAt: 1000 });
  const db = { climbers: [mkClimber('c1', [log1])], sessionBank: [], pendingDeletes: [] };
  const events = [];
  let releaseSync;
  const sandbox = runInSandbox({
    db,
    fetchImpl: async (url) => {
      if (url === '/api/logs/c1/sync') {
        events.push('sync:start');
        await new Promise(r => { releaseSync = r; });
        events.push('sync:end');
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (url === '/api/climbers') return { ok: true, json: async () => ([{ id: 'c1', name: 'Test', color: '#fff', level: '6a' }]) };
      if (url === '/api/bank') return { ok: true, json: async () => ([]) };
      if (url === '/api/logs/c1') {
        events.push('load:fetch-logs');
        return { ok: true, json: async () => ([{ id: 'log1', date: '2026-09-27', type: 'bloc', ascents: [], comments: [], clientUpdatedAt: 1000 }]) };
      }
      throw new Error('URL inattendue : ' + url);
    }
  });
  sandbox.window = { currentUser: { climberId: 'c1' } };
  sandbox.refreshCurrentUser = () => sandbox.window.currentUser;
  sandbox.migrateLegacyGoals = () => {};
  vm.runInContext(loadSrc, sandbox);

  const syncPromise = sandbox.syncToBackend();
  await new Promise(r => setTimeout(r, 5)); // laisse la sync démarrer et atteindre le fetch en vol
  events.push('reload:called');
  const loadPromise = sandbox.loadFromBackend();
  await new Promise(r => setTimeout(r, 5));
  // À ce stade, le reload ne doit PAS avoir encore commencé ses propres fetch (verrouillé derrière
  // la sync en cours) — s'il s'était entrelacé, 'load:fetch-logs' apparaîtrait avant 'sync:end'.
  assert.equal(events.includes('load:fetch-logs'), false, 'le rechargement ne doit pas démarrer avant la fin de la sync en cours');
  releaseSync();
  await syncPromise;
  await loadPromise;
  assert.deepEqual(events, ['sync:start', 'reload:called', 'sync:end', 'load:fetch-logs']);
});
