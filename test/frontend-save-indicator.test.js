// test/frontend-save-indicator.test.js
// Teste l'indicateur de sauvegarde par séance (logSyncState(), cf. public/index.html) et le
// correctif de capture des versions AVANT l'await dans doSync() — extrait le VRAI code source
// (aucune réécriture de logique) et l'exécute dans un bac à sable Node.
//
// Rappel des trois états attendus (cf. SYNC_STATUS_LABELS) :
//   - 'pending' : modification enregistrée sur cet appareil (localStorage), pas encore confirmée
//                 par le serveur pour CETTE version précise.
//   - 'saved'   : le serveur a confirmé (res.ok vérifié) la version ACTUELLE de cette séance.
//   - 'error'   : la dernière tentative d'envoi de cette version a échoué (réseau ou HTTP non-ok).
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
  extractFunction('function logSyncState('),
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
  extractFunction('async function loadFromBackend('),
  extractFunction('async function loadFromBackendUnlocked('),
].join('\n\n');

function runInSandbox({ fetchImpl, db }) {
  const sandbox = {
    console,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    fetch: fetchImpl,
    STORAGE_KEY: 'bv_db',
    authToken: () => 'fake-token',
    authHeaders: () => ({ 'Content-Type': 'application/json', Authorization: 'Bearer fake-token' }),
    setTimeout: () => ({}), // pas de vrais essais automatiques dans ces tests
    clearTimeout: () => {},
    document: { getElementById: () => null },
    refreshCurrentUser: () => ({ climberId: 'c1' }),
    migrateLegacyGoals: () => {},
    db: db || { climbers: [], sessionBank: [], pendingDeletes: [] }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox;
}

function mkClimber(id, logs) {
  return { id, name: 'Test', color: '#fff', level: '6a', trips: [], profile: {}, objectives: [], cycleObjectives: [], logs, pushedLogVersions: {}, logSyncErrors: {} };
}
function mkLog(id, overrides = {}) {
  return { id, date: '2026-09-27', type: 'bloc', ascents: [], clientUpdatedAt: Date.now(), ...overrides };
}

test('succès : logSyncState passe à "saved" seulement après confirmation serveur (res.ok)', async () => {
  const log1 = mkLog('log1');
  const db = { climbers: [mkClimber('c1', [log1])], sessionBank: [], pendingDeletes: [] };
  const sandbox = runInSandbox({ db, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }) });
  assert.equal(sandbox.logSyncState('c1', 'log1'), 'pending', 'avant tout envoi : en attente');
  await sandbox.syncToBackend();
  assert.equal(sandbox.logSyncState('c1', 'log1'), 'saved');
});

test('coupure réseau : logSyncState passe à "error", jamais à "saved"', async () => {
  const log1 = mkLog('log1');
  const db = { climbers: [mkClimber('c1', [log1])], sessionBank: [], pendingDeletes: [] };
  const sandbox = runInSandbox({ db, fetchImpl: async () => { throw new Error('réseau coupé'); } });
  await sandbox.syncToBackend();
  assert.equal(sandbox.logSyncState('c1', 'log1'), 'error');
});

test('HTTP 500 : logSyncState passe à "error", la localStorage ni le fetch terminé ne suffisent à "saved"', async () => {
  const log1 = mkLog('log1');
  const db = { climbers: [mkClimber('c1', [log1])], sessionBank: [], pendingDeletes: [] };
  const sandbox = runInSandbox({
    db,
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) })
  });
  await sandbox.syncToBackend();
  assert.equal(sandbox.logSyncState('c1', 'log1'), 'error', 'un fetch qui aboutit avec une erreur HTTP n\'est pas une confirmation');
});

test('erreur puis nouvel essai réussi : "error" redevient "pending" pendant la tentative, puis "saved"', async () => {
  const log1 = mkLog('log1');
  const db = { climbers: [mkClimber('c1', [log1])], sessionBank: [], pendingDeletes: [] };
  let fail = true;
  const sandbox = runInSandbox({
    db,
    fetchImpl: async () => fail ? { ok: false, status: 500, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ ok: true }) }
  });
  await sandbox.syncToBackend();
  assert.equal(sandbox.logSyncState('c1', 'log1'), 'error');
  fail = false;
  await sandbox.syncToBackend(); // équivalent du clic sur "Réessayer"
  assert.equal(sandbox.logSyncState('c1', 'log1'), 'saved');
});

