// test/frontend-loop-load.test.js
// Calcul de charge de la "Résistance en boucle" (public/index.html) : charge = valeur d'une ascension
// à la cotation × boucles équivalentes (mouvements atteints ÷ mouvements par boucle) × facteur de
// repos. Les fonctions sont extraites telles quelles du fichier source et exécutées dans un bac à sable.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
function extractFunction(marker) {
  const start = html.indexOf(marker);
  if (start === -1) throw new Error('Marqueur introuvable, le frontend a changé : ' + marker);
  let depth = 0, i = start, seen = false;
  for (; i < html.length; i++) {
    const ch = html[i];
    if (ch === '{') { depth++; seen = true; } else if (ch === '}') { depth--; if (seen && depth === 0) { i++; break; } }
  }
  return html.slice(start, i);
}
function extractStatement(marker) {
  const start = html.indexOf(marker);
  if (start === -1) throw new Error('Marqueur introuvable : ' + marker);
  return html.slice(start, html.indexOf(';\n', start) + 1);
}
const source = [
  extractStatement('const GRADES = ['),
  extractStatement('const GRADE_IDX = Object.fromEntries'),
  extractStatement('const KAYA_BASE = 100, KAYA_GROWTH = 1.18;'),
  extractFunction('function ascentLoad('),
  extractStatement('const LOOP_REST_FACTOR ='),
  extractStatement('const LOOP_REST_LABELS ='),
  extractFunction('function loopLoadParts('),
  extractFunction('function loopLoad('),
].join('\n');
const ctx = vm.createContext({ Math, Number });
vm.runInContext(source, ctx);
const loopLoad = ctx.loopLoad;
const parts = ctx.loopLoadParts;

test('une boucle complète au niveau de référence vaut une ascension au niveau de référence (comparable aux autres séances)', () => {
  const l = { loops: 1, grade: '7a', movesPerLoop: 30, movesReached: 0, rest: 'leger' };
  assert.equal(loopLoad(l, '7a'), 100);
});

test('exemple de la fenêtre d\'explication : 4 boucles × 30 mouvements en 7b, 105 atteints, repos léger', () => {
  const p = parts({ loops: 4, grade: '7b', movesPerLoop: 30, movesReached: 105, rest: 'leger' }, '7a');
  assert.equal(p.planned, 120);
  assert.equal(p.reached, 105);
  assert.equal(p.equiv, 3.5);
  assert.equal(p.total, Math.round(p.ascLoad * 3.5));
});

test('mouvements atteints vides : tout compte comme fait ; au-dessus du prévu : plafonné au prévu', () => {
  const base = { loops: 4, grade: '7a', movesPerLoop: 30, rest: 'leger' };
  assert.equal(loopLoad({ ...base, movesReached: 0 }, '7a'), 400);
  assert.equal(loopLoad({ ...base, movesReached: 999 }, '7a'), 400);
});

test('le repos change la charge : complet ×0,85 < léger ×1 < faible ×1,2', () => {
  const base = { loops: 4, grade: '7a', movesPerLoop: 30, movesReached: 0 };
  const complet = loopLoad({ ...base, rest: 'complet' }, '7a');
  const leger = loopLoad({ ...base, rest: 'leger' }, '7a');
  const faible = loopLoad({ ...base, rest: 'faible' }, '7a');
  assert.equal(complet, 340);
  assert.equal(leger, 400);
  assert.equal(faible, 480);
});

test('plus la voie est dure par rapport au niveau de référence, plus la charge monte', () => {
  const mk = grade => ({ loops: 3, grade, movesPerLoop: 25, movesReached: 0, rest: 'leger' });
  assert.ok(loopLoad(mk('7b'), '7a') > loopLoad(mk('7a'), '7a'));
  assert.ok(loopLoad(mk('6c'), '7a') < loopLoad(mk('7a'), '7a'));
});

test('saisie incomplète (pas de boucles, de mouvements ou de cotation) : charge 0, jamais NaN', () => {
  assert.equal(loopLoad(null, '7a'), 0);
  assert.equal(loopLoad({ loops: 0, grade: '7a', movesPerLoop: 30 }, '7a'), 0);
  assert.equal(loopLoad({ loops: 4, grade: '7a', movesPerLoop: 0 }, '7a'), 0);
  assert.equal(loopLoad({ loops: 4, grade: '', movesPerLoop: 30 }, '7a'), 0);
});
