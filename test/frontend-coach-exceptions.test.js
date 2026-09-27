// test/frontend-coach-exceptions.test.js
// Teste le VRAI computeCoachExceptions() (public/index.html) : les quatre règles de détection
// (séance manquée, douleur signalée, forte hausse de charge, objectif sans progrès) et la stabilité
// des clés utilisées pour le "Vu" (cf. src/routes/exceptions.js). Extrait le code source tel quel et
// l'exécute dans un bac à sable Node, avec une horloge figée pour des dates déterministes.
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

// computeCoachExceptions() s'appuie sur climberBaseline()/climberWeeklyLoads() pour la règle "forte
// hausse de charge" — ces deux fonctions dépendent elles-mêmes d'une longue chaîne de calcul de
// charge (routeLogs, isBlocGradedType, SESSION_CONFIG, GRADE_IDX, ascentLoad, refGradeVotes...) qui
// a sa propre logique déjà éprouvée ailleurs dans l'appli et n'est PAS ce que cette règle-ci doit
// vérifier. On les remplace donc ici par des étubs simples et déterministes (sandbox.climberBaseline
// / sandbox.climberWeeklyLoads, pilotés par c._testBaseline / c._testWeeklyLoads sur chaque grimpeur
// de test) : ce fichier teste le SEUIL et la décision de computeCoachExceptions(), pas le calcul de
// charge lui-même — cf. les tests dédiés à sessionLoad ailleurs dans ce projet pour ça.
const source = [
  extractFunction('function todayStr('),
  extractFunction('function daysSinceDateStr('),
  extractStatement('const COACH_EXC_MISSED_DAYS = 2;'),
  extractStatement('const COACH_EXC_PAIN_DAYS = 7;'),
  extractStatement('const COACH_EXC_LOAD_RATIO = 1.5;'),
  extractStatement('const COACH_EXC_OBJECTIVE_STALL_DAYS = 21;'),
  extractStatement('const COACH_EXC_TYPE_META = {\n  missed:    { icon: \'📌\', label: \'Séance manquée\' },\n  pain:      { icon: \'🩹\', label: \'Douleur signalée\' },\n  load:      { icon: \'📈\', label: \'Forte hausse de charge\' },\n  objective: { icon: \'🎯\', label: "Objectif qui n\'avance pas" }\n};'),
  extractFunction('function computeCoachExceptions('),
].join('\n\n');

function isoDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}
function isoDaysAhead(n) { return isoDaysAgo(-n); }

