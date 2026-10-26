// test/frontend-proposed-sessions.test.js
// Séances proposées à un partenaire (public/index.html) : refus ("Je ne viens plus") qui fait
// disparaître la proposition des notifications/calendrier, séance planifiée créée pour les invités,
// retrait quand on refuse. Fonctions extraites telles quelles du fichier source.
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
const source = [
  extractFunction('function declinedProposalIds('),
  extractFunction('function proposedOnDate('),
  extractFunction('function pendingProposedForMe('),
  extractFunction('function syncProposedToLogs('),
].join('\n');

function makeCtx({ proposals, profile = {}, logs = [] }) {
  const me = { id: 'c_lisa', profile, logs };
  const saves = [], pendingDeletes = [];
  const ctx = vm.createContext({
    db: { climbers: [me] },
    window: { currentUser: { climberId: 'c_lisa' } },
    appMode: 'mine',
    proposedCalCache: proposals,
    isSelfClimber: c => c && c.id === 'c_lisa',
    saveDB: () => saves.push(1),
    markLogPendingDelete: (cid, lid) => pendingDeletes.push(lid),
    Date, Set, Array, Object, Map
  });
  vm.runInContext(source, ctx);
  return { ctx, me, saves, pendingDeletes };
}
const future = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
const invitedToMe = (id, extra = {}) => ({ id, date: future, type: 'bloc', isMine: false, imParticipating: false, invitees: [{ id: 'c_lisa' }], participants: [{ id: 'c_ben', name: 'Ben' }], createdByName: 'Ben', ...extra });

test('invité : une vraie séance planifiée est créée dès la réception (avant "Je participe")', () => {
  const { ctx, me } = makeCtx({ proposals: [invitedToMe('ps_1')] });
  ctx.syncProposedToLogs();
  const log = me.logs.find(l => l.id === 'log_ps_ps_1');
  assert.ok(log, 'la séance planifiée existe');
  assert.equal(log.planned, true);
  assert.equal(log.date, future);
});

test('pas de doublon : une seconde synchro ne recrée pas la séance', () => {
  const { ctx, me } = makeCtx({ proposals: [invitedToMe('ps_1')] });
  ctx.syncProposedToLogs();
  ctx.syncProposedToLogs();
  assert.equal(me.logs.filter(l => l.id === 'log_ps_ps_1').length, 1);
});

test('refus ("Je ne viens plus") : la proposition disparaît des cases, des notifications, et la séance prévue est retirée', () => {
  const { ctx, me, pendingDeletes } = makeCtx({ proposals: [invitedToMe('ps_1')] });
  ctx.syncProposedToLogs();
  assert.equal(ctx.pendingProposedForMe().length, 1, 'en attente de réponse avant le refus');
  me.profile.declinedProposals = ['ps_1'];
  assert.equal(ctx.pendingProposedForMe().length, 0, 'plus de notification');
  assert.equal(ctx.proposedOnDate(me, future, true).length, 0, 'plus dans la fenêtre du jour');
  ctx.syncProposedToLogs();
  assert.ok(!me.logs.some(l => l.id === 'log_ps_ps_1'), 'la séance prévue est retirée');
  assert.deepEqual(pendingDeletes, ['log_ps_ps_1'], 'et sa suppression est envoyée au serveur');
});

test('une séance déjà FAITE issue d\'une proposition n\'est jamais retirée, même si on refuse après', () => {
  const done = { id: 'log_ps_ps_1', date: future, type: 'bloc', planned: false };
  const { ctx, me } = makeCtx({ proposals: [invitedToMe('ps_1')], profile: { declinedProposals: ['ps_1'] }, logs: [done] });
  ctx.syncProposedToLogs();
  assert.ok(me.logs.some(l => l.id === 'log_ps_ps_1'));
});

test('les cases du calendrier n\'affichent plus de mention "?" : la proposition est une vraie séance', () => {
  const { ctx, me } = makeCtx({ proposals: [invitedToMe('ps_1')] });
  assert.equal(ctx.proposedOnDate(me, future).length, 0);
  assert.equal(ctx.proposedOnDate(me, future, true).length, 1);
});
