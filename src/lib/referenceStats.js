// src/lib/referenceStats.js
// Moteur statistique générique de comparaison à une population de référence — extrait de
// fingerProfile.js (retour utilisateur : "ne recrée pas un deuxième moteur si celui-ci peut être
// généralisé") pour être réutilisable par n'importe quel test qui veut se comparer à un dataset
// externe (SmartBoard, réglette, futurs tests...), sans rien connaître des champs spécifiques à
// un test en particulier : il prend en entrée un tableau de lignes brutes et un nom de champ.
//
// Ce module ne décide JAMAIS si une comparaison a un sens scientifique — ça reste une décision
// humaine, explicite, posée dans src/lib/referenceMappings.js. Il calcule juste les nombres une
// fois qu'on lui a dit sur quel échantillon travailler.

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

// ─────────────────────────── Sélection de l'échantillon (±2 → ±3 → ±4) ───────────────────────────
// data: tableau brut de lignes { gender, rp_ircra, ...champs }. mode: 'same_sex' (défaut) | 'global'.
function selectReferenceSample(data, ircraTarget, { gender, mode = 'same_sex' } = {}) {
  let pool = data;
  if (mode === 'same_sex') {
    if (!gender) throw new Error('gender requis en mode same_sex');
    pool = data.filter(r => r.gender === gender);
  }
  let sample = [];
  let usedWindow = CONFIG.ircraWindowSteps[CONFIG.ircraWindowSteps.length - 1];
  for (const w of CONFIG.ircraWindowSteps) {
    sample = pool.filter(r => Math.abs(r.rp_ircra - ircraTarget) <= w);
    if (sample.length >= CONFIG.minNForWindow) { usedWindow = w; break; }
    usedWindow = w;
  }
  return { sample, window: usedWindow, n: sample.length, mode };
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

module.exports = {
  CONFIG,
  selectReferenceSample,
  quantile,
  computeQuantiles,
  percentileRank,
  confidenceTier
};
