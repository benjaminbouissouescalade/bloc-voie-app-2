// test/frontend-today.test.js
// Teste le VRAI todayStr() (public/index.html) autour de minuit, dans plusieurs fuseaux horaires —
// extrait tel quel du fichier source (aucune réécriture de logique) et exécuté dans un processus
// enfant séparé PAR fuseau (TZ ne peut pas être changé de façon fiable au milieu d'un même process
// Node une fois le cache ICU initialisé, cf. Intl/V8 — spawnSync avec env.TZ est la façon fiable de
// tester plusieurs fuseaux). Couvre l'audit : "new Date().toISOString().slice(0,10) décale
// 'aujourd'hui' d'un jour autour de minuit en France, car toISOString() convertit TOUJOURS en UTC
// avant de formater".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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

const todayStrSource = extractFunction('function todayStr(');

// Exécute todayStr() (et, pour comparaison, l'ancien calcul buggé) dans un process enfant dont
// l'horloge est figée sur `fixedIsoInstant` et le fuseau sur `tz`. Renvoie { todayStr, oldBuggy }.
function runTodayStrAt(fixedIsoInstant, tz) {
  const script = `
    ${todayStrSource}
    const FIXED_TS = new Date(${JSON.stringify(fixedIsoInstant)}).getTime();
    class FixedDate extends Date {
      constructor(...args) { if (args.length === 0) super(FIXED_TS); else super(...args); }
      static now() { return FIXED_TS; }
    }
    globalThis.Date = FixedDate;
    const oldBuggy = new Date().toISOString().slice(0, 10); // comportement AVANT correctif
    console.log(JSON.stringify({ todayStr: todayStr(), oldBuggy }));
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, TZ: tz },
    encoding: 'utf8'
  });
  if (result.status !== 0) throw new Error(`échec process enfant (TZ=${tz}): ${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}

test('Europe/Paris, hiver (UTC+1) — 23h30 UTC la veille = déjà le lendemain à Paris', () => {
  // 15 janvier 2026, 23h30 UTC = 16 janvier 2026, 00h30 à Paris (UTC+1 en janvier).
  const { todayStr, oldBuggy } = runTodayStrAt('2026-01-15T23:30:00.000Z', 'Europe/Paris');
  assert.equal(todayStr, '2026-01-16', 'à Paris, passé minuit, "aujourd\'hui" doit déjà être le 16');
  assert.equal(oldBuggy, '2026-01-15', 'démontre le bug corrigé : l\'ancien calcul restait bloqué sur le 15 (UTC)');
});

test('Europe/Paris, été (UTC+2) — DST géré automatiquement via le fuseau du système', () => {
  // 14 juillet 2026, 22h30 UTC = 15 juillet 2026, 00h30 à Paris (UTC+2 en juillet, heure d'été).
  const { todayStr, oldBuggy } = runTodayStrAt('2026-07-14T22:30:00.000Z', 'Europe/Paris');
  assert.equal(todayStr, '2026-07-15');
  assert.equal(oldBuggy, '2026-07-14', 'même décalage en heure d\'été, avec un offset différent (+2 au lieu de +1)');
});

test('UTC — aucun décalage possible par construction (heure locale = heure UTC)', () => {
  const { todayStr, oldBuggy } = runTodayStrAt('2026-01-15T23:30:00.000Z', 'UTC');
  assert.equal(todayStr, '2026-01-15');
  assert.equal(oldBuggy, '2026-01-15');
});

test('America/Los_Angeles (UTC-8, hiver) — encore la veille au moment où Paris a déjà changé de jour', () => {
  const { todayStr } = runTodayStrAt('2026-01-15T23:30:00.000Z', 'America/Los_Angeles');
  assert.equal(todayStr, '2026-01-15', '15h30 heure locale : toujours le 15 côté Los Angeles');
});

test('Asia/Tokyo (UTC+9) — déjà le lendemain matin', () => {
  const { todayStr } = runTodayStrAt('2026-01-15T23:30:00.000Z', 'Asia/Tokyo');
  assert.equal(todayStr, '2026-01-16', '08h30 le lendemain matin à Tokyo');
});

test('Pacific/Kiritimati (UTC+14, fuseau le plus en avance au monde) — cas extrême', () => {
  const { todayStr } = runTodayStrAt('2026-01-15T23:30:00.000Z', 'Pacific/Kiritimati');
  assert.equal(todayStr, '2026-01-16', '13h30 le lendemain — le fuseau le plus en avance ne doit pas dérouter le calcul');
});

test('en pleine journée (loin de minuit), aucun fuseau ne change le résultat par rapport à UTC', () => {
  const fixed = '2026-06-10T12:00:00.000Z'; // 12h UTC : marge large de chaque côté de minuit partout
  const paris = runTodayStrAt(fixed, 'Europe/Paris');
  const tokyo = runTodayStrAt(fixed, 'Asia/Tokyo');
  const la = runTodayStrAt(fixed, 'America/Los_Angeles');
  assert.equal(paris.todayStr, '2026-06-10');
  assert.equal(tokyo.todayStr, '2026-06-10');
  assert.equal(la.todayStr, '2026-06-10');
});