function runInSandbox() {
  const sandbox = {
    console,
    climberBaseline: (c) => c._testBaseline || 0,
    climberWeeklyLoads: (c, n) => c._testWeeklyLoads || Array(n).fill(0)
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox;
}

function mkClimber(id, name, overrides = {}) {
  return { id, name, level: '6a', profile: {}, logs: [], objectives: [], ...overrides };
}
function mkLog(id, date, overrides = {}) {
  return { id, date, type: 'bloc', ascents: [], bNoGrade: {}, planned: false, clientUpdatedAt: Date.now(), ...overrides };
}

test('séance manquée : détectée seulement après le délai de tolérance, pas avant', () => {
  const sandbox = runInSandbox();
  const tooRecent = mkClimber('c1', 'A', { logs: [mkLog('l1', isoDaysAgo(1), { planned: true })] }); // 1 jour de retard < seuil (2)
  const late = mkClimber('c2', 'B', { logs: [mkLog('l2', isoDaysAgo(5), { planned: true })] }); // 5 jours de retard
  const future = mkClimber('c3', 'C', { logs: [mkLog('l3', isoDaysAhead(3), { planned: true })] }); // pas encore en retard

  const exTooRecent = sandbox.computeCoachExceptions([tooRecent]);
  const exLate = sandbox.computeCoachExceptions([late]);
  const exFuture = sandbox.computeCoachExceptions([future]);

  assert.equal(exTooRecent.filter(x => x.type === 'missed').length, 0);
  assert.equal(exFuture.filter(x => x.type === 'missed').length, 0);
  assert.equal(exLate.filter(x => x.type === 'missed').length, 1);
  assert.equal(exLate[0].key, 'missed:l2');
  assert.equal(exLate[0].climberId, 'c2');
});

test('une séance planifiée déjà faite (planned:false) ou supprimée (absente) n\'est jamais "manquée"', () => {
  const sandbox = runInSandbox();
  const done = mkClimber('c1', 'A', { logs: [mkLog('l1', isoDaysAgo(10), { planned: false })] });
  const exceptions = sandbox.computeCoachExceptions([done]);
  assert.equal(exceptions.filter(x => x.type === 'missed').length, 0);
});

test('douleur signalée : dans la fenêtre -> détectée, hors fenêtre -> pas détectée', () => {
  const sandbox = runInSandbox();
  const recent = mkClimber('c1', 'A', { logs: [mkLog('l1', isoDaysAgo(3), { planned: false, injury: true, injuryNote: 'genou' })] });
  const old = mkClimber('c2', 'B', { logs: [mkLog('l2', isoDaysAgo(30), { planned: false, injury: true })] });
  const noInjury = mkClimber('c3', 'C', { logs: [mkLog('l3', isoDaysAgo(1), { planned: false, injury: false })] });

  const exRecent = sandbox.computeCoachExceptions([recent]);
  const exOld = sandbox.computeCoachExceptions([old]);
  const exNone = sandbox.computeCoachExceptions([noInjury]);

  assert.equal(exRecent.filter(x => x.type === 'pain').length, 1);
  assert.match(exRecent[0].message, /genou/);
  assert.equal(exOld.filter(x => x.type === 'pain').length, 0);
  assert.equal(exNone.filter(x => x.type === 'pain').length, 0);
});

test('une séance PLANIFIÉE avec injury=true n\'est pas comptée comme douleur (pas encore réalisée)', () => {
  const sandbox = runInSandbox();
  const c = mkClimber('c1', 'A', { logs: [mkLog('l1', isoDaysAgo(1), { planned: true, injury: true })] });
  const exceptions = sandbox.computeCoachExceptions([c]);
  assert.equal(exceptions.filter(x => x.type === 'pain').length, 0);
});

test('forte hausse de charge : détectée si la charge de la semaine dépasse le ratio × la baseline', () => {
  const sandbox = runInSandbox();
  const spiking = mkClimber('c1', 'Spike', {});
  spiking._testBaseline = 100;
  spiking._testWeeklyLoads = [160]; // 1.6 × baseline > seuil 1.5
  const exceptions = sandbox.computeCoachExceptions([spiking]);
  const loadEx = exceptions.filter(x => x.type === 'load');
  assert.equal(loadEx.length, 1, 'une hausse nette (×1,6) doit être détectée');
  assert.match(loadEx[0].key, /^load:c1:\d{4}-\d{2}-\d{2}$/);
});

test('charge en hausse mais SOUS le ratio seuil : pas d\'exception', () => {
  const sandbox = runInSandbox();
  const c = mkClimber('c1', 'A', {});
  c._testBaseline = 100;
  c._testWeeklyLoads = [120]; // ×1.2 < seuil 1.5
  const exceptions = sandbox.computeCoachExceptions([c]);
  assert.equal(exceptions.filter(x => x.type === 'load').length, 0);
});

test('pas de baseline établie (athlète récent) : pas de fausse alerte de charge, même avec une charge élevée', () => {
  const sandbox = runInSandbox();
  const newAthlete = mkClimber('c1', 'Nouveau', {});
  newAthlete._testBaseline = 0; // climberBaseline() renvoie 0 tant qu'il n'y a pas assez d'historique
  newAthlete._testWeeklyLoads = [500];
  const exceptions = sandbox.computeCoachExceptions([newAthlete]);
  assert.equal(exceptions.filter(x => x.type === 'load').length, 0);
});

test('objectif qui n\'avance pas : détecté après le délai, ignoré si une séance récente y est rattachée', () => {
  const sandbox = runInSandbox();
  const stalled = mkClimber('c1', 'A', {
    objectives: [{ id: 'obj1', title: '7a en tête', status: 'active', createdAt: new Date(Date.now() - 40 * 86400000).toISOString() }],
    logs: []
  });
  const active = mkClimber('c2', 'B', {
    objectives: [{ id: 'obj2', title: '7b en tête', status: 'active', createdAt: new Date(Date.now() - 40 * 86400000).toISOString() }],
    logs: [mkLog('l2', isoDaysAgo(5), { planned: false, objectiveId: 'obj2' })]
  });
  const tooNew = mkClimber('c3', 'C', {
    objectives: [{ id: 'obj3', title: 'Récent', status: 'active', createdAt: new Date().toISOString() }],
    logs: []
  });
  const done = mkClimber('c4', 'D', {
    objectives: [{ id: 'obj4', title: 'Atteint', status: 'done', createdAt: new Date(Date.now() - 40 * 86400000).toISOString() }],
    logs: []
  });

  assert.equal(sandbox.computeCoachExceptions([stalled]).filter(x => x.type === 'objective').length, 1);
  assert.equal(sandbox.computeCoachExceptions([active]).filter(x => x.type === 'objective').length, 0, 'une séance récente rattachée doit annuler l\'alerte');
  assert.equal(sandbox.computeCoachExceptions([tooNew]).filter(x => x.type === 'objective').length, 0, 'objectif trop récent pour juger d\'un décrochage');
  assert.equal(sandbox.computeCoachExceptions([done]).filter(x => x.type === 'objective').length, 0, 'un objectif atteint ne doit jamais générer d\'alerte');
});

test('les clés sont stables : recalculer sur les mêmes données produit exactement les mêmes clés', () => {
  const sandbox = runInSandbox();
  const c = mkClimber('c1', 'A', { logs: [mkLog('l1', isoDaysAgo(5), { planned: true })] });
  const keys1 = sandbox.computeCoachExceptions([c]).map(x => x.key).sort();
  const keys2 = sandbox.computeCoachExceptions([c]).map(x => x.key).sort();
  assert.deepEqual(keys1, keys2);
});
