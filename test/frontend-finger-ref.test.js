// test/frontend-finger-ref.test.js
// Poids de référence "force doigts" : mesuré à deux mains (défaut) ou à une main (cas d'Agathe : max 15 kg
// à une main, série à 12 kg → 80 %, pas 160 %).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
function extractFunction(marker) {
  const start = html.indexOf(marker);
  if (start === -1) throw new Error('Marqueur introuvable : ' + marker);
  let depth = 0, i = start, seen = false;
  for (; i < html.length; i++) {
    const ch = html[i];
    if (ch === '{') { depth++; seen = true; } else if (ch === '}') { depth--; if (seen && depth === 0) { i++; break; } }
  }
  return html.slice(start, i);
}
const source = ['function fingerRefWeight(', 'function fingerRefMode(', 'function fingerRefWeightForHand('].map(extractFunction).join('\n');
function ctxWith(ref, mode) {
  const els = { 's-finger-refweight': { value: String(ref) }, 's-finger-refmode': { value: mode } };
  const ctx = vm.createContext({ document: { getElementById: id => els[id] || null }, getActive: () => null });
  vm.runInContext(source, ctx);
  return ctx;
}

test('référence à une main : 12 kg sur 15 kg = 80 %', () => {
  const c = ctxWith(15, 'one');
  assert.equal(c.fingerRefWeightForHand('right'), 15);
  assert.equal(Math.round(12 / c.fingerRefWeightForHand('right') * 100), 80);
  assert.equal(c.fingerRefWeightForHand('both'), 30);
});

test('référence à deux mains (défaut) : comportement historique conservé', () => {
  const c = ctxWith(40, 'both');
  assert.equal(c.fingerRefWeightForHand('both'), 40);
  assert.equal(c.fingerRefWeightForHand('left'), 20);
});
