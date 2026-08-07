// src/lib/fingerProfile.js
// Moteur de calcul du module "Finger Profile" — population normative Berta et al. 2024.
// Les données de référence (src/data/berta2024.json) sont en lecture seule, jamais modifiées ici.
// Toutes les valeurs numériques ci-dessous sont volontairement nommées et regroupées pour rester
// faciles à recalibrer (fenêtre IRCRA, seuil d'élargissement, seuils de confiance).

const fs = require('fs');
const path = require('path');

// ─────────────────────────── Configuration (facilement ajustable) ───────────────────────────
const CONFIG = {
  ircraWindowSteps: [2, 3, 4],   // élargissement progressif ±2 puis ±3 puis ±4
  minNForWindow: 25,             // seuil déclenchant l'élargissement de la fenêtre
  confidenceTiers: [
    { min: 50, tier: 'robust',    label: 'Référence robuste' },
    { min: 25, tier: 'correct',   label: 'Référence correcte' },
    { min: 10, tier: 'indicative', label: 'Référence indicative' },
    { min: 0,  tier: 'insufficient', label: 'Données insuffisantes' }
  ]
};

// Les 4 tests utilisés pour les comparaisons. "higherIsBetter" est vrai pour les 4 —
// aucune inversion nécessaire dans le calcul de percentile.
const FINGER_TEST_FIELDS = [
  { key: 'mvc_kg_kg',            label: 'Max Strength',          unit: 'kg/kg',    frLabel: 'Force maximale (MVC)' },
  { key: 'intermittent_kg_s_kg', label: 'Intermittent Endurance', unit: 'kg.s/kg', frLabel: 'Endurance intermittente' },
  { key: 'continuous_kg_s_kg',   label: 'Continuous Endurance',   unit: 'kg.s/kg', frLabel: 'Endurance continue' },
  { key: 'finger_hang_s',        label: 'Finger Hang Capacity',   unit: 's',       frLabel: 'Finger Hang Capacity' }
];

// ─────────────────────────── Chargement des populations de référence ───────────────────────────
const REFERENCE_DATASETS = {
  berta_2024: {
    id: 'berta_2024',
    label: 'Berta et al. 2024',
    file: path.join(__dirname, '..', 'data', 'berta2024.json')
  }
};

const _cache = {};
function loadReferenceData(datasetId = 'berta_2024') {
  if (_cache[datasetId]) return _cache[datasetId];
  const ds = REFERENCE_DATASETS[datasetId];
  if (!ds) throw new Error('Dataset de référence inconnu: ' + datasetId);
  const raw = fs.readFileSync(ds.file, 'utf-8');
  const data = JSON.parse(raw);
  _cache[datasetId] = data;
  return data;
}

// ─────────────────────────── Sélection de l'échantillon (±2 → ±3 → ±4) ───────────────────────────
// mode: 'same_sex' (défaut) | 'global'
function selectReferenceSample(ircraTarget, { gender, mode = 'same_sex', datasetId = 'berta_2024' } = {}) {
  const all = loadReferenceData(datasetId);
  let pool = all;
  if (mode === 'same_sex') {
    if (!gender) throw new Error('gender requis en mode same_sex');
    pool = all.filter(r => r.gender === gender);
  }
  let sample = [];
  let usedWindow = CONFIG.ircraWindowSteps[CONFIG.ircraWindowSteps.length - 1];
  for (const w of CONFIG.ircraWindowSteps) {
    sample = pool.filter(r => Math.abs(r.rp_ircra - ircraTarget) <= w);
    if (sample.length >= CONFIG.minNForWindow) { usedWindow = w; break; }
    usedWindow = w;
  }
  return { sample, window: usedWindow, n: sample.length, mode, datasetId };
}

// ─────────────────────────── Statistiques ───────────────────────────
// Quantile par interpolation linéaire (méthode standard, équivalente à numpy 'linear' / R type 7)
function quantile(sortedValues, p) {
  const n = sortedValues.length;
  if (n === 0) return null;
  if (n === 1) return sortedValues[0];
  const idx = p * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedValues[lo];
  const frac = idx - lo;
  return sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * frac;
}

function computeQuantiles(sample, field) {
  const values = sample.map(r => r[field]).filter(v => v !== null && v !== undefined).sort((a, b) => a - b);
  if (!values.length) return null;
  return {
    n: values.length,
    p10: quantile(values, 0.10),
    p25: quantile(values, 0.25),
    p50: quantile(values, 0.50),
    p75: quantile(values, 0.75),
    p90: quantile(values, 0.90),
    median: quantile(values, 0.50)
  };
}

// Rang percentile de "value" dans l'échantillon (méthode "mean rank" : compte les valeurs
// strictement inférieures + la moitié des valeurs égales, standard pour des données continues).
function percentileRank(value, sampleValues) {
  const n = sampleValues.length;
  if (!n) return null;
  let below = 0, equal = 0;
  for (const v of sampleValues) {
    if (v < value) below++;
    else if (v === value) equal++;
  }
  const rank = ((below + 0.5 * equal) / n) * 100;
  return Math.round(Math.max(0, Math.min(100, rank)));
}

function confidenceTier(n) {
  for (const t of CONFIG.confidenceTiers) {
    if (n >= t.min) return { tier: t.tier, label: t.label, n };
  }
  return { tier: 'insufficient', label: 'Données insuffisantes', n };
}

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
