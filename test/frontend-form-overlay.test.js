// test/frontend-form-overlay.test.js
// Courbe "Forme" du graphique de charge (public/index.html) : forme déclarée par séance (😓 low / 🙂 normal
// / 💪 good) moyennée par semaine ou par jour, pour analyser charge élevée vs forme basse.
// Les dates des séances sont des chaînes AAAA-MM-JJ lues en UTC : on fixe le fuseau pour un test déterministe.
process.env.TZ = 'UTC';
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
  extractStatement('const SHAPE_VALUE ='),
  extractStatement('const FEEL_VALUE ='),
  extractFunction('function weeklyData('),
  extractFunction('function dailyWorkloadData('),
].join('\n');

const iso = d => d.toISOString().slice(0, 10);
const daysAgo = n => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - n); return iso(d); };
function ctxWith(logs) {
  const ctx = vm.createContext({ Date, Math, getLogs: () => logs, sessionLoad: l => l.load || 100 });
  vm.runInContext(source, ctx);
  return ctx;
}

test('jour par jour : la forme du jour est la moyenne des séances (low=1, normal=2, good=3)', () => {
  const ctx = ctxWith([
    { date: daysAgo(1), shape: 'low', load: 300 },
    { date: daysAgo(1), shape: 'good', load: 100 },
    { date: daysAgo(2), shape: 'low', load: 200 },
  ]);
  const days = ctx.dailyWorkloadData(7);
  const yesterday = days[days.length - 2], twoDaysAgo = days[days.length - 3];
  assert.equal(yesterday.avgShape, 2, '(1 + 3) / 2');
  assert.equal(twoDaysAgo.avgShape, 1);
  assert.equal(days[days.length - 1].avgShape, null, 'aucun jour sans séance ne reçoit de forme inventée');
});

test('par semaine : la forme moyenne est calculée sur les séances de la semaine, les séances prévues sont ignorées', () => {
  const ctx = ctxWith([
    { date: daysAgo(1), shape: 'low', load: 800 },
    { date: daysAgo(1), shape: 'low', load: 800 },
    { date: daysAgo(1), shape: 'good', load: 100, planned: true },
  ]);
  const weeks = ctx.weeklyData(4);
  const withSessions = weeks.filter(w => w.sessions > 0);
  assert.equal(withSessions.length >= 1, true);
  withSessions.forEach(w => assert.equal(w.avgShape, 1, 'seules les séances faites comptent, pas la séance prévue en "good"'));
  assert.equal(weeks[0].avgShape, null);
});

test('forme absente ou inconnue : ignorée plutôt que comptée comme 0', () => {
  const ctx = ctxWith([{ date: daysAgo(1), load: 100 }, { date: daysAgo(1), shape: 'bizarre', load: 100 }]);
  const days = ctx.dailyWorkloadData(3);
  assert.equal(days[days.length - 2].avgShape, null);
});

test('sensation de fin de séance : moyenne par jour, 1 = trop dure (courbe en bas) … 5 = trop facile', () => {
  const src = source;
  const ctx = vm.createContext({ Date, Math, getLogs: () => [
    { date: daysAgo(1), feeling: 'hard', load: 100 },
    { date: daysAgo(1), feeling: 'too_hard', load: 100 },
    { date: daysAgo(2), feeling: 'right', load: 100 },
    { date: daysAgo(3), feeling: 'inconnu', load: 100 },
  ], sessionLoad: l => l.load });
  vm.runInContext(src, ctx);
  const days = ctx.dailyWorkloadData(7);
  assert.equal(days[days.length - 2].avgFeel, 1.5);
  assert.equal(days[days.length - 3].avgFeel, 3);
  assert.equal(days[days.length - 4].avgFeel, null);
});