test('nouvelle modification PENDANT l\'envoi : la confirmation de l\'ancienne version ne fait pas passer la nouvelle à "saved"', async () => {
  const log1 = mkLog('log1', { notes: 'v1', clientUpdatedAt: 1000 });
  const db = { climbers: [mkClimber('c1', [log1])], sessionBank: [], pendingDeletes: [] };
  let releaseFetch;
  const sandbox = runInSandbox({
    db,
    fetchImpl: async (url) => {
      if (url !== '/api/logs/c1/sync') return { ok: true, status: 200, json: async () => ({ ok: true }) };
      await new Promise(r => { releaseFetch = r; }); // reste "en vol" jusqu'à ce qu'on la libère nous-même
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
  });
  const syncPromise = sandbox.syncToBackend();
  await new Promise(r => setTimeout(r, 5)); // laisse doSync() capturer dirtyLogs et partir dans le fetch
  assert.equal(sandbox.logSyncState('c1', 'log1'), 'pending', 'toujours en attente pendant que la requête est en vol');
  // L'utilisateur modifie ENCORE la séance avant que le serveur ait répondu à l'envoi précédent.
  log1.notes = 'v2';
  log1.clientUpdatedAt = 2000;
  releaseFetch();
  await syncPromise;
  assert.equal(
    sandbox.logSyncState('c1', 'log1'), 'pending',
    'la confirmation reçue ne concernait que la version 1000 (v1) — la version 2000 (v2), plus récente, n\'a jamais été envoyée et ne doit donc jamais apparaître "saved"'
  );
  assert.equal(db.climbers[0].pushedLogVersions['log1'], 1000, 'seule la version réellement envoyée (1000) doit être marquée confirmée');
});

test('rechargement de page AVANT confirmation : une séance déjà confirmée reste "saved" après reload (pushedLogVersions préservé)', async () => {
  const savedLog = mkLog('log_saved', { clientUpdatedAt: 500 });
  const pendingLog = mkLog('log_pending', { clientUpdatedAt: 900 });
  const climber = mkClimber('c1', [savedLog, pendingLog]);
  climber.pushedLogVersions = { log_saved: 500 }; // déjà confirmé AVANT le rechargement
  climber.knownServerLogIds = ['log_saved']; // le serveur n'a jamais vu log_pending avant ce rechargement
  const db = { climbers: [climber], sessionBank: [], pendingDeletes: [] };

  const sandbox = runInSandbox({
    db,
    fetchImpl: async (url) => {
      if (url === '/api/climbers') return { ok: true, json: async () => ([{ id: 'c1', name: 'Test', color: '#fff', level: '6a' }]) };
      if (url === '/api/bank') return { ok: true, json: async () => ([]) };
      if (url === '/api/logs/c1') {
        // Le serveur ne connaît que la séance déjà confirmée AVANT le rechargement — la seconde,
        // modifiée juste avant de recharger la page, n'a jamais atteint le serveur.
        return { ok: true, json: async () => ([{ id: 'log_saved', date: '2026-09-27', type: 'bloc', ascents: [], comments: [], clientUpdatedAt: 500 }]) };
      }
      throw new Error('URL inattendue : ' + url);
    }
  });

  assert.equal(sandbox.logSyncState('c1', 'log_saved'), 'saved', 'avant rechargement');
  assert.equal(sandbox.logSyncState('c1', 'log_pending'), 'pending', 'avant rechargement');

  const result = await sandbox.loadFromBackend(); // simule le rechargement de page (appelé par initAppData)
  assert.equal(result, true);

  assert.equal(sandbox.logSyncState('c1', 'log_saved'), 'saved', 'une séance déjà confirmée AVANT le rechargement doit le rester APRÈS (pas de faux "en attente")');
  assert.equal(sandbox.logSyncState('c1', 'log_pending'), 'pending', 'la modification non confirmée doit rester visible "en attente" après rechargement, et n\'a pas disparu');
  const merged = db.climbers.find(c => c.id === 'c1');
  assert.equal(merged.logs.some(l => l.id === 'log_pending'), true, 'la séance jamais synchronisée ne doit jamais être perdue par un rechargement');
});

test('une coupure réseau ne fait jamais disparaître la séance locale (elle reste "en attente", pas supprimée)', async () => {
  const log1 = mkLog('log1');
  const db = { climbers: [mkClimber('c1', [log1])], sessionBank: [], pendingDeletes: [] };
  const sandbox = runInSandbox({ db, fetchImpl: async () => { throw new Error('coupure réseau'); } });
  await sandbox.syncToBackend();
  assert.equal(db.climbers[0].logs.some(l => l.id === 'log1'), true);
  assert.equal(sandbox.logSyncState('c1', 'log1'), 'error');
});
