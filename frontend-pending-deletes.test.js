// test/frontend-pending-deletes.test.js
// Teste le VRAI code frontend (public/index.html) pour le suivi des suppressions "en attente" et
// la réconciliation au chargement — sans navigateur : on extrait le texte source exact des
// fonctions concernées (aucune réécriture/duplication de logique) et on l'exécute dans un
// bac à sable Node avec un fetch/localStorage simulés. Couvre le scénario "échec réseau puis
// rechargement" demandé dans l'audit "pertes et réapparitions de séances".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// Extrait le texte source exact d'une fonction, en comptant les accolades depuis un marqueur de
// début connu (ex. "async function loadFromBackend() {") jusqu'à sa fermeture. Casse volontairement
// si le marqueur n'existe plus (renommage/suppression côté frontend) plutôt que de tester du vide.
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

const source = [
  extractFunction('function markLogPendingDelete('),
  extractFunction('function clearPendingDelete('),
  extractFunction('async function attemptDelete('),
  extractFunction('async function attemptPendingDeletes('),
  extractFunction('async function loadFromBackend('),
].join('\n\n');

function runInSandbox({ fetchImpl, storageBacking = {} }) {
  const localStorageStub = {
    getItem: k => (k in storageBacking ? storageBacking[k] : null),
    setItem: (k, v) => { storageBacking[k] = String(v); },
    removeItem: k => { delete storageBacking[k]; }
  };
  const sandbox = {
    console,
    localStorage: localStorageStub,
    fetch: fetchImpl,
    STORAGE_KEY: 'bv_db',
    window: { currentUser: { climberId: 'c_test' } },
    authToken: () => 'fake-token',
    authHeaders: () => ({ 'Content-Type': 'application/json', Authorization: 'Bearer fake-token' }),
    refreshCurrentUser: () => sandbox.window.currentUser,
    migrateLegacyGoals: () => {}, // hors-sujet pour ces tests, no-op fidèle au comportement neutre
    db: { climbers: [], sessionBank: [], activeId: null, pendingDeletes: [] }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox;
}

test('markLogPendingDelete / clearPendingDelete : bookkeeping de base', () => {
  const sandbox = runInSandbox({ fetchImpl: async () => { throw new Error('non utilisé ici'); } });
  sandbox.markLogPendingDelete('c1', 'log_a');
  sandbox.markLogPendingDelete('c1', 'log_a'); // idempotent, pas de doublon
  assert.equal(JSON.stringify(sandbox.db.pendingDeletes), JSON.stringify([{ climberId: 'c1', logId: 'log_a' }]));
  sandbox.clearPendingDelete('log_a');
  assert.equal(JSON.stringify(sandbox.db.pendingDeletes), '[]');
});

test('scénario 4a — échec réseau : la suppression reste en attente (retentable)', async () => {
  const sandbox = runInSandbox({ fetchImpl: async () => { throw new Error('réseau coupé'); } });
  sandbox.markLogPendingDelete('c_test', 'log_x');
  const ok = await sandbox.attemptDelete('c_test', 'log_x');
  assert.equal(ok, false);
  assert.equal(JSON.stringify(sandbox.db.pendingDeletes), JSON.stringify([{ climberId: 'c_test', logId: 'log_x' }]), 'doit rester en attente après un échec réseau');
});

test('scénario 4a bis — un fetch qui aboutit mais renvoie une erreur HTTP n\'est PAS une confirmation', async () => {
  const sandbox = runInSandbox({
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) })
  });
  sandbox.markLogPendingDelete('c_test', 'log_y');
  const ok = await sandbox.attemptDelete('c_test', 'log_y');
  assert.equal(ok, false);
  assert.equal(JSON.stringify(sandbox.db.pendingDeletes), JSON.stringify([{ climberId: 'c_test', logId: 'log_y' }]));
});

test('un DELETE confirmé (200 + {ok:true}) retire bien la suppression de la liste d\'attente', async () => {
  const sandbox = runInSandbox({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, rowCount: 1 }) })
  });
  sandbox.markLogPendingDelete('c_test', 'log_z');
  const ok = await sandbox.attemptDelete('c_test', 'log_z');
  assert.equal(ok, true);
  assert.equal(JSON.stringify(sandbox.db.pendingDeletes), '[]');
});

