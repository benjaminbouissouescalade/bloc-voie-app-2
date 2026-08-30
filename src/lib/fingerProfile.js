// src/lib/fingerProfile.js
// Moteur de calcul du module "Finger Profile" — population normative Berta et al. 2024.
// Les données de référence (src/data/berta2024.json) sont en lecture seule, jamais modifiées ici.
//
// Le moteur statistique générique (échantillonnage par IRCRA, quantiles, percentile, confiance)
// vit désormais dans referenceStats.js — réutilisé aussi par SmartBoard/réglette via
// referenceMappings.js + routes/references.js (retour utilisateur : "ne recrée pas un deuxième
// moteur si celui-ci peut être généralisé"). Ce fichier ne fait plus que brancher ce moteur sur le
// dataset Berta et sur les 4 champs spécifiques à Finger Profile — comportement et API publique
// (module.exports) inchangés.

const referenceStats = require('./referenceStats');
const { REFERENCE_DATASETS, loadDataset } = require('./referenceDatasets');

const CONFIG = referenceStats.CONFIG;

// Les 4 tests utilisés pour les comparaisons. "higherIsBetter" est vrai pour les 4 —
// aucune inversion nécessaire dans le calcul de percentile.
const FINGER_TEST_FIELDS = [
  { key: 'mvc_kg_kg',            label: 'Max Strength',          unit: 'kg/kg',    frLabel: 'Force maximale (MVC)' },
  { key: 'intermittent_kg_s_kg', label: 'Intermittent Endurance', unit: 'kg.s/kg', frLabel: 'Endurance intermittente' },
  { key: 'continuous_kg_s_kg',   label: 'Continuous Endurance',   unit: 'kg.s/kg', frLabel: 'Endurance continue' },
  { key: 'finger_hang_s',        label: 'Finger Hang Capacity',   unit: 's',       frLabel: 'Finger Hang Capacity' }
];

// ─────────────────────────── Chargement des populations de référence ───────────────────────────
function loadReferenceData(datasetId = 'berta_2024') {
  return loadDataset(datasetId);
}

// ─────────────────────────── Sélection de l'échantillon (±2 → ±3 → ±4) ───────────────────────────
// mode: 'same_sex' (défaut) | 'global'. Signature et valeur de retour inchangées par rapport à
// l'ancienne implémentation locale — seul le calcul est désormais délégué à referenceStats.js.
function selectReferenceSample(ircraTarget, { gender, mode = 'same_sex', datasetId = 'berta_2024' } = {}) {
  const all = loadReferenceData(datasetId);
  const result = referenceStats.selectReferenceSample(all, ircraTarget, { gender, mode });
  return { ...result, datasetId };
}

// ─────────────────────────── Statistiques (déléguées à referenceStats.js) ───────────────────────────
const { quantile, computeQuantiles, percentileRank, confidenceTier } = referenceStats;

// ─────────────────────────── Vocabulaire de coaching (jamais "facteur limitant") ───────────────────────────
function bucketForPercentile(p) {
  if (p < 20) return { tier: 'very_low',  text: 'nettement en dessous des grimpeurs de niveau comparable' };
  if (p < 40) return { tier: 'low',       text: 'relativement faible comparée aux grimpeurs ayant un niveau similaire' };
  if (p < 60) return { tier: 'average',   text: 'dans la norme des grimpeurs de niveau comparable' };
  if (p < 80) return { tier: 'high',      text: 'au-dessus de la moyenne des grimpeurs de niveau comparable' };
  return { tier: 'very_high', text: 'nettement au-dessus des grimpeurs de niveau comparable' };
}

function interpretationSentence(field, percentile) {
  if (percentile === null || percentile === undefined) return '';
  const bucket = bucketForPercentile(percentile);
  const label = field.frLabel;
  let sentence = `${label} — ${bucket.text}.`;
  if (bucket.tier === 'very_low' || bucket.tier === 'low') {
    sentence += ' C\'est une qualité potentiellement intéressante à développer.';
  } else if (bucket.tier === 'very_high' || bucket.tier === 'high') {
    sentence += ' C\'est un point fort du profil actuel.';
  }
  return sentence;
}

// Phrase de synthèse : compare uniquement les qualités relativement entre elles (jamais de score global).
function synthesisSentence(perFieldResults) {
  const withPercentile = perFieldResults.filter(r => r.percentile !== null && r.percentile !== undefined);
  if (withPercentile.length < 2) return '';
  const sorted = [...withPercentile].sort((a, b) => b.percentile - a.percentile);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];
  if (best.field.key === worst.field.key) return '';
  const bestPhrase = best.percentile >= 60 ? 'supérieure à celle' : 'dans la norme haute par rapport à celle';
  return `Le profil montre une ${best.field.frLabel} ${bestPhrase} de la majorité des grimpeurs de niveau comparable, alors que l'${worst.field.frLabel} constitue la qualité relativement la plus basse du profil.`;
}

// ─────────────────────────── Rapport complet pour un test d'athlète ───────────────────────────
function buildFingerProfileReport({ ircraTarget, gender, mode = 'same_sex', datasetId = 'berta_2024', results }) {
  const { sample, window, n, mode: usedMode } = selectReferenceSample(ircraTarget, { gender, mode, datasetId });
  const confidence = confidenceTier(n);

  const fields = FINGER_TEST_FIELDS.map(field => {
    const value = results ? results[field.key] : undefined;
    const stats = computeQuantiles(sample, field.key);
    let percentile = null;
    if (value !== undefined && value !== null && stats) {
      const values = sample.map(r => r[field.key]).filter(v => v !== null && v !== undefined);
      percentile = percentileRank(value, values);
    }
    return {
      field,
      value: value ?? null,
      stats,
      percentile,
      interpretation: percentile !== null ? interpretationSentence(field, percentile) : ''
    };
  });

  return {
    ircraTarget,
    gender,
    mode: usedMode,
    datasetId,
    referenceLabel: REFERENCE_DATASETS[datasetId]?.label || datasetId,
    window,
    n,
    confidence,
    fields,
    synthesis: synthesisSentence(fields.filter(f => f.percentile !== null))
  };
}

// "Expected profile for climbing level" — distributions attendues, sans athlète.
function expectedProfileForLevel(ircraTarget, { gender, mode = 'same_sex', datasetId = 'berta_2024' } = {}) {
  const { sample, window, n, mode: usedMode } = selectReferenceSample(ircraTarget, { gender, mode, datasetId });
  const confidence = confidenceTier(n);
  const fields = FINGER_TEST_FIELDS.map(field => ({
    field,
    stats: computeQuantiles(sample, field.key)
  }));
  return { ircraTarget, gender, mode: usedMode, datasetId, referenceLabel: REFERENCE_DATASETS[datasetId]?.label || datasetId, window, n, confidence, fields };
}

module.exports = {
  CONFIG,
  FINGER_TEST_FIELDS,
  REFERENCE_DATASETS,
  loadReferenceData,
  selectReferenceSample,
  quantile,
  computeQuantiles,
  percentileRank,
  confidenceTier,
  bucketForPercentile,
  interpretationSentence,
  synthesisSentence,
  buildFingerProfileReport,
  expectedProfileForLevel
};