test('scénario 4b — après rechargement, une séance en attente de suppression ne réapparaît pas même si le serveur la montre encore', async () => {
  // Le DELETE a échoué (réseau coupé) AVANT ce rechargement : le serveur montre donc encore la
  // séance dans sa réponse GET. loadFromBackend() ne doit pas la réafficher pour autant.
  const sandbox = runInSandbox({
    fetchImpl: async (url) => {
      if (url === '/api/climbers') return { ok: true, json: async () => ([{ id: 'c_test', name: 'Test', color: '#fff', level: '6a' }]) };
      if (url === '/api/bank') return { ok: true, json: async () => ([]) };
      if (url === '/api/logs/c_test') {
        return { ok: true, json: async () => ([{ id: 'log_pending', date: '2026-09-20', type: 'bloc', ascents: [], comments: [] }]) };
      }
      throw new Error('URL inattendue : ' + url);
    }
  });
  sandbox.db.pendingDeletes = [{ climberId: 'c_test', logId: 'log_pending' }];
  sandbox.db.climbers = [{ id: 'c_test', logs: [], knownServerLogIds: ['log_pending'] }];

  const result = await sandbox.loadFromBackend();
  assert.equal(result, true);
  const merged = sandbox.db.climbers.find(c => c.id === 'c_test');
  assert.equal(merged.logs.some(l => l.id === 'log_pending'), false, 'une suppression en attente ne doit jamais réapparaître, même si le serveur la montre encore');
});

test('une séance jamais synchronisée (absente du serveur ET jamais vue avant) est préservée au chargement', async () => {
  const sandbox = runInSandbox({
    fetchImpl: async (url) => {
      if (url === '/api/climbers') return { ok: true, json: async () => ([{ id: 'c_test', name: 'Test', color: '#fff', level: '6a' }]) };
      if (url === '/api/bank') return { ok: true, json: async () => ([]) };
      if (url === '/api/logs/c_test') return { ok: true, json: async () => ([]) }; // rien côté serveur
      throw new Error('URL inattendue : ' + url);
    }
  });
  sandbox.db.climbers = [{ id: 'c_test', logs: [{ id: 'log_local_only', date: '2026-09-27', type: 'bloc' }], knownServerLogIds: [] }];

  await sandbox.loadFromBackend();
  const merged = sandbox.db.climbers.find(c => c.id === 'c_test');
  assert.equal(merged.logs.some(l => l.id === 'log_local_only'), true, 'une séance jamais synchronisée doit être préservée (pas confondue avec une suppression)');
});

test('une séance déjà vue côté serveur puis absente (supprimée par un autre appareil) n\'est pas réintégrée', async () => {
  const sandbox = runInSandbox({
    fetchImpl: async (url) => {
      if (url === '/api/climbers') return { ok: true, json: async () => ([{ id: 'c_test', name: 'Test', color: '#fff', level: '6a' }]) };
      if (url === '/api/bank') return { ok: true, json: async () => ([]) };
      if (url === '/api/logs/c_test') return { ok: true, json: async () => ([]) }; // le serveur ne la montre plus
      throw new Error('URL inattendue : ' + url);
    }
  });
  // Ce même id avait été vu lors d'un chargement précédent (knownServerLogIds) — donc absent
  // maintenant = supprimé quelque part, pas "jamais synchronisé".
  sandbox.db.climbers = [{ id: 'c_test', logs: [{ id: 'log_deleted_elsewhere', date: '2026-09-01', type: 'bloc' }], knownServerLogIds: ['log_deleted_elsewhere'] }];

  await sandbox.loadFromBackend();
  const merged = sandbox.db.climbers.find(c => c.id === 'c_test');
  assert.equal(merged.logs.some(l => l.id === 'log_deleted_elsewhere'), false);
});

test('un échec réseau sur le GET des logs d\'un grimpeur préserve son état local tel quel (pas de perte)', async () => {
  const sandbox = runInSandbox({
    fetchImpl: async (url) => {
      if (url === '/api/climbers') return { ok: true, json: async () => ([{ id: 'c_test', name: 'Test', color: '#fff', level: '6a' }]) };
      if (url === '/api/bank') return { ok: true, json: async () => ([]) };
      if (url === '/api/logs/c_test') return { ok: false, status: 500, json: async () => ({ error: 'panne' }) };
      throw new Error('URL inattendue : ' + url);
    }
  });
  sandbox.db.climbers = [{ id: 'c_test', logs: [{ id: 'log_safe', date: '2026-09-27', type: 'bloc' }], knownServerLogIds: ['log_safe'] }];

  await sandbox.loadFromBackend();
  const merged = sandbox.db.climbers.find(c => c.id === 'c_test');
  assert.equal(merged.logs.some(l => l.id === 'log_safe'), true, 'un échec réseau ne doit jamais faire disparaître des séances déjà connues localement');
});
